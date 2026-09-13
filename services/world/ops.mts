// Work the chain owes, drained in order, one transaction in flight at a
// time. Every operator transaction comes from one serialized sender so the
// chain can never see two of them race; and a stalled RPC can never desync
// identity from the world, because the queue holds until it lands.
//
// The queue is part of the record: it is persisted in the journal so a
// restart resumes it instead of skipping a fly id and wedging every birth
// after it.

import { Chain, ProgramError, STATUS, STATUS_NAME, formatSol } from "../chain/solana.mts";
import { Engine, hash32 } from "./engine.mts";
import { JournalStore, type Op } from "./journal.mts";

const DRAIN_MS = 400;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const BALANCE_CHECK_MS = 60_000;
/// The most a single settlement can cost: a birth pays Creature rent plus the
/// Core asset's rent (about 0.003 SOL with four plugins) plus fees; a death
/// may create a Credit account.
const SETTLEMENT_FLOOR = 6_000_000n;
const GAP_FILL_MAX = 32;

export type OpQueueOpts = {
  chain: Chain;
  engine: Engine;
  store: JournalStore;
  gasReserve: bigint;
  /// origin of the fly metadata a birth writes into its NFT
  publicUrl: string;
  log: (line: string) => void;
  onEpochPosted: (epoch: number, op: Extract<Op, { op: "epoch" }>, sig: string | null) => void;
};

export class OpQueue {
  readonly ops: Op[];
  private busy = false;
  private rpcCooldownUntil = 0;
  private lastBalanceCheck = 0;
  outOfGas = false;
  /// Set once the program refuses new life (WindingDown). Births, offers and
  /// rewards can never land again, so the world stops naming them for the chain.
  windingDown = false;
  operatorBalance = 0n;
  /// When the head of the queue last moved (or the process started). A
  /// queue that has held the same op past this for long is what /api/health
  /// calls stuck; an empty queue is never stuck.
  lastProgress = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private readonly chain: Chain;
  private readonly engine: Engine;
  private readonly store: JournalStore;
  private readonly gasReserve: bigint;
  private readonly publicUrl: string;
  private readonly log: (l: string) => void;
  private readonly onEpochPosted: OpQueueOpts["onEpochPosted"];

  constructor(o: OpQueueOpts) {
    this.chain = o.chain; this.engine = o.engine; this.store = o.store;
    this.gasReserve = o.gasReserve; this.publicUrl = o.publicUrl; this.log = o.log; this.onEpochPosted = o.onEpochPosted;
    this.ops = o.store.journal.ops;
  }

  get length() { return this.ops.length; }
  get cooling() { return Date.now() < this.rpcCooldownUntil; }
  get stuckForMs() { return this.ops.length ? Date.now() - this.lastProgress : 0; }

  push(...ops: Op[]) {
    this.ops.push(...ops);
  }

  save() {
    this.store.persist();
  }

  hasBirth(uid: number) {
    return this.ops.some(o => o.op === "birth" && o.uid === uid);
  }

  /// A birth record rebuilt for an id the chain is missing. A living fly
  /// still has its real genome in a slot; one that has already died does not,
  /// and rather than invent a hash we record zero — the record is honest about
  /// being a reconstruction. The parent's generation is already on chain and
  /// authoritative, so it decides the generation.
  async rebuildBirth(id: number): Promise<Op> {
    const slot = this.engine.slotOf(id);
    const parentUid = this.store.journal.parents[id] ?? -1;
    let generation = 0;
    if (slot >= 0) generation = this.engine.generation[slot];
    else if (parentUid >= 0) {
      const parent = await this.chain.creature(parentUid);
      if (parent) generation = parent.generation + 1;
    }
    return {
      op: "birth", uid: id, parentUid, generation, tick: this.store.journal.tick,
      genomeHash: slot >= 0 ? this.engine.genomeHash(slot).toString(16).padStart(16, "0") : "0".repeat(16),
    };
  }

