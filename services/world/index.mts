// Instar — the world process.
//
//   The engine runs the Winding 2023 larval connectome for every larva,
//   paced to the wall clock at 20 ticks a second. This process hosts it,
//   journals every input so the whole history replays bit-identically,
//   posts a state hash to Solana each epoch, and settles every birth, death
//   and reward on-chain.
//
//   The engine, journal, replay and snapshot code never knows what chain it
//   is on. Everything chain-shaped goes through services/chain/solana.mts.
//
//   npm run world

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { PublicKey } from "@solana/web3.js";
import { CU, Chain, STATUS, formatSol, loadKeypair, parseSol, type Cluster, type CreatureView, type WorldView } from "../chain/solana.mts";
import { FeeClaimer, withTimeout } from "../chain/fees.mts";
import { Accounts, deriveMasterKey } from "./accounts.mts";
import { createServer, type Boot } from "./api.mts";
import { CAUSE_NAME, EVENT, Engine, NO_PARENT, hashHex, type Census } from "./engine.mts";
import { JournalStore, releaseLock, writeAtomic, type Entry, type Op } from "./journal.mts";
import { OpQueue } from "./ops.mts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data", "world"));
const SITE_DIR = path.join(ROOT, "site");
const PORT = Number(process.env.PORT ?? 8787);
const CLUSTER = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
const OPERATOR_KEYPAIR = process.env.INSTAR_OPERATOR_KEYPAIR ?? path.join(ROOT, ".keys", "operator.json");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const ADMIN_TOKEN = process.env.INSTAR_ADMIN_TOKEN ?? "";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const GAS_RESERVE = parseSol(process.env.INSTAR_GAS_RESERVE ?? "0.05");

const SEED = 0x494e535441n; // "INSTA"
const TICKRATE = 20;
const EPOCH_INTERVAL = 2400;
const BUFFER_TICKS = 100;
const START_POP = 8;
const DRAIN_CHUNK = 128;
const BASE_CAPACITY = 8;
const CAPACITY_PER_SOL = 20;
const MAX_CAPACITY = 48;
/// Reproduction needs a partner, so a population below MIN_POP can never
/// recover on its own. After this many consecutive ticks below it, founders
/// are added (spawn_founders fills free slots; survivors stay) up to START_POP.
const MIN_POP = 2;
const REGENESIS_AFTER_TICKS = 600;
/// Life rewards settle every Nth epoch. Scoring happens every epoch; paying
/// out every two minutes would cost more in fees than the payouts are worth.
const REWARD_EVERY_EPOCHS = 8;
/// Creatures per reward_many transaction. Each is a 32-byte account key; the
/// legacy transaction limit of 1232 bytes holds 23 alongside the world,
/// operator and compute-budget keys. 20 leaves room.
const REWARD_CHUNK = 20;
const POOL_PAYOUT_BPS = 2500n;
const OFFER_BASE = parseSol("0.005");
const OFFER_PER_GEN = parseSol("0.001");
const FOUNDER_PREMIUM = 2n;
const SNAP_MAGIC = "instar-snap-1";
const SWEEP_INTERVAL_MS = 10 * 60_000;
const SWEEP_POOL_BPS = 5000;
const HEARTBEAT_AFTER_S = 24 * 3600;

const log = (line: string) => console.log(`[instar] ${line}`);

type Ctx = Awaited<ReturnType<typeof buildWorld>>;
/// bound before the world is built; /api/health reports the replay from it
const boot: Boot = { ctx: null, tick: 0, target: 0 };

