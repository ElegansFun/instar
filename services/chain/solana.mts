// The only module that touches Solana.
//
// The world engine, journal, snapshots and replay never import a chain
// library; everything chain-shaped goes through this class so the world stays
// portable and every transaction goes out with the same care: a priority fee,
// confirmation against the blockhash it was signed with, and an idempotent
// retry that re-reads state before resending, because an expired blockhash
// says nothing about whether the transaction landed.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram,
  LAMPORTS_PER_SOL, TransactionExpiredBlockheightExceededError, SendTransactionError, type AccountInfo,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet, utils, type Idl } from "@coral-xyz/anchor";
import { deserializeAssetV1 } from "@metaplex-foundation/mpl-core";
import { publicKey as umiKey, lamports as umiLamports } from "@metaplex-foundation/umi";
import type { Instar } from "./idl/instar.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDL_PATH = path.join(__dirname, "idl", "instar.json");

export type Cluster = "localnet" | "devnet" | "mainnet-beta";

export const PUBLIC_RPC: Record<Cluster, string> = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

/// Metaplex Core: every fly is an Asset in the world's Collection, and the
/// asset's owner is the only record of who keeps it.
export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

export const STATUS = { NONE: 0, OFFERED: 1, OWNED: 2, WILD: 3, DEAD: 4 } as const;
export const STATUS_NAME: Record<number, string> = { 0: "none", 1: "offered", 2: "owned", 3: "wild", 4: "dead" };
export const NO_PARENT_ID = 2n ** 64n - 1n;
/// withdraw_treasury sentinel: take the whole pot
export const TAKE_ALL = 2n ** 64n - 1n;
export const SIGNATURE_FEE = 5000n;
/// Compute-unit limits, from `simulateTransaction` of each instruction
/// against the deployed program on localnet (2026-09): heartbeat and
/// post_epoch 4k, fund 6.6k, reward_many 7.6k + 3k per creature, a system
/// transfer 150 (450 with the two compute-budget instructions). The Core
/// CPIs dominate the rest, measured from confirmed transactions on a scratch
/// validator: register_birth (CreateV2 with four plugins) 55k, buy 28k and
/// buy_listed 32k (TransferV1), request_cull (freeze) 27k, settle_death
/// (BurnV1) 40k with one heir, init_world (CreateCollectionV2) 20k, a plain
/// Core transfer 9k. Each limit is at least 3x its measurement; the priority
/// fee is priced on the limit, so a tight one is what keeps a "max"
/// withdrawal exact.
export const CU = {
  TRANSFER: 1_000,
  IX: 50_000,
  CORE: 200_000,
  REWARD_BASE: 25_000, REWARD_PER: 5_000,
  DEATH_BASE: 150_000, DEATH_PER: 5_000,
  /// close_record 6.6k and close_credit 6.3k each, measured in batches on
  /// the scratch validator; close_world 3.3k runs under IX
  CLOSE_PER: 20_000,
} as const;
/// close_record / close_credit instructions per transaction: three accounts
/// each, two of them shared, so twenty fit a legacy transaction with room.
export const CLOSE_BATCH = 20;

const SCALAR_SIZE: Record<string, number> = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, pubkey: 32 };
function idlTypeSize(t: any): number {
  if (typeof t === "string") {
    if (!(t in SCALAR_SIZE)) throw new Error(`IDL type ${t} has no fixed size`);
    return SCALAR_SIZE[t];
  }
  if (t && Array.isArray(t.array)) return idlTypeSize(t.array[0]) * t.array[1];
  throw new Error(`IDL type ${JSON.stringify(t)} has no fixed size`);
}

export type FieldSpan = { offset: number; size: number };
/// Where a mirror finds the epoch commitment in the raw World account: an
/// 8-byte Anchor discriminator, then the fields in IDL order.
export type WorldLayout = { account: string; lastEpoch: FieldSpan; lastEpochTick: FieldSpan; lastStateHash: FieldSpan };

export type WorldView = {
  operator: PublicKey; pendingOperator: PublicKey; recovery: PublicKey; collection: PublicKey;
  nextId: number; totalAlive: number; lastEpoch: number; lastEpochTick: number; lastStateHash: string;
  metabolism: bigint; pool: bigint; totalVaults: bigint; totalCredit: bigint;
  lastOperatorAction: number; windDown: boolean; windDownAt: number;
  /// after escheat the records may be closed for their rent; the two counters
  /// say how far that has gone (close_world needs every record and credit gone)
  escheated: boolean; closedRecords: number; creditsOpen: number;
  lamports: bigint;
};

/// The Core asset as the chain holds it. `collection` is null only for an
/// asset that is not in one, which no fly ever is.
export type AssetView = {
  address: PublicKey; owner: PublicKey; collection: PublicKey | null; name: string; uri: string;
  frozen: boolean; attributes: Record<string, string>;
};

/// A Creature record joined with its asset: `keeper` is the asset's owner
/// (the World PDA while the cage holds it, PublicKey.default once burned —
/// by the program at death, or natively by its owner while it still lived).
/// `listedAt` is the unix time of the current listing, 0 when unlisted.
export type CreatureView = {
  id: number; parentId: number; generation: number; birthTick: number; deathTick: number; genomeHash: string;
  asset: PublicKey; keeper: PublicKey; listedBy: PublicKey; listedAt: number;
  vault: bigint; salePrice: bigint; status: number; pendingCull: boolean; cullRequestedAt: number;
};

export type ChainOpts = {
  cluster: Cluster;
  rpc?: string;
  programId?: string;
  operator: Keypair;
  /// microlamports per compute unit
  priorityFee?: number;
};

export function loadIdl(): Idl & { address: string } {
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(`no IDL at ${IDL_PATH} — run npm run program:build (it copies the IDL there)`);
  }
  return JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
}