  /// Re-queue every id in [from, to) that is neither on chain nor queued.
  /// Returns what was re-queued; empty when the gap is too wide to fill
  /// without a human looking at it.
  async fillGap(from: number, to: number): Promise<number[]> {
    const missing: number[] = [];
    for (let id = from; id < to; id++) if (!this.hasBirth(id)) missing.push(id);
    if (!missing.length || missing.length > GAP_FILL_MAX) return [];
    for (const id of missing.slice().reverse()) this.ops.unshift(await this.rebuildBirth(id));
    this.save();
    return missing;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), DRAIN_MS);
  }

  stop() {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  private rateLimited(e: any) {
    if (!this.chain.isRateLimited(e)) return false;
    if (Date.now() > this.rpcCooldownUntil) this.log(`RPC rate limited — backing off for ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
    this.rpcCooldownUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    return true;
  }

  /// Check affordability before spending, not after failing. The world keeps
  /// simulating when the operator is broke — it is a world, not a transaction
  /// pump — but it stops trying to write. The queue holds; nothing is lost.
  private async checkBalance() {
    if (Date.now() - this.lastBalanceCheck < BALANCE_CHECK_MS) return;
    this.lastBalanceCheck = Date.now();
    try {
      const bal = await this.chain.balance(this.chain.operator.publicKey);
      this.operatorBalance = bal;
      const broke = bal < this.gasReserve + SETTLEMENT_FLOOR;
      if (broke !== this.outOfGas) {
        this.outOfGas = broke;
        this.log(broke
          ? `settlements paused — operator holds ${formatSol(bal)} SOL; keeping the ${formatSol(this.gasReserve)} SOL reserve. ` +
            `The world keeps running and holds ${this.ops.length} op(s). Fund ${this.chain.operator.publicKey.toBase58()}`
          : `funded again — ${formatSol(bal)} SOL, resuming ${this.ops.length} held operation(s)`);
      }
    } catch {
      // a failed balance read is not a reason to stop
    }
  }

  private async drain() {
    if (this.busy || this.ops.length === 0 || this.cooling) return;
    await this.checkBalance();
    if (this.outOfGas) return;
    this.busy = true;
    const op = this.ops[0];
    try {
      await this.execute(op);
      this.ops.shift();
      this.save();
    } catch (e: any) {
      if (e?.hold) return;
      if (this.rateLimited(e)) return;
      // classify reads the chain; a failed read there is a failed attempt,
      // not a reason for the process to die
      try { await this.classify(op, e); }
      catch (e2: any) { this.log(`op ${op.op} failed and could not be classified: ${String(e2?.message ?? e2).slice(0, 120)}`); }
    } finally {
      // a retired, split or gap-filled head counts as movement too
      if (this.ops[0] !== op) this.lastProgress = Date.now();
      this.busy = false;
    }
  }

  private async execute(op: Op) {
    const chain = this.chain, store = this.store;
    if (op.op === "birth") {
      const sig = await chain.registerBirth(op.uid, op.parentUid, op.generation, op.tick, hash32(BigInt("0x" + op.genomeHash)),
        `${this.publicUrl}/api/fly/${op.uid}.json`);
      store.logTx("birth", sig, true, op.uid);
      this.log(`fly ${op.uid} born on-chain (gen ${op.generation}, NFT minted)`);
    } else if (op.op === "offer") {
      const sig = await chain.openOffer(op.uid, BigInt(op.price));
      store.logTx("offer", sig, true, op.uid);
      this.log(`fly ${op.uid} offered at ${formatSol(BigInt(op.price))} SOL`);
    } else if (op.op === "death") {
      // the keeper's share is credited to whoever owns the asset now; an
      // unsold fly is the cage's own and passes no credit account
      const sig = await chain.settleDeath(op.uid, op.cause, op.tick, op.heirs);
      store.logTx("death", sig, true, op.uid);
      this.log(`death settled: fly ${op.uid} (cause ${op.cause}, ${op.heirs.length} heirs, NFT burned)`);
    } else if (op.op === "reward") {
      // A reward that was sent and not confirmed may still land: the pool
      // pays twice if it is sent again, so nothing goes out until the first
      // is confirmed or its blockhash is dead.
      if (op.sent) {
        if (await chain.signatureLanded(op.sent.sig)) {
          store.logTx("reward", op.sent.sig, true);
          this.log(`reward ${op.sent.sig.slice(0, 12)} had landed after all`);
          return;
        }
        if (!(await chain.blockhashExpired(op.sent.lastValidBlockHeight))) throw Object.assign(new Error("reward in flight"), { hold: true });
        delete op.sent;
      }
      // The amounts were worked out when the epoch was scored, against the
      // pool as it stood THEN. By now the pool may be smaller, and the program
      // requires the total to fit, so scale the payout to what the pool holds.
      const { pool } = await chain.world();
      let uids = op.uids, amounts = op.amounts.map(BigInt);
      const want = amounts.reduce((a, b) => a + b, 0n);
      if (want > pool) {
        if (pool === 0n) { this.log(`reward for ${uids.length} flies dropped — the pool is empty`); return; }
        amounts = amounts.map(a => (a * pool) / want);
        const keep = amounts.map((a, i) => [a, i] as const).filter(([a]) => a > 0n);
        uids = keep.map(([, i]) => uids[i]);
        amounts = keep.map(([a]) => a);
        this.log(`reward scaled to fit the pool: ${formatSol(want)} -> ${formatSol(amounts.reduce((a, b) => a + b, 0n))} SOL across ${uids.length} flies`);
        if (!uids.length) return;
      }
      const sig = await chain.rewardMany(uids, amounts);
      store.logTx("reward", sig, true);
    } else if (op.op === "epoch") {
      // the program takes epochs strictly in sequence and is the only thing
      // that knows how many it has accepted, so it picks the number
      const epoch = (await chain.world()).lastEpoch + 1;
      const sig = await chain.postEpoch(epoch, op.tick, hash32(BigInt("0x" + op.hash)));
      store.logTx("epoch", sig, true);
      this.onEpochPosted(epoch, op, sig);
      this.log(`epoch ${epoch} posted @${op.tick}`);
    }
  }

  /// Work that is already done, or can never be done, must not wedge the
  /// queue behind it. But a BIRTH may only be dropped once the chain actually
  /// holds it: the id is the fly's identity, and skipping one that never
  /// landed puts the world permanently ahead of the program, so every later
  /// birth is rejected and the world cannot start at all. Ask the chain rather
  /// than trusting the shape of an error string.
  private async classify(op: Op, e: any) {
    const name = e instanceof ProgramError ? e.name : this.chain.errorName(e);
    const msg = String(e?.message ?? e).slice(0, 160);
    if (name === "WindingDown" && (op.op === "birth" || op.op === "offer" || op.op === "reward")) {
      this.ops.shift(); this.save();
      if (!this.windingDown) {
        this.windingDown = true;
        this.log(`THE WORLD IS WINDING DOWN — the program refuses new life. Dropped ${op.op}${"uid" in op ? ` for fly ${op.uid}` : ""}; ` +
          `no further births, offers or rewards will be queued. Deaths and epochs still settle.`);
      } else this.log(`dropped ${op.op}${"uid" in op ? ` for fly ${op.uid}` : ""}: the world is winding down`);
      return;
    }
    if (op.op === "birth") {
      const next = await this.chain.world().then(w => w.nextId).catch(() => -1);
      if (next > op.uid) {
        this.ops.shift(); this.save();
        this.log(`birth ${op.uid} was already on chain — retired from the queue`);
      } else if (next >= 0 && next < op.uid) {
        // A GAP. The program wants an earlier id than the one at the head of
        // the queue, so this birth can never land and everything behind it
        // waits forever. Fill the gap and the queue moves again.
        const filled = await this.fillGap(next, op.uid);
        this.log(`birth ${op.uid} cannot land: the program is waiting for ${next}. ` +
          (filled.length ? `Re-queued ${filled.length} birth(s): ${filled.join(", ")}` : "The gap is too wide to fill automatically"));
      } else {
        this.log(`birth ${op.uid} has NOT landed (${name || msg}) — holding the queue rather than skipping it`);
        this.store.logTx("birth", e?.signature ?? "", false, op.uid);
      }
      return;
    }
    if (op.op === "reward") {
      if (/Transaction too large/i.test(msg)) {
        // Too many creatures for one transaction. Halve it; a single
        // creature that still does not fit can never land.
        this.ops.shift();
        if (op.uids.length > 1) {
          const h = Math.ceil(op.uids.length / 2);
          this.ops.unshift(
            { op: "reward", uids: op.uids.slice(0, h), amounts: op.amounts.slice(0, h) },
            { op: "reward", uids: op.uids.slice(h), amounts: op.amounts.slice(h) },
          );
          this.log(`reward for ${op.uids.length} flies was too large for one transaction — split into ${h} + ${op.uids.length - h}`);
        } else this.log(`reward for fly ${op.uids[0]} dropped: it does not fit in a transaction`);
        this.save();
        return;
      }
      if (typeof e?.signature === "string" && e.signature) {
        // sent, outcome unknown: remembered so the retry looks before paying
        op.sent = { sig: e.signature, lastValidBlockHeight: Number(e.lastValidBlockHeight ?? 0) };
        this.save();
      }
    }
    if (name === "InsufficientFunds") {
      this.lastBalanceCheck = 0; // force a balance check on the next pass
      this.log(`op ${op.op} could not be paid for — will retry once the operator is funded`);
      return;
    }
    if (op.op === "epoch" && name === "EpochNotMonotonic") {
      // Either the chain moved past this epoch, or THIS op landed and the
      // process died before the queue was persisted. The second case leaves
      // the record with a hole unless the commitment is written down now.
      const w = await this.chain.world();
      this.ops.shift(); this.save();
      if (w.lastEpochTick === op.tick && w.lastStateHash.slice(-16) === op.hash) {
        const sig = await this.chain.latestPostEpochSignature().catch(() => null);
        this.onEpochPosted(w.lastEpoch, op, sig);
        this.log(`epoch ${w.lastEpoch} @${op.tick} had already landed — recorded from the chain${sig ? "" : " (signature not found)"}`);
      } else this.log(`dropped an epoch sealed @${op.tick} — the chain is already past it`);
      return;
    }
    if (op.op === "death" && name === "WrongStatus") {
      // The program says the record is not in a state that can die. If the
      // chain already holds it DEAD the settlement landed (or an earlier
      // process settled it); anything else means the world and the record
      // disagree about a living fly, and dropping the op would leave the
      // record wrong forever, so the queue holds and says so.
      const c = await this.chain.creature(op.uid);
      if (c?.status === STATUS.DEAD) {
        this.ops.shift(); this.save();
        this.log(`death of fly ${op.uid} was already settled on chain — retired from the queue`);
      } else {
        this.log(`[instar] death of #${op.uid} refused with WrongStatus while the record is still alive on chain ` +
          `(status ${c ? STATUS_NAME[c.status] : "missing"}, keeper ${c?.keeper.toBase58() ?? "-"}) — holding the queue: ${msg}`);
      }
      return;
    }
    const terminal =
      (op.op === "offer" && (name === "WrongStatus" || name === "WrongId")) ||
      (op.op === "death" && name === "WrongId") ||
      (op.op === "reward" && name === "WrongStatus");
    if (terminal) {
      this.ops.shift(); this.save();
      this.log(`dropped ${op.op}${"uid" in op ? ` for fly ${op.uid}` : ""} (${name}): it can no longer land`);
      return;
    }
    this.log(`op ${op.op} failed${name ? ` (${name})` : ""}: ${msg}`);
  }
}