async function buildWorld() {
  if (!["localnet", "devnet", "mainnet-beta"].includes(CLUSTER)) throw new Error(`INSTAR_CLUSTER must be localnet|devnet|mainnet-beta, not ${CLUSTER}`);
  if (!fs.existsSync(OPERATOR_KEYPAIR)) throw new Error(`no operator keypair at ${OPERATOR_KEYPAIR} (INSTAR_OPERATOR_KEYPAIR)`);
  // Refuse before touching the chain or any file: custodial wallets must not
  // be sealed under the operator key, which is the key most likely to rotate.
  if (CLUSTER === "mainnet-beta" && !/^[0-9a-f]{64}$/i.test(process.env.INSTAR_MASTER_KEY ?? "")) {
    throw new Error("REFUSING TO START on mainnet-beta without INSTAR_MASTER_KEY (64 hex chars): custodial wallets must not be sealed under the operator key. " +
      "npm run keys:new writes one as master.key; keep it where the operator key is not.");
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ---------- engine ----------
  const census: Census = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "canonical", "droso-winding2023-larva.census.json"), "utf8"));
  const engine = await Engine.load(path.join(SITE_DIR, "instar_sim.wasm"), census);
  log(`engine: ${engine.nodeCount} neurons, ${engine.edgeCount} synapses, pop cap ${engine.maxPop}`);

  // ---------- chain ----------
  const operator = loadKeypair(OPERATOR_KEYPAIR);
  const chain = new Chain({ cluster: CLUSTER, rpc: process.env.INSTAR_RPC, programId: process.env.INSTAR_PROGRAM_ID, operator });
  log(`cluster ${CLUSTER}  program ${chain.programId.toBase58()}  world ${chain.worldPda.toBase58()}`);
  log(`rpc ${chain.rpcUrl}${process.env.INSTAR_RPC || CLUSTER === "localnet" ? "" : "  (public endpoint — set INSTAR_RPC to move off it)"}`);
  try {
    log(`operator ${operator.publicKey.toBase58()} — ${formatSol(await chain.balance(operator.publicKey))} SOL`);
  } catch {
    // a transient RPC failure must not stop the world from starting
    log(`operator ${operator.publicKey.toBase58()} — balance unavailable (RPC busy)`);
  }
  if (!(await chain.worldExists())) {
    throw new Error(`the World account ${chain.worldPda.toBase58()} does not exist on ${CLUSTER} — run npm run world:init first`);
  }

  // ---------- journal ----------
  const store = new JournalStore({
    dir: DATA_DIR, cluster: CLUSTER, programId: chain.programId.toBase58(), seed: SEED,
    tickrate: TICKRATE, epochInterval: EPOCH_INTERVAL, fresh: process.env.INSTAR_FRESH === "1", log,
  });
  const journal = store.journal;
  const SNAP_PATH = path.join(DATA_DIR, "snapshot.bin");
  boot.target = journal.tick;

  // ---------- identity (deterministic from the event stream) ----------
  // The engine numbers slots; the host names larvae. A uid is assigned to
  // every birth event in order, so the same events always produce the same
  // names, and the name is written into the engine so culls and provisions
  // can target a larva rather than a slot that may since have been reused.
  const slotUid = new Array<number>(engine.maxPop).fill(-1);
  let nextUid = 0;
  let eventSeq = 0;
  let lastEvHead = 0;
  const epochStats = { births: new Map<number, number>(), molts: new Map<number, number>(), disasterAt: -1 };

  const genomeHex = (slot: number) => hashHex(engine.genomeHash(slot));
  const offerPrice = (gen: number, founder: boolean) => (founder ? OFFER_BASE * FOUNDER_PREMIUM : OFFER_BASE + BigInt(gen) * OFFER_PER_GEN).toString();

  function drainEvents() {
    const events = engine.eventsSince(lastEvHead);
    if (!events.length) return;
    const queued: Op[] = [];
    const uids = engine.uid;
    for (const ev of events) {
      if (ev.kind === EVENT.BIRTH) {
        const slot = ev.a;
        const uid = nextUid++;
        const founder = ev.b === NO_PARENT;
        const parentUid = !founder && slotUid[ev.b] >= 0 ? slotUid[ev.b] : -1;
        slotUid[slot] = uid;
        uids[slot] = uid;
        // a replayed birth is already in the record: appending its child
        // again would list it twice among the parent's heirs
        if (parentUid >= 0 && journal.parents[uid] === undefined) {
          journal.parents[uid] = parentUid;
          (journal.children[parentUid] ??= []).push(uid);
          epochStats.births.set(parentUid, (epochStats.births.get(parentUid) ?? 0) + 1);
        }
        eventSeq++;
        if (eventSeq > journal.chainSeq) {
          journal.chainSeq = eventSeq;
          if (ops.windingDown) continue;
          const gen = engine.generation[slot];
          queued.push({ op: "birth", uid, parentUid, generation: gen, tick: ev.tick, genomeHash: genomeHex(slot) });
          queued.push({ op: "offer", uid, price: offerPrice(gen, founder) });
        }
      } else if (ev.kind === EVENT.DEATH) {
        const slot = ev.a, cause = ev.b;
        const uid = slotUid[slot];
        slotUid[slot] = -1;
        eventSeq++;
        if (uid >= 0 && eventSeq > journal.chainSeq) {
          journal.chainSeq = eventSeq;
          const heirs = [...new Set(journal.children[uid] ?? [])].filter(c => slotUid.includes(c));
          queued.push({ op: "death", uid, cause, tick: ev.tick, heirs });
          log(`larva ${uid} died: ${CAUSE_NAME[cause] ?? cause} @${ev.tick}${heirs.length ? `, ${heirs.length} heir(s)` : ""}`);
        }
      } else if (ev.kind === EVENT.MOLT) {
        const uid = slotUid[ev.a];
        if (uid >= 0) epochStats.molts.set(uid, (epochStats.molts.get(uid) ?? 0) + 1);
      } else if (ev.kind === EVENT.FLOOD || ev.kind === EVENT.DRY_SPELL) {
        epochStats.disasterAt = ev.tick;
      }
    }
    lastEvHead = engine.eventHead;
    // only touch the disk when this drain actually named something; during a
    // replay every event is already past chainSeq and nothing is queued
    if (queued.length) { ops.push(...queued); ops.save(); }
  }

  const applyEntry = (e: Entry) => {
    if (e.type === "cap") engine.setCapacity(e.value);
    else if (e.type === "cull") engine.kill(e.uid);
    else if (e.type === "gen") engine.spawnFounders(e.n);
    else if (e.type === "provision") engine.provision(e.uid);
  };

  /// One replay step: at most DRAIN_CHUNK ticks, never across a journal
  /// entry, events drained after, entries applied at exactly their tick.
  function stepChunk(t: number, target: number): number {
    let stop = Math.min(target, t + DRAIN_CHUNK);
    for (const e of journal.entries) if (e.tick > t && e.tick < stop) stop = e.tick;
    engine.step(stop - t);
    drainEvents();
    for (const e of journal.entries) if (e.tick === stop) applyEntry(e);
    return stop;
  }

  /// Step to `target`. This is THE replay rule; the mirror follows the same
  /// one, and the epoch hash is read right after it returns.
  function advanceSim(target: number) {
    let t = engine.tick;
    while (t < target) t = stepChunk(t, target);
    return t;
  }

  // ---------- ops (declared before genesis: the drain queues into it) ----------
  let lastEpoch = journal.lastEpoch;
  const ops = new OpQueue({
    chain, engine, store, gasReserve: GAS_RESERVE, publicUrl: PUBLIC_URL, log,
    onEpochPosted: (epoch, op, sig) => {
      store.recordEpoch({ epoch, tick: op.tick, hash: op.hash, sig, population: op.population, maxGen: op.maxGen });
    },
  });

  // ---------- genesis, or resume from a snapshot ----------
  if (!journal.entries.some(e => e.tick === 0 && e.type === "gen")) {
    // The founders are journal input like everything else, so a replay from
    // genesis and a mirror both spawn them the same way.
    journal.entries.unshift({ tick: 0, type: "gen", n: START_POP });
    store.persist();
  }

  function snapshotBytes(): Buffer {
    const meta = Buffer.from(JSON.stringify({
      magic: SNAP_MAGIC, cluster: CLUSTER, programId: chain.programId.toBase58(), era: journal.era, seed: journal.seed,
      tick: engine.tick, slotUid, nextUid, eventSeq, lastEvHead,
    }));
    const len = Buffer.alloc(4); len.writeUInt32LE(meta.length, 0);
    return Buffer.concat([len, meta, engine.snapshot()]);
  }
  function saveSnapshot() {
    try {
      writeAtomic(SNAP_PATH, snapshotBytes());
    } catch (e) {
      log("snapshot save failed: " + String(e).slice(0, 120));
    }
  }
  function loadSnapshot(): boolean {
    try {
      if (!fs.existsSync(SNAP_PATH)) return false;
      const raw = fs.readFileSync(SNAP_PATH);
      const metaLen = raw.readUInt32LE(0);
      const meta = JSON.parse(raw.subarray(4, 4 + metaLen).toString());
      const body = raw.subarray(4 + metaLen);
      if (meta.magic !== SNAP_MAGIC || meta.cluster !== CLUSTER || meta.programId !== chain.programId.toBase58()) return false;
      if (meta.era !== journal.era || meta.seed !== journal.seed || meta.tick > journal.tick) return false;
      if (!engine.restore(body)) return false;
      if (engine.tick !== meta.tick) return false;
      slotUid.splice(0, slotUid.length, ...meta.slotUid);
      nextUid = meta.nextUid; eventSeq = meta.eventSeq; lastEvHead = meta.lastEvHead;
      log(`resumed from snapshot @tick ${meta.tick}`);
      return true;
    } catch {
      return false;
    }
  }
  const resumed = loadSnapshot();
  if (!resumed) {
    engine.init(SEED, 0);
    for (const e of journal.entries) if (e.tick === 0) applyEntry(e);
    drainEvents();
  }
  // The boot replay is the same rule as advanceSim, chunk by chunk, but it
  // gives the event loop a turn every so often so the already-bound port can
  // answer /api/health with `replaying` and how far along it is.
  for (let t = engine.tick, n = 0; t < journal.tick; n++) {
    t = stepChunk(t, journal.tick);
    boot.tick = t;
    if (n % 32 === 0) await new Promise<void>(r => setImmediate(r));
  }
  let tick = engine.tick;
  log(`era ${journal.era} ${resumed ? "resumed" : "replayed"} to tick ${tick}, pop ${engine.popCount}, ${ops.length} op(s) queued`);

  // ---------- identity reconciliation ----------
  // The world names its larvae and the program enforces that the names are
  // sequential, so the two must agree: every id below the program's next_id
  // is registered, and every id this world has named is either registered
  // or still queued. Three ways to disagree, two of them recoverable.
  {
    const onChain = (await chain.world()).nextId;
    if (onChain > nextUid) {
      // Ids this world never named: they belong to a different (or older)
      // world, and nothing this process can do makes them its own.
      throw new Error(
        `REFUSING TO START — this world and its program disagree about identity. World has named ${nextUid} larva(e); ` +
        `program ${chain.programId.toBase58()} has registered ${onChain}. The extra ids were never named by this world: ` +
        `a fresh world needs a fresh program, or restore this program's own journal and snapshot.`
      );
    }
    // Queued births that already landed: the journal did not record the
    // success before a restart (a snapshot taken one birth behind the chain).
    const landedQueued = ops.ops.filter((o): o is Extract<Op, { op: "birth" }> => o.op === "birth" && o.uid < onChain);
    if (landedQueued.length) {
      // Their presence in our queue suggests they are ours; the genome hash
      // on chain proves it. A mismatch means another world registered that
      // id, and adopting it would put a stranger's larva in this record.
      for (const o of landedQueued) {
        const rec = await chain.creature(o.uid);
        if (!rec || rec.genomeHash.slice(-16) !== o.genomeHash) {
          throw new Error(
            `REFUSING TO START — larva ${o.uid} on program ${chain.programId.toBase58()} has genome ${rec?.genomeHash.slice(-16) ?? "(none)"}, ` +
            `this world queued ${o.genomeHash}. That id belongs to a different world.`
          );
        }
      }
      for (let i = ops.ops.length - 1; i >= 0; i--) {
        const o = ops.ops[i];
        if (o.op === "birth" && o.uid < onChain) ops.ops.splice(i, 1);
      }
      ops.save();
      log(`program was ahead by ${landedQueued.length} queued birth(s) that had already landed (${landedQueued.map(o => o.uid).join(", ")}) — retired from the queue`);
    }
    // Named births that neither landed nor wait in the queue: something
    // dropped them. Refusing to boot takes the site down over a gap the
    // world can simply re-queue.
    const missing: number[] = [];
    for (let id = onChain; id < nextUid; id++) if (!ops.hasBirth(id)) missing.push(id);
    if (missing.length) {
      const filled = await ops.fillGap(onChain, nextUid);
      if (!filled.length) throw new Error(`program has ${onChain} larvae, world has named ${nextUid}, ${missing.length} never queued — gap too wide to re-queue automatically`);
      log(`program was behind by ${filled.length} birth(s) — re-queued ${filled.join(", ")}`);
    }
    const queued = ops.ops.filter(o => o.op === "birth").length;
    log(`identity in sync — ${onChain} on chain, ${queued} queued, next is ${nextUid}`);
  }

  // ---------- custodial accounts ----------
  const masterKey = process.env.INSTAR_MASTER_KEY ? Buffer.from(process.env.INSTAR_MASTER_KEY, "hex") : deriveMasterKey(operator.secretKey);
  const accounts = new Accounts({ dir: DATA_DIR, masterKey, log });

  // ---------- chain cache ----------
  let larvae: CreatureView[] = [];
  let worldView: WorldView | null = null;
  let capacity = 0;
  let polling = false;
  const scheduled = (type: Entry["type"], uid: number) => journal.entries.some(e => e.type === type && "uid" in e && e.uid === uid);

  async function refreshChain() {
    if (polling) return;
    polling = true;
    try {
      worldView = await chain.world();
      larvae = await chain.creatures({ from: 0, to: worldView.nextId });
      const cap = Math.min(MAX_CAPACITY, BASE_CAPACITY + Math.floor(Number(worldView.metabolism) / 1e9 * CAPACITY_PER_SOL));
      if (cap !== capacity) {
        capacity = cap;
        store.addEntry({ tick: tick + BUFFER_TICKS, type: "cap", value: cap });
        log(`metabolism ${formatSol(worldView.metabolism)} SOL -> capacity ${cap}`);
      }
      let changed = false;
      for (const c of larvae) {
        if (c.status !== STATUS.OWNED || !slotUid.includes(c.id)) continue;
        // a keeper who asked for a cull gets it, deterministically, in-world
        if (c.pendingCull && !scheduled("cull", c.id)) {
          journal.entries.push({ tick: tick + BUFFER_TICKS, type: "cull", uid: c.id });
          changed = true;
        }
        // a larva that has just been bought is provisioned once: the keeper's
        // purchase feeds it, and the record shows it
        if (!c.pendingCull && !scheduled("provision", c.id)) {
          journal.entries.push({ tick: tick + BUFFER_TICKS, type: "provision", uid: c.id });
          changed = true;
        }
      }
      if (changed) store.persist();
      // The program's abandonment clock runs from the operator's last
      // transaction. Epoch posts normally keep it fresh; if they have not
      // for a day (a long RPC outage, a dropped epoch) say we are still here.
      if (Date.now() / 1000 - worldView.lastOperatorAction > HEARTBEAT_AFTER_S && ops.length === 0 && !ops.outOfGas) {
        const sig = await chain.heartbeat();
        store.logTx("heartbeat", sig, true);
        log("heartbeat sent — no operator transaction had landed for a day");
      }
    } finally {
      polling = false;
    }
  }
  setInterval(() => {
    if (ops.cooling) return;
    refreshChain().catch(e => log("chain poll: " + String(e?.message ?? e).slice(0, 120)));
  }, 4000);

  // ---------- epochs + life-performance rewards ----------
  {
    // whatever the journal says, the boundary must be ahead of where the
    // world actually is, or the clock deadlocks
    const reached = Math.floor(journal.tick / EPOCH_INTERVAL);
    if (reached > lastEpoch) {
      log(`epoch clock behind the world (${lastEpoch} vs tick ${journal.tick}) — advancing to ${reached}`);
      lastEpoch = reached;
    }
  }

  /// Seal the world at an epoch boundary. The hash must be read at the
  /// boundary tick, so it is captured here and handed to the queue — the
  /// chain call is what gets deferred, never the measurement.
  function sealEpoch(epoch: number, atTick: number) {
    ops.push({ op: "epoch", tick: atTick, hash: hashHex(engine.stateHash()), population: engine.popCount, maxGen: engine.maxGeneration });
    journal.lastEpoch = epoch;
    ops.save();
  }

  /// A larva's worth grows from living a full life, not from being traded.
  /// Scored every epoch; settled every REWARD_EVERY_EPOCHS.
  function creditLifePerformance(epoch: number) {
    if (epoch <= journal.lastCreditEpoch || epoch % REWARD_EVERY_EPOCHS !== 0) return;
    journal.lastCreditEpoch = epoch;
    const alive = engine.alive, energy = engine.energy, age = engine.age, gen = engine.generation, eaten = engine.eaten;
    const points = new Map<number, number>();
    for (let s = 0; s < engine.maxPop; s++) {
      if (!alive[s] || slotUid[s] < 0) continue;
      const uid = slotUid[s];
      let p = 2;                                                       // survival
      const delta = Math.max(0, eaten[s] - (journal.eatenBase[uid] ?? 0));
      journal.eatenBase[uid] = eaten[s];
      p += Math.floor(delta / 3_000);                                  // foraging
      // the engine caps energy at 60,000; satiety is 30,000 and breeding needs 45,000
      if (energy[s] > 30_000) p += 1;
      if (energy[s] > 45_000) p += 1;
      if (energy[s] > 55_000) p += 1;                                  // vitality
      p += Math.min(8, Math.floor(age[s] / 15_000));                   // longevity
      p += (epochStats.molts.get(uid) ?? 0) * 3;                       // development
      p += (epochStats.births.get(uid) ?? 0) * 6;                      // fecundity
      p += Math.min(5, gen[s]);                                        // lineage
      if (epochStats.disasterAt >= tick - EPOCH_INTERVAL * REWARD_EVERY_EPOCHS) p += 4; // resilience
      points.set(uid, p);
    }
    for (const k of Object.keys(journal.eatenBase)) if (!slotUid.includes(Number(k))) delete journal.eatenBase[k];
    epochStats.births.clear(); epochStats.molts.clear();
    const total = [...points.values()].reduce((a, b) => a + b, 0);
    const budget = ((worldView?.pool ?? 0n) * POOL_PAYOUT_BPS) / 10_000n;
    if (total === 0 || budget === 0n) return;
    const uids: number[] = [], amounts: string[] = [];
    for (const [uid, p] of points) {
      const amount = (budget * BigInt(p)) / BigInt(total);
      if (amount > 0n && (journal.creditedEpoch[uid] ?? 0) < epoch) {
        journal.creditedEpoch[uid] = epoch;
        uids.push(uid); amounts.push(amount.toString());
      }
    }
    for (const k of Object.keys(journal.creditedEpoch)) if (!slotUid.includes(Number(k))) delete journal.creditedEpoch[k];
    if (!uids.length || ops.windingDown) return;
    for (let i = 0; i < uids.length; i += REWARD_CHUNK) {
      ops.push({ op: "reward", uids: uids.slice(i, i + REWARD_CHUNK), amounts: amounts.slice(i, i + REWARD_CHUNK) });
    }
    ops.save();
    log(`epoch ${epoch}: ${formatSol(budget)} SOL of life rewards to ${uids.length} larvae in ${Math.ceil(uids.length / REWARD_CHUNK)} transaction(s)`);
  }

  // ---------- the world clock ----------
  let acc = 0, lastWall = Date.now(), lowSince = -1;
  setInterval(() => {
    const now = Date.now();
    acc += ((now - lastWall) / 1000) * TICKRATE;
    lastWall = now;
    const budget = Math.floor(acc);
    acc -= budget;
    if (budget <= 0) return;
    const boundary = (lastEpoch + 1) * EPOCH_INTERVAL;
    // Seal exactly at the boundary tick: whatever of this budget lies past
    // it is carried, not dropped, or every late interval that straddles a
    // boundary would leave the world a little further behind the clock.
    const target = Math.min(tick + budget, boundary);
    acc += tick + budget - target;
    try {
      tick = advanceSim(target);
    } catch (e) {
      store.persist();
      console.error("[instar] FATAL:", e);
      process.exit(1);
    }
    if (tick >= boundary) {
      lastEpoch += 1;
      creditLifePerformance(lastEpoch);
      sealEpoch(lastEpoch, tick);
    }
    const pop = engine.popCount;
    if (pop < MIN_POP) {
      if (lowSince < 0) lowSince = tick;
      const pending = journal.entries.some(e => e.type === "gen" && e.tick > tick);
      if (!pending && tick - lowSince > REGENESIS_AFTER_TICKS) {
        store.addEntry({ tick: tick + BUFFER_TICKS, type: "gen", n: START_POP - pop });
        log(`population ${pop} — re-genesis scheduled: ${START_POP - pop} founder(s) join at tick ${tick + BUFFER_TICKS}`);
      }
    } else lowSince = -1;
    journal.tick = tick;
  }, 50);

  // ---------- fee income, fed into the world ----------
  // With INSTAR_COIN_MINT set, the coin's creator-fee vaults are claimed into
  // the fee keypair first; the sweep then moves everything above rent and
  // the gas reserve into the world. A failed claim leaves the sweep to run
  // on whatever is already there and is retried next interval.
  if (process.env.INSTAR_FEE_KEYPAIR) {
    const fee = loadKeypair(process.env.INSTAR_FEE_KEYPAIR);
    const claimer = process.env.INSTAR_COIN_MINT
      ? new FeeClaimer({ chain, mint: new PublicKey(process.env.INSTAR_COIN_MINT), fee, log })
      : null;
    log(`fee keypair ${fee.publicKey.toBase58()} — ${claimer ? `claiming $INSTAR (${claimer.mint.toBase58()}) creator fees and ` : ""}sweeping every ${SWEEP_INTERVAL_MS / 60000} min`);
    let sweeping: number | null = null;
    const sweep = async () => {
      if (sweeping !== null) { log(`fee sweep: the pass started ${Math.round((Date.now() - sweeping) / 1000)}s ago is still running, skipping this interval`); return; }
      if (ops.cooling) return;
      sweeping = Date.now();
      try {
        if (claimer) {
          try {
            // a null signature means the vault was drained by someone else's
            // crank before ours landed: the money arrived, but no transaction
            // of ours to record
            for (const r of await claimer.claim()) if (r.signature) store.logTx("claim-fees", r.signature, true);
          } catch (e: any) {
            log("fee claim: " + String(e?.message ?? e).slice(0, 200));
          }
        }
        const [bal, rent] = await withTimeout(Promise.all([chain.balance(fee.publicKey), chain.rentExempt(0)]), "fee keypair balance");
        // fund() runs under CU.IX; its fee comes out of the same wallet
        const spare = bal - rent - GAS_RESERVE - chain.fee(CU.IX);
        if (spare <= 0n) return;
        const sig = await chain.fund(spare, SWEEP_POOL_BPS, fee);
        store.logTx("fees", sig, true);
        log(`swept ${formatSol(spare)} SOL of fee income into the world`);
      } catch (e: any) {
        log("fee sweep: " + String(e?.message ?? e).slice(0, 140));
      } finally {
        store.persist();
        sweeping = null;
      }
    };
    setTimeout(sweep, 20_000);
    setInterval(sweep, SWEEP_INTERVAL_MS);
  }

  setInterval(() => store.persist(), 5000);
  // The snapshot carries nextUid and the journal carries the op queue, so a
  // restart between the two writes finds them disagreeing about how many
  // larvae have been named. Writing the journal right after the snapshot
  // keeps the pair consistent to within a moment rather than a minute.
  setInterval(() => { saveSnapshot(); store.persist(); }, 60_000);

  ops.start();
  await refreshChain().catch(e => log("initial chain read: " + String(e?.message ?? e).slice(0, 120)));

  return {
    cluster: CLUSTER, googleClientId: GOOGLE_CLIENT_ID, publicUrl: PUBLIC_URL,
    corsOrigin: process.env.INSTAR_CORS_ORIGIN ?? "", siteDir: SITE_DIR, rootDir: ROOT, dataDir: DATA_DIR, adminToken: ADMIN_TOKEN,
    chain, store, engine, accounts, ops, log, bufferTicks: BUFFER_TICKS,
    tick: () => tick, capacity: () => capacity, lastEpoch: () => lastEpoch,
    // the clock's anchor: /api/health measures drift from here
    startedAt: { wall: Date.now(), tick },
    larvae: () => larvae, world: () => worldView, refreshChain,
    snapshotMeta: () => ({ tick: engine.tick, eventHead: lastEvHead, nextUid, slotUid }),
    snapshotBytes,
    engineLarva: (id: number) => {
      const s = engine.slotOf(id);
      return s < 0 ? null : { generation: engine.generation[s], lineage: engine.lineage[s], genomeHash: genomeHex(s) };
    },
    shutdown: () => { store.persist(); saveSnapshot(); store.releaseLock(); },
  };
}

async function main() {
  let ctx: Ctx | null = null;
  // A promise nobody awaited that rejects would end the process with the
  // journal up to 5 s stale and no snapshot. Save the record first, and
  // exit non-zero so the supervisor restarts it.
  process.on("unhandledRejection", e => {
    console.error("[instar] FATAL unhandled rejection:", e);
    try { ctx?.shutdown(); } catch (e2) { console.error("[instar] could not save on the way out:", e2); }
    process.exit(1);
  });
  // The port first: a replay from genesis takes minutes, and a supervisor
  // that sees a refused connection for that long restarts a healthy boot.
  // Until the world is built every route answers 503 `replaying`.
  const server = createServer(boot);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(PORT, resolve); });
  log(`listening on :${PORT} — building the world`);
  const shutdown = () => {
    if (ctx) { ctx.shutdown(); log("journal + snapshot saved"); } else releaseLock(DATA_DIR);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  ctx = await buildWorld();
  boot.ctx = ctx;
  log(`world live on :${PORT} — tick ${ctx.tick()}`);
}

main().catch(e => { console.error("[instar]", e?.message ?? e); releaseLock(DATA_DIR); process.exit(1); });