export function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

export function formatSol(lamports: bigint | number): string {
  const l = BigInt(lamports);
  const whole = l / BigInt(LAMPORTS_PER_SOL), frac = l % BigInt(LAMPORTS_PER_SOL);
  return `${whole}.${frac.toString().padStart(9, "0").replace(/0+$/, "").padEnd(1, "0")}`;
}

export function parseSol(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a SOL amount: ${s}`);
  return BigInt(m[1]) * BigInt(LAMPORTS_PER_SOL) + BigInt((m[2] ?? "").padEnd(9, "0"));
}

/// A transaction the program rejected, with the error name the IDL gives it.
export class ProgramError extends Error {
  constructor(readonly name: string, readonly logs: string[], message: string) {
    super(message);
  }
}

const bn = (v: bigint | number) => new BN(v.toString());
const big = (v: BN) => BigInt(v.toString());
const num = (v: BN) => Number(v.toString());
const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");

/// Core `TransferV1` by the asset's owner: discriminator 14, no compression
/// proof. Core's optional accounts are passed as the Core program id when
/// absent (its SDK's convention), so `authority` is the program id and the
/// payer signs as owner. The collection must be passed for an asset in one.
function coreTransfer(asset: PublicKey, collection: PublicKey, owner: PublicKey, to: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: to, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([14, 0]),
  });
}

/// Core `BurnV1` by the asset's owner: discriminator 12, no compression
/// proof. Core approves the owner's own burn on an unfrozen asset and leaves
/// a one-byte `Uninitialized` stub behind; the service never offers this,
/// but a keeper can do it from any wallet, so the settle path is tested
/// against it.
function coreBurn(asset: PublicKey, collection: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([12, 0]),
  });
}

export class Chain {
  readonly cluster: Cluster;
  readonly rpcUrl: string;
  /// The endpoint without its query string: provider keys ride there, and
  /// this is what logs and CLIs print.
  get rpcShown(): string { return this.rpcUrl.replace(/\?.*$/, "?…"); }
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly program: Program<Instar>;
  readonly operator: Keypair;
  readonly worldPda: PublicKey;
  readonly priorityFee: number;
  readonly worldLayout: WorldLayout;
  private readonly errorNames = new Map<number, string>();
  private readonly accountDiscriminator = new Map<string, Buffer>();
  /// Records that can never change again. Every path that sets DEAD is final,
  /// so once observed dead a creature is not fetched twice.
  private readonly dead = new Map<number, CreatureView>();
  private collectionKey: PublicKey | null = null;

  constructor(opts: ChainOpts) {
    const idl = loadIdl();
    this.cluster = opts.cluster;
    this.rpcUrl = opts.rpc || PUBLIC_RPC[opts.cluster];
    this.connection = new Connection(this.rpcUrl, { commitment: "confirmed" });
    this.programId = new PublicKey(opts.programId || idl.address);
    this.operator = opts.operator;
    this.priorityFee = opts.priorityFee ?? (opts.cluster === "localnet" ? 0 : 5000);
    const provider = new AnchorProvider(this.connection, new Wallet(opts.operator), { commitment: "confirmed" });
    this.program = new Program<Instar>({ ...idl, address: this.programId.toBase58() } as Instar, provider);
    for (const e of idl.errors ?? []) this.errorNames.set(e.code, e.name);
    for (const a of idl.accounts ?? []) this.accountDiscriminator.set(a.name, Buffer.from(a.discriminator));
    this.worldPda = PublicKey.findProgramAddressSync([Buffer.from("world")], this.programId)[0];
    const world = (idl.types ?? []).find(t => t.name === "World");
    if (!world || world.type.kind !== "struct" || !world.type.fields) throw new Error("IDL has no World struct");
    const spans: Record<string, FieldSpan> = {};
    let offset = 8; // Anchor discriminator
    for (const f of world.type.fields) {
      if (typeof f !== "object" || !("name" in f)) throw new Error("IDL World is a tuple struct");
      const size = idlTypeSize(f.type);
      spans[f.name] = { offset, size };
      offset += size;
    }
    for (const f of ["last_epoch", "last_epoch_tick", "last_state_hash"]) if (!spans[f]) throw new Error(`IDL World has no ${f}`);
    this.worldLayout = {
      account: this.worldPda.toBase58(),
      lastEpoch: spans.last_epoch, lastEpochTick: spans.last_epoch_tick, lastStateHash: spans.last_state_hash,
    };
  }

  // ---- addresses --------------------------------------------------------------

  creaturePda(id: number | bigint): PublicKey {
    const seed = Buffer.alloc(8);
    seed.writeBigUInt64LE(BigInt(id));
    return PublicKey.findProgramAddressSync([Buffer.from("creature"), seed], this.programId)[0];
  }

  creditPda(owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("credit"), owner.toBuffer()], this.programId)[0];
  }

  /// Solana Explorer wants `?cluster=` for devnet and a custom RPC for
  /// localnet; on mainnet the parameter is omitted. The custom RPC is the
  /// cluster's PUBLIC endpoint, never the configured one: this string is
  /// served to every visitor and INSTAR_RPC may carry a provider key.
  get explorerQuery(): string {
    if (this.cluster === "mainnet-beta") return "";
    if (this.cluster === "devnet") return "?cluster=devnet";
    return "?cluster=custom&customUrl=" + encodeURIComponent(PUBLIC_RPC[this.cluster]);
  }
  explorerTx(sig: string) { return `https://explorer.solana.com/tx/${sig}${this.explorerQuery}`; }

  // ---- reads ------------------------------------------------------------------

  async world(): Promise<WorldView> {
    const [w, lamports] = await Promise.all([
      this.program.account.world.fetch(this.worldPda),
      this.connection.getBalance(this.worldPda),
    ]);
    this.collectionKey = w.collection;
    return {
      operator: w.operator, pendingOperator: w.pendingOperator, recovery: w.recovery, collection: w.collection,
      nextId: num(w.nextId), totalAlive: num(w.totalAlive), lastEpoch: num(w.lastEpoch), lastEpochTick: num(w.lastEpochTick),
      lastStateHash: hex(w.lastStateHash), metabolism: big(w.metabolism), pool: big(w.pool),
      totalVaults: big(w.totalVaults), totalCredit: big(w.totalCredit),
      lastOperatorAction: num(w.lastOperatorAction), windDown: w.windDown, windDownAt: num(w.windDownAt),
      escheated: w.escheated, closedRecords: num(w.closedRecords), creditsOpen: num(w.creditsOpen),
      lamports: BigInt(lamports),
    };
  }

  async worldExists(): Promise<boolean> {
    return (await this.connection.getAccountInfo(this.worldPda)) !== null;
  }

  /// The world's Collection address. Fixed at init_world, so it is read once.
  async collection(): Promise<PublicKey> {
    if (!this.collectionKey) await this.world();
    return this.collectionKey!;
  }

  /// Decode a Core asset account with the Metaplex SDK's own deserializer:
  /// the base (owner, update authority, name, uri) and the plugin registry
  /// behind it (frozen flag, attributes). Null for a burned asset: Core's
  /// BurnV1 does not close the account, it shrinks it to a single
  /// `Key::Uninitialized` byte and refunds the rent, so a burned fly's
  /// address still answers, with nothing in it.
  static decodeAsset(address: PublicKey, info: AccountInfo<Buffer>): AssetView | null {
    if (!info.owner.equals(MPL_CORE)) throw new Error(`${address.toBase58()} is not a Core asset (owner ${info.owner.toBase58()})`);
    if (info.data.length === 0 || info.data[0] === 0) return null;
    const a = deserializeAssetV1({
      publicKey: umiKey(address.toBase58()), owner: umiKey(MPL_CORE.toBase58()), executable: false,
      lamports: umiLamports(info.lamports), rentEpoch: BigInt(info.rentEpoch ?? 0), data: new Uint8Array(info.data),
    });
    const attributes: Record<string, string> = {};
    for (const { key, value } of a.attributes?.attributeList ?? []) attributes[key] = value;
    return {
      address, owner: new PublicKey(a.owner),
      collection: a.updateAuthority.type === "Collection" && a.updateAuthority.address ? new PublicKey(a.updateAuthority.address) : null,
      name: a.name, uri: a.uri, frozen: a.permanentFreezeDelegate?.frozen ?? false, attributes,
    };
  }

  /// Null once the asset is burned (every death burns it).
  async asset(address: PublicKey): Promise<AssetView | null> {
    const info = await this.connection.getAccountInfo(address);
    return info ? Chain.decodeAsset(address, info) : null;
  }

  private view(c: any, keeper: PublicKey): CreatureView {
    return {
      id: num(c.id), parentId: big(c.parentId) === NO_PARENT_ID ? -1 : num(c.parentId),
      generation: c.generation, birthTick: num(c.birthTick), deathTick: num(c.deathTick), genomeHash: hex(c.genomeHash),
      asset: c.asset, keeper, listedBy: c.listedBy, listedAt: num(c.listedAt), vault: big(c.vault), salePrice: big(c.salePrice),
      status: c.status, pendingCull: c.pendingCull, cullRequestedAt: num(c.cullRequestedAt),
    };
  }

  async creature(id: number): Promise<CreatureView | null> {
    const frozen = this.dead.get(id);
    if (frozen) return frozen;
    const c = await this.program.account.creature.fetchNullable(this.creaturePda(id));
    if (!c) return null;
    if (c.status === STATUS.DEAD) {
      const v = this.view(c, PublicKey.default);
      this.dead.set(id, v);
      return v;
    }
    const asset = await this.asset(c.asset);
    return this.view(c, asset?.owner ?? PublicKey.default);
  }

  /// Every creature in [from, to), in id order, each joined with its asset's
  /// owner. Missing ids (never born) are skipped. Dead records come from the
  /// cache so the sweep costs the living population, not every fly that
  /// has ever existed.
  async creatures(range: { from: number; to: number }): Promise<CreatureView[]> {
    const out: CreatureView[] = [];
    const need: number[] = [];
    for (let id = range.from; id < range.to; id++) {
      const frozen = this.dead.get(id);
      if (frozen) out.push(frozen); else need.push(id);
    }
    const CHUNK = 100; // getMultipleAccounts limit
    const living: any[] = [];
    for (let i = 0; i < need.length; i += CHUNK) {
      const ids = need.slice(i, i + CHUNK);
      const batch = await this.program.account.creature.fetchMultiple(ids.map(id => this.creaturePda(id)));
      for (const c of batch) {
        if (!c) continue;
        if (c.status === STATUS.DEAD) {
          const v = this.view(c, PublicKey.default);
          this.dead.set(v.id, v);
          out.push(v);
        } else living.push(c);
      }
    }
    for (let i = 0; i < living.length; i += CHUNK) {
      const cs = living.slice(i, i + CHUNK);
      const infos = await this.connection.getMultipleAccountsInfo(cs.map(c => c.asset));
      cs.forEach((c, j) => {
        const info = infos[j];
        out.push(this.view(c, (info && Chain.decodeAsset(c.asset, info))?.owner ?? PublicKey.default));
      });
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  async balance(who: PublicKey): Promise<bigint> {
    return BigInt(await this.connection.getBalance(who));
  }

  async creditOf(owner: PublicKey): Promise<bigint> {
    const c = await this.program.account.credit.fetchNullable(this.creditPda(owner));
    return c ? big(c.amount) : 0n;
  }

  async rentExempt(space = 0): Promise<bigint> {
    return BigInt(await this.connection.getMinimumBalanceForRentExemption(space));
  }

  async signatureLanded(sig: string): Promise<boolean> {
    const st = await this.connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = st.value[0];
    return !!s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
  }

  // ---- sending ----------------------------------------------------------------

  errorName(e: any): string {
    const msg = String(e?.message ?? e);
    const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
    const text = msg + "\n" + logs.join("\n");
    const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text);
    if (custom) return this.errorNames.get(parseInt(custom[1], 16)) ?? `0x${custom[1]}`;
    const named = /Error Code: (\w+)/.exec(text);
    if (named) return named[1];
    const anchor = /Error Number: (\d+)/.exec(text);
    if (anchor) return this.errorNames.get(Number(anchor[1])) ?? anchor[1];
    if (/insufficient (lamports|funds)/i.test(text)) return "InsufficientFunds";
    return "";
  }

  isRateLimited(e: any): boolean {
    const msg = String(e?.message ?? e);
    return /429|rate limit|Too Many Requests/i.test(msg);
  }

  fee(units: number): bigint {
    return SIGNATURE_FEE + BigInt(Math.ceil((this.priorityFee * units) / 1e6));
  }

  private async sendOnce(ixs: TransactionInstruction[], signers: Keypair[], units: number): Promise<string> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    if (this.priorityFee > 0) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFee }));
    for (const ix of ixs) tx.add(ix);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    let sig: string;
    try {
      sig = await this.connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } catch (e: any) {
      const logs: string[] = e instanceof SendTransactionError ? (await e.getLogs(this.connection).catch(() => [])) ?? [] : [];
      const name = this.errorName({ message: e?.message, logs });
      throw new ProgramError(name, logs, name ? `${name}: ${String(e?.message).slice(0, 200)}` : String(e?.message ?? e));
    }
    let res;
    try {
      res = await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    } catch (e: any) {
      // The transaction is out. Whatever broke confirmation (expiry carries
      // the signature already; a dropped socket or RPC timeout does not),
      // the caller must be able to look it up before sending another.
      if (e && typeof e === "object") { e.signature ??= sig; e.lastValidBlockHeight ??= lastValidBlockHeight; }
      throw e;
    }
    if (res.value.err) {
      const t = await this.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      const logs = t?.meta?.logMessages ?? [];
      const name = this.errorName({ message: JSON.stringify(res.value.err), logs });
      throw new ProgramError(name, logs, `${name || "transaction failed"} (${sig})`);
    }
    return sig;
  }

  /// Send, and if anything fails after the transaction left this process,
  /// look before sending again: first at the signature itself, then at
  /// `landed()`, which reads the state the transaction was meant to produce.
  /// Only a transaction that provably did not land is resent, and only an
  /// expired one is resent here: any other post-send failure leaves the
  /// outcome unknown, so the error goes out carrying the signature and the
  /// block height it dies at, for the caller to settle before retrying.
  async send(ixs: TransactionInstruction[], signers: Keypair[], landed?: () => Promise<boolean>, units: number = CU.IX): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce(ixs, signers, units);
      } catch (e: any) {
        // no signature: it never left; a ProgramError: the chain ran it and
        // said no. Both are final.
        const sig: string = typeof e?.signature === "string" ? e.signature : "";
        if (!sig || e instanceof ProgramError) throw e;
        if (await this.signatureLanded(sig)) return sig;
        if (landed && await landed()) return sig;
        if (!(e instanceof TransactionExpiredBlockheightExceededError)) {
          throw Object.assign(new Error(`transaction ${sig} was sent but not confirmed: ${String(e?.message ?? e).slice(0, 120)}`),
            { signature: sig, lastValidBlockHeight: Number(e.lastValidBlockHeight ?? 0) });
        }
        if (attempt >= 2) {
          throw Object.assign(new Error(`transaction expired ${attempt + 1} times without landing (${sig})`), { signature: sig, lastValidBlockHeight: 0 });
        }
      }
    }
  }

  /// True once no transaction signed against a blockhash valid through
  /// `lastValidBlockHeight` can still land.
  async blockhashExpired(lastValidBlockHeight: number): Promise<boolean> {
    return (await this.connection.getBlockHeight("confirmed")) > lastValidBlockHeight;
  }

  /// The signature of the most recent successful post_epoch on the World,
  /// or null if none is among its last few transactions.
  async latestPostEpochSignature(): Promise<string | null> {
    const recent = await this.connection.getSignaturesForAddress(this.worldPda, { limit: 10 }, "confirmed");
    const txs = await this.connection.getTransactions(recent.map(r => r.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (let i = 0; i < txs.length; i++) {
      const t = txs[i];
      if (t && !t.meta?.err && (t.meta?.logMessages ?? []).some(l => l.includes("Instruction: PostEpoch"))) return recent[i].signature;
    }
    return null;
  }

  // ---- operator instructions ------------------------------------------------

  private get op() { return this.operator; }

  /// Only the program's upgrade authority may create the World, so the
  /// program-data account is passed for the program to check the authority.
  programDataPda(): PublicKey {
    const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    return PublicKey.findProgramAddressSync([this.programId.toBuffer()], LOADER)[0];
  }

  /// Creates the World and its Collection. Core needs a fresh signer for a
  /// new collection address, so one is generated here and thrown away: the
  /// World PDA is the collection's authority, the keypair is never used again.
  async initWorld(recovery: PublicKey, collectionUri: string): Promise<string> {
    const collection = Keypair.generate();
    const ix = await this.program.methods.initWorld(recovery, collectionUri)
      .accountsPartial({
        world: this.worldPda, operator: this.op.publicKey, collection: collection.publicKey,
        program: this.programId, programData: this.programDataPda(),
        mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sig = await this.send([ix], [this.op, collection], () => this.worldExists(), CU.CORE);
    this.collectionKey = collection.publicKey;
    return sig;
  }

  /// Operator draw on the treasuries. `"all"` empties a pot; 0 leaves it alone.
  async withdrawTreasury(to: PublicKey, metabolism: bigint | "all", pool: bigint | "all"): Promise<string> {
    const amt = (v: bigint | "all") => bn(v === "all" ? TAKE_ALL : v);
    const ix = await this.program.methods.withdrawTreasury(amt(metabolism), amt(pool))
      .accountsPartial({ world: this.worldPda, operator: this.op.publicKey, to })
      .instruction();
    return this.send([ix], [this.op]);
  }

  async heartbeat(): Promise<string> {
    const ix = await this.program.methods.heartbeat()
      .accountsPartial({ world: this.worldPda, operator: this.op.publicKey }).instruction();
    return this.send([ix], [this.op]);
  }

  /// A birth in the engine. `id` must be the world's next id or the program
  /// rejects it (WrongId), so the world and the chain can never disagree
  /// about identity. `parentId` of -1 means a founder. The asset is a fresh
  /// signer (Core's rule for a new address); the program records its key.
  async registerBirth(id: number, parentId: number, generation: number, birthTick: number, genomeHash: number[], uri: string): Promise<string> {
    const parent = parentId < 0 ? NO_PARENT_ID : BigInt(parentId);
    const asset = Keypair.generate();
    const ix = await this.program.methods.registerBirth(bn(id), bn(parent), generation, bn(birthTick), genomeHash, uri)
      .accountsPartial({
        world: this.worldPda, operator: this.op.publicKey, creature: this.creaturePda(id), asset: asset.publicKey,
        collection: await this.collection(), mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [this.op, asset], async () => (await this.creature(id)) !== null, CU.CORE);
  }

  /// Offer a fly the cage holds: a WILD newborn, or an OWNED one whose
  /// asset was sent back to the World PDA natively (the record cannot see
  /// that transfer; the program checks the asset's owner). Landed once the
  /// record has left "held by the cage, not offered": OFFERED, or already
  /// bought (OWNED by a keeper).
  async openOffer(id: number, price: bigint): Promise<string> {
    const c = await this.creature(id);
    if (!c) throw new ProgramError("WrongId", [], `openOffer: fly ${id} was never registered`);
    const ix = await this.program.methods.openOffer(bn(id), bn(price))
      .accountsPartial({ world: this.worldPda, operator: this.op.publicKey, creature: this.creaturePda(id), asset: c.asset })
      .instruction();
    return this.send([ix], [this.op], async () => {
      const now = await this.creature(id);
      return !!now && now.status !== STATUS.WILD && !(now.status === STATUS.OWNED && now.keeper.equals(this.worldPda));
    });
  }

  /// A whole epoch's life rewards in one transaction: pool -> vaults. The
  /// program does not make this idempotent, so `landed` reads the first
  /// target's vault: grown by at least its share means paid. A purchase in
  /// the same window grows it too, and then the reward is taken as landed
  /// and left unpaid — the pool keeps the money; that is the safe side.
  async rewardMany(ids: number[], amounts: bigint[]): Promise<string> {
    if (ids.length !== amounts.length || !ids.length) throw new Error("ids/amounts length mismatch");
    const first = await this.creature(ids[0]);
    const expect = (first?.vault ?? 0n) + amounts[0];
    const ix = await this.program.methods.rewardMany(amounts.map(bn))
      .accountsPartial({ world: this.worldPda, operator: this.op.publicKey })
      .remainingAccounts(ids.map(id => ({ pubkey: this.creaturePda(id), isWritable: true, isSigner: false })))
      .instruction();
    return this.send([ix], [this.op], async () => ((await this.creature(ids[0]))?.vault ?? 0n) >= expect, CU.REWARD_BASE + CU.REWARD_PER * ids.length);
  }

  /// The keeper's 10% goes to whoever owns the asset when the death settles,
  /// read here at send time; the program checks the credit PDA's seeds
  /// against that owner. The cage itself (World PDA) has no credit, and
  /// neither does a fly whose owner already burned the asset natively
  /// (the account is a Core stub, `keeper` reads as PublicKey.default): the
  /// program then routes the keeper share to metabolism and must be passed
  /// no credit account at all.
  async settleDeath(id: number, cause: number, tick: number, heirs: number[]): Promise<string> {
    const c = await this.creature(id);
    if (!c) throw new ProgramError("WrongId", [], `settleDeath: fly ${id} was never registered`);
    if (c.status === STATUS.DEAD) throw new ProgramError("WrongStatus", [], `settleDeath: fly ${id} is already dead`);
    const noKeeper = c.keeper.equals(this.worldPda) || c.keeper.equals(PublicKey.default);
    const keeperCredit = noKeeper ? null : this.creditPda(c.keeper);
    const ix = await this.program.methods.settleDeath(bn(id), cause, bn(tick), heirs.length)
      .accountsPartial({
        world: this.worldPda, operator: this.op.publicKey, creature: this.creaturePda(id), asset: c.asset,
        collection: await this.collection(), keeperCredit, mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(heirs.map(h => ({ pubkey: this.creaturePda(h), isWritable: true, isSigner: false })))
      .instruction();
    return this.send([ix], [this.op], async () => (await this.creature(id))?.status === STATUS.DEAD, CU.DEATH_BASE + CU.DEATH_PER * heirs.length);
  }

  async postEpoch(epoch: number, tick: number, hash: number[]): Promise<string> {
    const ix = await this.program.methods.postEpoch(bn(epoch), bn(tick), hash)
      .accountsPartial({ world: this.worldPda, operator: this.op.publicKey })
      .instruction();
    return this.send([ix], [this.op], async () => (await this.world()).lastEpoch >= epoch);
  }

  /// Anyone may feed the world. `poolBps` of the lamports go to the reward
  /// pool, the rest to metabolism. `landed` reads the two treasuries: grown
  /// by at least this much means paid (another payer's deposit in the same
  /// window reads the same, and then this one stays in the payer's wallet
  /// for next time rather than going in twice).
  async fund(lamports: bigint, poolBps: number, payer: Keypair = this.op): Promise<string> {
    const before = await this.world();
    const expect = before.metabolism + before.pool + lamports;
    const ix = await this.program.methods.fund(bn(lamports), poolBps)
      .accountsPartial({ world: this.worldPda, payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .instruction();
    return this.send([ix], [payer], async () => { const w = await this.world(); return w.metabolism + w.pool >= expect; });
  }

  // ---- stewardship: hand-over, wind-down and the exits --------------------------
  // What the world process never does on its own; scripts/operator.mts drives
  // these by hand. `landed` reads the World field each one changes.

  /// Not in wind-down; the program refuses the operator's own key.
  async setRecovery(recovery: PublicKey): Promise<string> {
    const ix = await this.program.methods.setRecovery(recovery)
      .accountsPartial({ world: this.worldPda, operator: this.op.publicKey }).instruction();
    return this.send([ix], [this.op], async () => (await this.world()).recovery.equals(recovery));
  }

  /// First half of the two-step hand-over: names the key that may accept.
  async transferOperator(pending: PublicKey): Promise<string> {
    const ix = await this.program.methods.transferOperator(pending)
      .accountsPartial({ world: this.worldPda, operator: this.op.publicKey }).instruction();
    return this.send([ix], [this.op], async () => (await this.world()).pendingOperator.equals(pending));
  }

  /// Second half, signed by the pending key itself (which pays the fee).
  async acceptOperator(pending: Keypair): Promise<string> {
    const ix = await this.program.methods.acceptOperator()
      .accountsPartial({ world: this.worldPda, pendingOperator: pending.publicKey }).instruction();
    return this.send([ix], [pending], async () => (await this.world()).operator.equals(pending.publicKey));
  }

  /// One-way. The operator may do this at any time; anyone may once the
  /// operator has been silent for ABANDONED_AFTER (NotAbandoned before then).
  async beginWindDown(signer: Keypair = this.op): Promise<string> {
    const ix = await this.program.methods.beginWindDown()
      .accountsPartial({ world: this.worldPda, signer: signer.publicKey }).instruction();
    return this.send([ix], [signer], async () => (await this.world()).windDown);
  }

  /// Wind-down: metabolism + pool to `recovery`. No signer but the fee payer.
  async sweepToRecovery(payer: Keypair = this.op): Promise<string> {
    const { recovery } = await this.world();
    const ix = await this.program.methods.sweepToRecovery()
      .accountsPartial({ world: this.worldPda, recovery }).instruction();
    return this.send([ix], [payer], async () => { const w = await this.world(); return w.metabolism === 0n && w.pool === 0n; });
  }

  /// Wind-down + ESCHEAT_AFTER: everything above rent to `recovery` and the
  /// ledger zeroed (TooEarly before the timer). No signer but the fee payer.
  async escheat(payer: Keypair = this.op): Promise<string> {
    const { recovery } = await this.world();
    const ix = await this.program.methods.escheat()
      .accountsPartial({ world: this.worldPda, recovery }).instruction();
    return this.send([ix], [payer], async () => { const w = await this.world(); return w.totalVaults === 0n && w.totalCredit === 0n && w.metabolism === 0n && w.pool === 0n; });
  }

  // ---- after escheat: the rent -----------------------------------------------
  // Nothing is owed to anyone once `escheated` is set, so the accounts
  // themselves go: each close sends the account's lamports (its rent) to
  // `recovery`. Permissionless; the payer only pays the fee. `landed` reads
  // the account: gone means closed.

  /// The Creature PDAs in [from, to) that still exist, with their lamports,
  /// in pages of 100 (getMultipleAccounts' limit).
  async openRecords(range: { from: number; to: number }): Promise<{ id: number; lamports: bigint }[]> {
    const out: { id: number; lamports: bigint }[] = [];
    for (let start = range.from; start < range.to; start += 100) {
      const ids = Array.from({ length: Math.min(100, range.to - start) }, (_, i) => start + i);
      const infos = await this.connection.getMultipleAccountsInfo(ids.map(id => this.creaturePda(id)));
      infos.forEach((info, i) => { if (info) out.push({ id: ids[i], lamports: BigInt(info.lamports) }); });
    }
    return out;
  }

  /// Every Credit PDA that exists: its owner and its lamports. One
  /// getProgramAccounts filtered on the Credit discriminator, sliced to the
  /// owner field, so the answer costs 32 bytes per account.
  async listCreditOwners(): Promise<{ owner: PublicKey; address: PublicKey; lamports: bigint }[]> {
    const disc = this.accountDiscriminator.get("Credit");
    if (!disc) throw new Error("IDL has no Credit account");
    const found = await this.connection.getProgramAccounts(this.programId, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(disc) } }],
      dataSlice: { offset: 8, length: 32 },
    });
    return found.map(({ pubkey, account }) => ({ owner: new PublicKey(account.data), address: pubkey, lamports: BigInt(account.lamports) }));
  }

  /// Close up to CLOSE_BATCH Creature PDAs in one transaction; requires
  /// `escheated` (NotEscheated). The dead cache forgets them: a closed record
  /// reads as never born.
  async closeRecords(ids: number[], payer: Keypair = this.op): Promise<string> {
    if (!ids.length || ids.length > CLOSE_BATCH) throw new Error(`closeRecords: 1..${CLOSE_BATCH} ids per transaction`);
    const { recovery } = await this.world();
    const ixs = await Promise.all(ids.map(id => this.program.methods.closeRecord(bn(id))
      .accountsPartial({ world: this.worldPda, creature: this.creaturePda(id), recovery }).instruction()));
    const sig = await this.send(ixs, [payer], async () => (await this.openRecords({ from: ids[0], to: ids[ids.length - 1] + 1 })).every(r => !ids.includes(r.id)), CU.CLOSE_PER * ids.length);
    for (const id of ids) this.dead.delete(id);
    return sig;
  }

  async closeRecord(id: number, payer: Keypair = this.op): Promise<string> {
    return this.closeRecords([id], payer);
  }

  /// Close up to CLOSE_BATCH Credit PDAs (by owner) in one transaction;
  /// requires `escheated`.
  async closeCredits(owners: PublicKey[], payer: Keypair = this.op): Promise<string> {
    if (!owners.length || owners.length > CLOSE_BATCH) throw new Error(`closeCredits: 1..${CLOSE_BATCH} owners per transaction`);
    const { recovery } = await this.world();
    const credits = owners.map(o => this.creditPda(o));
    const ixs = await Promise.all(credits.map(credit => this.program.methods.closeCredit()
      .accountsPartial({ world: this.worldPda, credit, recovery }).instruction()));
    return this.send(ixs, [payer], async () => (await this.connection.getMultipleAccountsInfo(credits)).every(i => i === null), CU.CLOSE_PER * owners.length);
  }

  async closeCredit(owner: PublicKey, payer: Keypair = this.op): Promise<string> {
    return this.closeCredits([owner], payer);
  }

  /// The last instruction the program ever runs for this world: the World
  /// PDA's rent to `recovery`. Requires `escheated`, every record closed
  /// (`closed_records == next_id`) and no credit open (RecordsStillOpen).
  async closeWorld(payer: Keypair = this.op): Promise<string> {
    const { recovery } = await this.world();
    const ix = await this.program.methods.closeWorld()
      .accountsPartial({ world: this.worldPda, recovery }).instruction();
    return this.send([ix], [payer], async () => !(await this.worldExists()));
  }

  /// Drain a keypair to `to`: everything but `keep` (0, or rent-exempt: the
  /// runtime refuses a balance that is neither) and, unless `payer` pays it,
  /// the fee of this transfer. A fee payer must still be rent-exempt once
  /// its fee is taken and before anything runs, so a wallet holding less
  /// than rent + fee cannot drain itself; it needs a `payer`. Nothing is
  /// sent when nothing would arrive.
  async sendAll(from: Keypair, to: PublicKey, keep = 0n, payer?: Keypair): Promise<{ signature: string | null; lamports: bigint }> {
    const balance = await this.balance(from.publicKey);
    const fee = payer ? 0n : this.fee(CU.TRANSFER);
    const value = balance - keep - fee;
    if (value <= 0n) return { signature: null, lamports: 0n };
    if (!payer && balance - fee < await this.rentExempt(0)) throw new Error(`${from.publicKey.toBase58()} holds ${balance} lamports, under rent + fee: it cannot pay its own fee; drain it with another payer`);
    const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: value });
    const signature = await this.send([ix], payer ? [payer, from] : [from], async () => (await this.balance(from.publicKey)) <= keep, CU.TRANSFER);
    return { signature, lamports: value };
  }

  /// Anyone, after CULL_TIMEOUT: the keeper's 85% to their credit, the asset
  /// burned. The keeper is the asset's owner at settlement, read here.
  async forceSettleCull(id: number, payer: Keypair = this.op): Promise<string> {
    const c = await this.creature(id);
    if (!c) throw new ProgramError("WrongId", [], `forceSettleCull: fly ${id} was never registered`);
    if (!c.pendingCull) throw new ProgramError("WrongStatus", [], `forceSettleCull: fly ${id} has no cull pending`);
    const ix = await this.program.methods.forceSettleCull(bn(id))
      .accountsPartial({
        world: this.worldPda, payer: payer.publicKey, creature: this.creaturePda(id), asset: c.asset,
        collection: await this.collection(), keeperCredit: this.creditPda(c.keeper),
        mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [payer], async () => (await this.creature(id))?.status === STATUS.DEAD, CU.CORE);
  }

  // ---- keeper instructions ----------------------------------------------------

  /// Everything a keeper does, signed with their own key. The world never
  /// moves somebody's fly on their behalf: it holds the key so they need no
  /// wallet extension, but every trade is their transaction, from their
  /// address, paying their own fees. Each call reads the Creature first for
  /// its asset address; a fly that was never born is WrongId here, as it
  /// would be from the program.
  asKeeper(keypair: Keypair) {
    const me = keypair.publicKey;
    const creature = (id: number) => this.creaturePda(id);
    const rec = async (id: number) => {
      const c = await this.creature(id);
      if (!c) throw new ProgramError("WrongId", [], `no fly ${id}`);
      return c;
    };
    const ownedBy = (id: number, who: PublicKey) => async () => (await this.creature(id))?.keeper.equals(who) ?? false;
    return {
      address: me,
      buy: async (id: number, price: bigint): Promise<string> => {
        const c = await rec(id);
        const parent = c.parentId < 0 ? null : this.creaturePda(c.parentId);
        const ix = await this.program.methods.buy(bn(id), bn(price))
          .accountsPartial({
            world: this.worldPda, buyer: me, creature: creature(id), parent, asset: c.asset,
            collection: await this.collection(), mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
          })
          .instruction();
        return this.send([ix], [keypair], ownedBy(id, me), CU.CORE);
      },
      buyListed: async (id: number, price: bigint): Promise<string> => {
        const c = await rec(id);
        const ix = await this.program.methods.buyListed(bn(id), bn(price))
          .accountsPartial({
            world: this.worldPda, buyer: me, creature: creature(id), asset: c.asset, collection: await this.collection(),
            sellerCredit: this.creditPda(c.listedBy), mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
          })
          .instruction();
        return this.send([ix], [keypair], ownedBy(id, me), CU.CORE);
      },
      list: async (id: number, price: bigint): Promise<string> => {
        const c = await rec(id);
        const ix = await this.program.methods.list(bn(id), bn(price))
          .accountsPartial({ signer: me, creature: creature(id), asset: c.asset }).instruction();
        return this.send([ix], [keypair], async () => (await this.creature(id))?.salePrice === price);
      },
      unlist: async (id: number): Promise<string> => {
        const c = await rec(id);
        const ix = await this.program.methods.unlist(bn(id))
          .accountsPartial({ signer: me, creature: creature(id), asset: c.asset }).instruction();
        return this.send([ix], [keypair], async () => (await this.creature(id))?.salePrice === 0n);
      },
      /// A plain Core transfer, as any wallet would do it: no program
      /// instruction, the owner signs and pays (or `payer` pays: the
      /// custodial sweep, where the wallet may hold nothing). A listing left
      /// behind is void (buy_listed checks the lister still owns the asset).
      transferAsset: async (id: number, to: PublicKey, payer: Keypair = keypair): Promise<string> => {
        const c = await rec(id);
        const ix = coreTransfer(c.asset, await this.collection(), me, to);
        return this.send([ix], payer === keypair ? [keypair] : [payer, keypair], ownedBy(id, to), CU.CORE);
      },
      /// A plain Core burn, as any wallet would do it. The program is not
      /// told; the creature stays alive on the record until the world settles
      /// its death, which then finds no keeper and nothing to burn.
      burnAsset: async (id: number): Promise<string> => {
        const c = await rec(id);
        const ix = coreBurn(c.asset, await this.collection(), me);
        return this.send([ix], [keypair], async () => (await this.asset(c.asset)) === null, CU.CORE);
      },
      requestCull: async (id: number): Promise<string> => {
        const c = await rec(id);
        const ix = await this.program.methods.requestCull(bn(id))
          .accountsPartial({
            world: this.worldPda, owner: me, creature: creature(id), asset: c.asset,
            collection: await this.collection(), mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
          })
          .instruction();
        return this.send([ix], [keypair], async () => (await this.creature(id))?.pendingCull ?? false, CU.CORE);
      },
      /// Wind-down exit: the vault becomes the owner's credit and the asset
      /// is burned.
      reclaimVault: async (id: number): Promise<string> => {
        const c = await rec(id);
        const ix = await this.program.methods.reclaimVault(bn(id))
          .accountsPartial({
            world: this.worldPda, owner: me, creature: creature(id), asset: c.asset, collection: await this.collection(),
            credit: this.creditPda(me), mplCoreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
          })
          .instruction();
        return this.send([ix], [keypair], async () => (await this.creature(id))?.status === STATUS.DEAD, CU.CORE);
      },
      withdraw: async (): Promise<string> => {
        const ix = await this.program.methods.withdraw()
          .accountsPartial({ world: this.worldPda, owner: me, credit: this.creditPda(me) }).instruction();
        return this.send([ix], [keypair], async () => (await this.creditOf(me)) === 0n);
      },
      /// Move SOL out of the custodial wallet. "max" empties it (a zero
      /// balance is allowed); any other amount must leave the wallet
      /// rent-exempt, because the runtime refuses a balance that is neither.
      /// The fee is exact: the transfer runs under CU.TRANSFER, and the
      /// priority fee is priced on that limit, so "max" leaves nothing.
      sendSol: async (to: PublicKey, lamports: bigint | "max"): Promise<string> => {
        const [balance, rentMin] = await Promise.all([this.balance(me), this.rentExempt(0)]);
        const fee = this.fee(CU.TRANSFER);
        const value = lamports === "max" ? balance - fee : lamports;
        if (value <= 0n) throw new Error("balance does not cover the fee");
        const left = balance - value - fee;
        if (left < 0n) throw new Error("not enough SOL (remember the fee)");
        if (left > 0n && left < rentMin) throw new Error(`that would leave the wallet below the rent-exempt minimum (${formatSol(rentMin)} SOL); send less, or "max"`);
        const ix = SystemProgram.transfer({ fromPubkey: me, toPubkey: to, lamports: value });
        return this.send([ix], [keypair], async () => (await this.balance(me)) <= left, CU.TRANSFER);
      },
    };
  }

  /// Fund an address from the operator (localnet/devnet onboarding).
  async sendFromOperator(to: PublicKey, lamports: bigint): Promise<string> {
    const before = await this.balance(to);
    const ix = SystemProgram.transfer({ fromPubkey: this.op.publicKey, toPubkey: to, lamports });
    return this.send([ix], [this.op], async () => (await this.balance(to)) >= before + lamports, CU.TRANSFER);
  }

  async airdrop(to: PublicKey, lamports: bigint): Promise<string> {
    const sig = await this.connection.requestAirdrop(to, Number(lamports));
    const bh = await this.connection.getLatestBlockhash("confirmed");
    const res = await this.connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (res.value.err) throw new Error("airdrop failed");
    return sig;
  }
}
