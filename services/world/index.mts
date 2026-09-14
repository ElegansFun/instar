// Instar — the world process.
//
//   The engine runs every neuron of the Janelia MaleCNS v1.0 connectome (and
//   every connection of five or more synapses) for every fly, paced to the
//   wall clock at 10 ticks a second. This process hosts it, journals every
//   input so the whole history replays bit-identically, posts a state hash
//   to Solana each epoch, and settles every birth, death and reward on-chain.
//
//   The engine, journal, replay and snapshot code never knows what chain it
//   is on. Everything chain-shaped goes through services/chain/solana.mts.
//
//   npm run world

import * as fs from "fs";
import { createHash } from "crypto";
import * as path from "path";
import * as zlib from "zlib";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { PublicKey } from "@solana/web3.js";
import { CU, Chain, STATUS, formatSol, loadKeypair, parseSol, type Cluster, type CreatureView, type WorldView } from "../chain/solana.mts";
import { FeeClaimer, withTimeout } from "../chain/fees.mts";
import { Accounts, deriveMasterKey } from "./accounts.mts";
import { createServer, type Boot, type Frame, type StreamEvent, type StreamFly } from "./api.mts";
import { CAUSE_NAME, EVENT, EVENT_NAME, Engine, FIRE_GROUP, NO_PARENT, POSE, hashHex, loadGraph } from "./engine.mts";
import { JournalStore, releaseLock, writeAtomic, writeAtomicAsync, type Entry, type Op } from "./journal.mts";
import { OpQueue } from "./ops.mts";

const gzip = promisify(zlib.gzip);

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
/// 10 ticks a second: every tick steps 166,700 neurons per fly, and the
/// engine budget below keeps the population to what fits in the interval.
const TICKRATE = 10;
const EPOCH_INTERVAL = 2400;
const BUFFER_TICKS = 100;
const START_POP = 8;
const DRAIN_CHUNK = 128;
const BASE_CAPACITY = 8;
const CAPACITY_PER_SOL = 20;
/// Slots the engine allocates: ~0.6 GB of linear memory at 40 (genomes are
/// i16 per connection per fly). Capacity never exceeds it.
const MAX_POP = 40;
const MAX_CAPACITY = MAX_POP;
/// The engine budget: capacity is cut so that the measured ms per fly-tick
/// times the population stays under this, re-measured every epoch; never
/// below MIN_ENGINE_BUDGET, so a slow host still keeps a breeding population.
const ENGINE_BUDGET_MS = 80;
const MIN_ENGINE_BUDGET = 8;
/// Reproduction needs a partner, and the economy's capacity is what the cage
/// is meant to hold. When the population has sat below half of it (never
/// below MIN_POP) for this many consecutive ticks, founders join to bring it
/// back to capacity. Each is a birth like any other, minted and offered, and
/// its rent comes from the operator, so the cage grows exactly as far as
/// metabolism says and no further.
const MIN_POP = 2;
const REGENESIS_AFTER_TICKS = 600;
const refillTarget = (capacity: number) => Math.max(START_POP, capacity);
const refillFloor = (capacity: number) => Math.max(MIN_POP, Math.ceil(refillTarget(capacity) / 2));
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
const SNAP_MAGIC = "instar-snap-2";
/// The snapshot is the whole engine memory (~0.6 GB raw): gzip on disk,
/// every five minutes, compressed off the main thread.
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
/// One more image per epoch, taken this many ticks before the boundary and
/// kept for the last EPOCH_SNAPSHOTS_KEEP epochs, so a verifier can replay
/// an epoch that is already posted (/api/snapshot?epoch=N) instead of
/// waiting for the next one. A minute of replay at 10 t/s.
const PRE_BOUNDARY_TICKS = 600;
const EPOCH_SNAPSHOTS_KEEP = 2;
const TURN = Math.PI * 2 / 65536;
/// ms/tick is logged this often so the operator can see the engine's cost
const TICK_COST_LOG_MS = 60_000;
/// events a stream frame can carry at most; a replay's backlog is not for the site
const STREAM_EVENT_KEEP = 256;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const SWEEP_POOL_BPS = 5000;
const HEARTBEAT_AFTER_S = 24 * 3600;

const log = (line: string) => console.log(`[instar] ${line}`);

type Ctx = Awaited<ReturnType<typeof buildWorld>>;
/// bound before the world is built; /api/health reports the replay from it
const boot: Boot = { ctx: null, tick: 0, target: 0, site: { siteDir: SITE_DIR, rootDir: ROOT, publicUrl: PUBLIC_URL } };

/// Hosts like Railway hand secrets over as environment variables, not files.
/// A keypair given as INSTAR_<NAME>_KEYPAIR_JSON (the 64-number array) is
/// written once into DATA_DIR/keys/<name>.json (mode 0600) and the file path
/// takes over from there, so every other code path keeps reading files.
function materialiseKeypair(name: "operator" | "fee"): string | undefined {
  const json = process.env[`INSTAR_${name.toUpperCase()}_KEYPAIR_JSON`];
  if (!json) return undefined;
  const file = path.join(DATA_DIR, "keys", `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.parse(json);
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`INSTAR_${name.toUpperCase()}_KEYPAIR_JSON must be a 64-number array`);
  const content = JSON.stringify(bytes);
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

async function buildWorld() {
  if (!["localnet", "devnet", "mainnet-beta"].includes(CLUSTER)) throw new Error(`INSTAR_CLUSTER must be localnet|devnet|mainnet-beta, not ${CLUSTER}`);
  const operatorFile = materialiseKeypair("operator") ?? OPERATOR_KEYPAIR;
  const feeFile = materialiseKeypair("fee") ?? process.env.INSTAR_FEE_KEYPAIR;
  if (!fs.existsSync(operatorFile)) throw new Error(`no operator keypair at ${operatorFile} (INSTAR_OPERATOR_KEYPAIR or INSTAR_OPERATOR_KEYPAIR_JSON)`);
  // Refuse before touching the chain or any file: custodial wallets must not
  // be sealed under the operator key, which is the key most likely to rotate.
  if (CLUSTER === "mainnet-beta" && !/^[0-9a-f]{64}$/i.test(process.env.INSTAR_MASTER_KEY ?? "")) {
    throw new Error("REFUSING TO START on mainnet-beta without INSTAR_MASTER_KEY (64 hex chars): custodial wallets must not be sealed under the operator key. " +
      "npm run keys:new writes one as master.key; keep it where the operator key is not.");
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ---------- engine ----------
  const CANON = path.join(ROOT, "data", "canonical");
  const t0 = Date.now();
  const graph = loadGraph(path.join(CANON, "male-cns-v1.0.census.cbg"), path.join(CANON, "male-cns-v1.0.nodes.json"));
  log(`census ${graph.nodes.dataset_id} root ${graph.root.slice(0, 16)}… — ${graph.nodeCount} neurons, ${graph.edgeCount} connections read in ${Date.now() - t0} ms`);
  const WASM = path.join(SITE_DIR, "instar_sim.wasm");
  const engine = await Engine.load(WASM, graph, MAX_POP);
  log(`engine: ${engine.nodeCount} neurons, ${engine.edgeCount} connections, ${MAX_POP} slots, ${(engine.heapBytes / 1e6).toFixed(0)} MB allocated`);
  // What is running, stated so it can be checked: the engine's bytes hash
  // (anyone can rebuild the commit and compare) and the commit itself, from
  // site/build.json when the deploy wrote one (npm run stamp).
  const build: { commit: string | null; dirty: boolean; at: string | null; wasmSha256: string; censusRoot: string } = {
    commit: null, dirty: false, at: null,
    wasmSha256: createHash("sha256").update(fs.readFileSync(WASM)).digest("hex"), censusRoot: graph.root,
  };
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(SITE_DIR, "build.json"), "utf8"));
    if (typeof stamp.commit === "string") Object.assign(build, { commit: stamp.commit, dirty: !!stamp.dirty, at: stamp.at ?? null });
  } catch { /* unstamped build: the commit stays unknown rather than guessed */ }
  log(`build ${build.commit ? build.commit.slice(0, 10) + (build.dirty ? " (dirty)" : "") : "unstamped"}  engine sha256 ${build.wasmSha256.slice(0, 16)}…`);

  // ---------- chain ----------
  const operator = loadKeypair(operatorFile);
  const chain = new Chain({ cluster: CLUSTER, rpc: process.env.INSTAR_RPC, programId: process.env.INSTAR_PROGRAM_ID, operator });
  log(`cluster ${CLUSTER}  program ${chain.programId.toBase58()}  world ${chain.worldPda.toBase58()}`);
  // provider keys ride in the query string; logs must never carry them
  const rpcShown = chain.rpcShown;
  log(`rpc ${rpcShown}${process.env.INSTAR_RPC || CLUSTER === "localnet" ? "" : "  (public endpoint — set INSTAR_RPC to move off it)"}`);
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
  const SNAP_PATH = path.join(DATA_DIR, "snapshot.bin.gz");
  boot.target = journal.tick;

  // ---------- identity (deterministic from the event stream) ----------
  // The engine numbers slots; the host names flies. A uid is assigned to
  // every birth event in order, so the same events always produce the same
  // names, and the name is written into the engine so culls and provisions
  // can target a fly rather than a slot that may since have been reused.
  const slotUid = new Array<number>(engine.maxPop).fill(-1);
  let nextUid = 0;
  let eventSeq = 0;
  let lastEvHead = 0;
  /// numbers every stream event so a client that sees a frame twice (the
  /// connect frame overlaps the next timer frame) shows each event once
  let streamSeq = 0;
  const epochStats = { births: new Map<number, number>(), matured: new Map<number, number>(), disasterAt: -1 };
  /// events since the last /api/stream frame, named for the site
  let streamEvents: StreamEvent[] = [];

  const genomeHex = (slot: number) => hashHex(engine.genomeHash(slot));
  const offerPrice = (gen: number, founder: boolean) => (founder ? OFFER_BASE * FOUNDER_PREMIUM : OFFER_BASE + BigInt(gen) * OFFER_PER_GEN).toString();

  function drainEvents() {
    const events = engine.eventsSince(lastEvHead);
    if (!events.length) return;
    const queued: Op[] = [];
    const uids = engine.uid;
    for (const ev of events) {
      // the fly the event is about, named before a death clears its slot
      let evUid = -1;
      if (ev.kind === EVENT.BIRTH) {
        const slot = ev.a;
        const uid = nextUid++;
        evUid = uid;
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
          if (!ops.windingDown) {
            const gen = engine.generation[slot];
            queued.push({ op: "birth", uid, parentUid, generation: gen, tick: ev.tick, genomeHash: genomeHex(slot) });
            queued.push({ op: "offer", uid, price: offerPrice(gen, founder) });
          }
        }
      } else if (ev.kind === EVENT.DEATH) {
        const slot = ev.a, cause = ev.b;
        const uid = slotUid[slot];
        evUid = uid;
        slotUid[slot] = -1;
        eventSeq++;
        if (uid >= 0 && eventSeq > journal.chainSeq) {
          journal.chainSeq = eventSeq;
          const heirs = [...new Set(journal.children[uid] ?? [])].filter(c => slotUid.includes(c));
          queued.push({ op: "death", uid, cause, tick: ev.tick, heirs });
          log(`fly ${uid} died: ${CAUSE_NAME[cause] ?? cause} @${ev.tick}${heirs.length ? `, ${heirs.length} heir(s)` : ""}`);
        }
      } else if (ev.kind === EVENT.MATURE) {
        evUid = slotUid[ev.a];
        if (evUid >= 0) epochStats.matured.set(evUid, (epochStats.matured.get(evUid) ?? 0) + 1);
      } else if (ev.kind === EVENT.TAKEOFF || ev.kind === EVENT.LANDING) {
        evUid = slotUid[ev.a];
      } else if (ev.kind === EVENT.LIGHTS_OFF || ev.kind === EVENT.DRY_SPELL) {
        epochStats.disasterAt = ev.tick;
      }
      streamEvents.push({
        seq: ++streamSeq, tick: ev.tick, kind: ev.kind, name: EVENT_NAME[ev.kind] ?? String(ev.kind), uid: evUid, b: ev.b,
        cause: ev.kind === EVENT.DEATH ? CAUSE_NAME[ev.b] ?? String(ev.b) : null,
      });
      if (streamEvents.length > STREAM_EVENT_KEEP) streamEvents.splice(0, streamEvents.length - STREAM_EVENT_KEEP);
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

  /// The meta header (host identity state) and the raw engine memory. The
  /// memory is copied here, in one turn of the event loop, so the image is
  /// consistent with the header even though compression happens later.
  function snapshotBytes(extra: Record<string, unknown> = {}): Buffer {
    const meta = Buffer.from(JSON.stringify({
      magic: SNAP_MAGIC, cluster: CLUSTER, programId: chain.programId.toBase58(), era: journal.era, seed: journal.seed,
      tick: engine.tick, slotUid, nextUid, eventSeq, lastEvHead,
      nodes: engine.nodeCount, edges: engine.edgeCount, maxPop: engine.maxPop, ...extra,
    }));
    const image = new Uint8Array(engine.memory);
    const out = Buffer.allocUnsafe(4 + meta.length + image.byteLength);
    out.writeUInt32LE(meta.length, 0);
    meta.copy(out, 4);
    out.set(image, 4 + meta.length);
    return out;
  }
  /// gzip runs on the libuv threadpool: the world keeps ticking while ~0.6
  /// GB compresses. One save at a time, whichever image it is: two raw
  /// copies in flight would double the transient memory, so a second
  /// caller shares the first (periodic) or waits a tick (pre-boundary).
  let saving: Promise<void> | null = null;
  let savedAt = 0;
  /// false until this process wrote SNAP_PATH or resumed from it: a file
  /// the boot did not accept (another era, newer than the journal) is not
  /// served as this world's image
  let snapUsable = false;
  function saveImage(file: string, extra: Record<string, unknown>, label: string): Promise<void> {
    const raw = snapshotBytes(extra);
    const tick = engine.tick, t0 = Date.now();
    return gzip(raw, { level: 1 }).then(async gz => {
      await writeAtomicAsync(file, gz);
      log(`${label} @tick ${tick}: ${(raw.length / 1e6).toFixed(0)} MB -> ${(gz.length / 1e6).toFixed(0)} MB gzip in ${Date.now() - t0} ms`);
    });
  }
  function saveSnapshot(): Promise<void> {
    if (saving) return saving;
    const tick = engine.tick;
    saving = saveImage(SNAP_PATH, {}, "snapshot").then(() => {
      savedAt = Date.now(); snapUsable = true; snapTick = tick;
    }).catch(e => {
      log("snapshot save failed: " + String(e).slice(0, 120));
    }).finally(() => { saving = null; });
    return saving;
  }
  /// The synchronous save for the way out: a process that is exiting has
  /// no event loop left to hand the compression to.
  function saveSnapshotSync() {
    try {
      writeAtomic(SNAP_PATH, zlib.gzipSync(snapshotBytes(), { level: 1 }));
    } catch (e) {
      log("snapshot save failed: " + String(e).slice(0, 120));
    }
  }

  // ---------- the per-epoch images ----------
  const epochSnapPath = (epoch: number) => path.join(DATA_DIR, `snapshot-epoch-${epoch}.bin.gz`);
  /// tick of each retained pre-boundary image by epoch, ascending by epoch
  const epochSnaps = new Map<number, number>();
  /// tick of the image at SNAP_PATH, when snapUsable
  let snapTick = 0;
  /// the epoch whose image this process has taken (or is taking)
  let preSnapEpoch = 0;
  /// The JSON header of an image without inflating the image: the header
  /// is a few KB at the front, so the first 64 KB of the gzip inflated up
  /// to a sync point is enough.
  function readImageMeta(file: string): any {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(65536);
    let n: number;
    try { n = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    const raw = zlib.gunzipSync(head.subarray(0, n), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const metaLen = raw.readUInt32LE(0);
    return JSON.parse(raw.subarray(4, 4 + metaLen).toString());
  }
  const isOurs = (meta: any) => meta?.magic === SNAP_MAGIC && meta.cluster === CLUSTER && meta.programId === chain.programId.toBase58() &&
    meta.era === journal.era && meta.seed === journal.seed;
  function pruneEpochSnaps() {
    while (epochSnaps.size > EPOCH_SNAPSHOTS_KEEP) {
      const gone = epochSnaps.keys().next().value!;
      epochSnaps.delete(gone);
      try { fs.rmSync(epochSnapPath(gone), { force: true }); } catch { /* the next prune retries */ }
    }
  }
  {
    // Images left by the previous process: kept when the header says this
    // world (era, seed, program) at a tick the record has reached, the
    // newest EPOCH_SNAPSHOTS_KEEP of them; anything else is removed.
    const found: number[] = [];
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = /^snapshot-epoch-(\d+)\.bin\.gz$/.exec(f);
      if (m) found.push(Number(m[1]));
    }
    for (const epoch of found.sort((a, b) => a - b)) {
      let meta: any = null;
      try { meta = readImageMeta(epochSnapPath(epoch)); } catch { /* unreadable: removed below */ }
      if (isOurs(meta) && meta.epoch === epoch && meta.tick <= journal.tick) epochSnaps.set(epoch, meta.tick);
      else fs.rmSync(epochSnapPath(epoch), { force: true });
    }
    pruneEpochSnaps();
    preSnapEpoch = Math.max(0, ...epochSnaps.keys());
  }
  /// Called from the clock once the world is within PRE_BOUNDARY_TICKS of
  /// the boundary; skipped while another image is compressing (the clock
  /// asks again next tick). The journal is written right after the file so
  /// the pair agrees, as for the periodic snapshot.
  function saveEpochSnapshot(epoch: number, boundary: number) {
    preSnapEpoch = epoch;
    const tick = engine.tick;
    saving = saveImage(epochSnapPath(epoch), { epoch, boundary }, `epoch ${epoch} snapshot`).then(() => {
      epochSnaps.set(epoch, tick);
      pruneEpochSnaps();
      store.persist();
    }).catch(e => {
      log(`epoch ${epoch} snapshot failed: ` + String(e).slice(0, 120));
    }).finally(() => { saving = null; });
  }
  /// The newest image on disk by tick: the five-minute one or the latest
  /// pre-boundary one, whichever the world took last.
  function latestImage(): string | null {
    let best: string | null = snapUsable && fs.existsSync(SNAP_PATH) ? SNAP_PATH : null, bestTick = best ? snapTick : -1;
    for (const [epoch, tick] of epochSnaps) if (tick > bestTick && fs.existsSync(epochSnapPath(epoch))) { best = epochSnapPath(epoch); bestTick = tick; }
    return best;
  }

  /// An unreadable, foreign or stale file means a replay from genesis. An
  /// image that fits this build but fails the engine's checks after the
  /// copy (sizes, graph slabs, CSR) refuses the boot: the engine now holds
  /// it, and a snapshot with a different connectome in it is not something
  /// to quietly step past.
  function loadSnapshot(): boolean {
    let meta: any, body: Buffer;
    try {
      if (!fs.existsSync(SNAP_PATH)) return false;
      const raw = zlib.gunzipSync(fs.readFileSync(SNAP_PATH));
      const metaLen = raw.readUInt32LE(0);
      meta = JSON.parse(raw.subarray(4, 4 + metaLen).toString());
      body = raw.subarray(4 + metaLen);
    } catch (e) {
      log(`snapshot unreadable (${String(e).slice(0, 80)}) — replaying from genesis`);
      return false;
    }
    if (meta.magic !== SNAP_MAGIC || meta.cluster !== CLUSTER || meta.programId !== chain.programId.toBase58()) return false;
    if (meta.era !== journal.era || meta.seed !== journal.seed || meta.tick > journal.tick) return false;
    if (meta.nodes !== engine.nodeCount || meta.edges !== engine.edgeCount || meta.maxPop !== engine.maxPop) return false;
    let ok: boolean;
    try {
      ok = engine.restore(body);
    } catch (e: any) {
      throw new Error(`REFUSING TO START — ${SNAP_PATH} is not this world's image: ${e.message}. Remove it to replay from genesis.`);
    }
    if (!ok) { log(`snapshot is ${body.length} bytes, this engine build allocates ${engine.memory.byteLength} — replaying from genesis`); return false; }
    if (engine.tick !== meta.tick) throw new Error(`REFUSING TO START — restored engine is at tick ${engine.tick}, ${SNAP_PATH} says ${meta.tick}`);
    slotUid.splice(0, slotUid.length, ...meta.slotUid);
    nextUid = meta.nextUid; eventSeq = meta.eventSeq; lastEvHead = meta.lastEvHead;
    savedAt = fs.statSync(SNAP_PATH).mtimeMs; snapUsable = true; snapTick = meta.tick;
    log(`resumed from snapshot @tick ${meta.tick}`);
    return true;
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
  streamEvents = [];
  log(`era ${journal.era} ${resumed ? "resumed" : "replayed"} to tick ${tick}, pop ${engine.popCount}, ${ops.length} op(s) queued`);

  // ---------- identity reconciliation ----------
  // The world names its flies and the program enforces that the names are
  // sequential, so the two must agree: every id below the program's next_id
  // is registered, and every id this world has named is either registered
  // or still queued. Three ways to disagree, two of them recoverable.
  {
    const onChain = (await chain.world()).nextId;
    if (onChain > nextUid) {
      // Ids this world never named: they belong to a different (or older)
      // world, and nothing this process can do makes them its own.
      throw new Error(
        `REFUSING TO START — this world and its program disagree about identity. World has named ${nextUid} fly/flies; ` +
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
      // id, and adopting it would put a stranger's fly in this record.
      for (const o of landedQueued) {
        const rec = await chain.creature(o.uid);
        if (!rec || rec.genomeHash.slice(-16) !== o.genomeHash) {
          throw new Error(
            `REFUSING TO START — fly ${o.uid} on program ${chain.programId.toBase58()} has genome ${rec?.genomeHash.slice(-16) ?? "(none)"}, ` +
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
      if (!filled.length) throw new Error(`program has ${onChain} flies, world has named ${nextUid}, ${missing.length} never queued — gap too wide to re-queue automatically`);
      log(`program was behind by ${filled.length} birth(s) — re-queued ${filled.join(", ")}`);
    }
    const queued = ops.ops.filter(o => o.op === "birth").length;
    log(`identity in sync — ${onChain} on chain, ${queued} queued, next is ${nextUid}`);
  }

  // ---------- custodial accounts ----------
  const masterKey = process.env.INSTAR_MASTER_KEY ? Buffer.from(process.env.INSTAR_MASTER_KEY, "hex") : deriveMasterKey(operator.secretKey);
  const accounts = new Accounts({ dir: DATA_DIR, masterKey, log });

  // ---------- chain cache ----------
  let flies: CreatureView[] = [];
  let worldView: WorldView | null = null;
  let capacity = 0;
  /// the chain read in flight, so a caller that must see the chain after its
  /// own transaction waits for it and then reads again
  let inflight: Promise<void> | null = null;
  const scheduled = (type: Entry["type"], uid: number) => journal.entries.some(e => e.type === type && "uid" in e && e.uid === uid);

  // ---------- carrying capacity: the economy's number, bounded by compute ----------
  // Metabolism buys slots (BASE_CAPACITY + CAPACITY_PER_SOL per SOL); the
  // engine budget is how many flies this host can step within
  // ENGINE_BUDGET_MS per tick at the ms-per-fly-tick measured over the last
  // epoch. The smaller wins, and a change is a journaled input like any
  // other so a replay applies it at the same tick.
  let economyCap = 0;
  let engineBudget = MAX_CAPACITY;
  function applyCapacity(why: string) {
    const cap = Math.min(economyCap, engineBudget);
    if (cap === capacity || economyCap === 0) return;
    capacity = cap;
    store.addEntry({ tick: tick + BUFFER_TICKS, type: "cap", value: cap });
    log(`${why} -> capacity ${cap} (economy ${economyCap}, engine budget ${engineBudget})`);
  }
  function remeasureBudget(msPerFlyTick: number) {
    const budget = Math.max(MIN_ENGINE_BUDGET, Math.min(MAX_CAPACITY, Math.floor(ENGINE_BUDGET_MS / msPerFlyTick)));
    log(`engine ${msPerFlyTick.toFixed(2)} ms per fly-tick -> budget ${budget} flies at ${ENGINE_BUDGET_MS} ms/tick`);
    if (budget !== engineBudget) { engineBudget = budget; applyCapacity("engine budget"); }
  }

  /// The timer's poll: skipped while one is in flight, so a slow RPC never
  /// queues polls behind itself.
  function pollChain(): Promise<void> {
    if (inflight) return inflight;
    inflight = readChain().finally(() => { inflight = null; });
    return inflight;
  }
  /// After a keeper's transaction: whatever is in flight started before it
  /// landed and may not show it, so wait for that read and then read again.
  async function refreshChain() {
    if (inflight) await inflight.catch(() => undefined);
    return pollChain();
  }
  async function readChain() {
    worldView = await chain.world();
    flies = await chain.creatures({ from: 0, to: worldView.nextId });
    const cap = Math.min(MAX_CAPACITY, BASE_CAPACITY + Math.floor(Number(worldView.metabolism) / 1e9 * CAPACITY_PER_SOL));
    if (cap !== economyCap) {
      economyCap = cap;
      applyCapacity(`metabolism ${formatSol(worldView.metabolism)} SOL`);
    }
    let changed = false;
    for (const c of flies) {
      if (c.status !== STATUS.OWNED || !slotUid.includes(c.id)) continue;
      // a keeper who asked for a cull gets it, deterministically, in-world
      if (c.pendingCull && !scheduled("cull", c.id)) {
        journal.entries.push({ tick: tick + BUFFER_TICKS, type: "cull", uid: c.id });
        changed = true;
      }
      // a fly that has just been bought is provisioned once: the keeper's
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
  }
  setInterval(() => {
    if (ops.cooling) return;
    pollChain().catch(e => log("chain poll: " + String(e?.message ?? e).slice(0, 120)));
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

  /// A fly's worth grows from living a full life, not from being traded.
  /// Scored and settled every REWARD_EVERY_EPOCHS epochs: the flies alive at that boundary.
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
      p += (epochStats.matured.get(uid) ?? 0) * 3;                     // maturity (hormone gate reached)
      p += (epochStats.births.get(uid) ?? 0) * 6;                      // fecundity
      p += Math.min(5, gen[s]);                                        // lineage
      if (epochStats.disasterAt >= tick - EPOCH_INTERVAL * REWARD_EVERY_EPOCHS) p += 4; // resilience
      points.set(uid, p);
    }
    for (const k of Object.keys(journal.eatenBase)) if (!slotUid.includes(Number(k))) delete journal.eatenBase[k];
    epochStats.births.clear(); epochStats.matured.clear();
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
    log(`epoch ${epoch}: ${formatSol(budget)} SOL of life rewards to ${uids.length} flies in ${Math.ceil(uids.length / REWARD_CHUNK)} transaction(s)`);
  }

  // ---------- the world clock ----------
  // The engine's cost is measured here: ms per tick (logged every minute)
  // and ms per fly-tick over each epoch, which sets the engine budget. A
  // world over budget falls behind the wall clock, which /api/health reports.
  let acc = 0, lastWall = Date.now(), lowSince = -1;
  const cost = { ms: 0, ticks: 0, since: Date.now() };
  const epochCost = { ms: 0, flyTicks: 0 };
  setInterval(() => {
    const now = Date.now();
    acc += ((now - lastWall) / 1000) * TICKRATE;
    lastWall = now;
    // One tick per turn: a tick holds the event loop for tens of ms, and
    // batching two or more would hold it long enough to delay stream frames
    // and API answers. The 50 ms interval still catches up at twice the
    // tick rate; the remainder is carried, never dropped.
    const budget = Math.min(Math.floor(acc), 1);
    acc -= budget;
    if (budget <= 0) return;
    const boundary = (lastEpoch + 1) * EPOCH_INTERVAL;
    // Seal exactly at the boundary tick: whatever of this budget lies past
    // it is carried, not dropped, or every late interval that straddles a
    // boundary would leave the world a little further behind the clock.
    const target = Math.min(tick + budget, boundary);
    acc += tick + budget - target;
    // The epoch's image, once, in the last minute before the boundary: the
    // copy is taken here so it is at a tick the journal has already
    // recorded. Another image compressing means asking again next tick.
    if (tick >= boundary - PRE_BOUNDARY_TICKS && preSnapEpoch < lastEpoch + 1 && !saving) saveEpochSnapshot(lastEpoch + 1, boundary);
    const from = tick, popBefore = engine.popCount, t0 = performance.now();
    try {
      tick = advanceSim(target);
    } catch (e) {
      store.persist();
      console.error("[instar] FATAL:", e);
      process.exit(1);
    }
    const spent = performance.now() - t0;
    cost.ms += spent; cost.ticks += tick - from;
    epochCost.ms += spent; epochCost.flyTicks += (tick - from) * popBefore;
    if (now - cost.since >= TICK_COST_LOG_MS && cost.ticks) {
      log(`engine ${(cost.ms / cost.ticks).toFixed(2)} ms/tick over ${cost.ticks} ticks, pop ${engine.popCount} (budget ${ENGINE_BUDGET_MS} of ${(1000 / TICKRATE).toFixed(0)} ms)`);
      cost.ms = 0; cost.ticks = 0; cost.since = now;
    }
    if (tick >= boundary) {
      lastEpoch += 1;
      creditLifePerformance(lastEpoch);
      sealEpoch(lastEpoch, tick);
      if (epochCost.flyTicks > 0) remeasureBudget(epochCost.ms / epochCost.flyTicks);
      epochCost.ms = 0; epochCost.flyTicks = 0;
    }
    const pop = engine.popCount;
    if (pop < refillFloor(capacity)) {
      if (lowSince < 0) lowSince = tick;
      const pending = journal.entries.some(e => e.type === "gen" && e.tick > tick);
      if (!pending && tick - lowSince > REGENESIS_AFTER_TICKS) {
        const n = refillTarget(capacity) - pop;
        store.addEntry({ tick: tick + BUFFER_TICKS, type: "gen", n });
        log(`population ${pop} under ${refillFloor(capacity)} — ${n} founder(s) join at tick ${tick + BUFFER_TICKS} (capacity ${capacity})`);
      }
    } else lowSince = -1;
    journal.tick = tick;
  }, 50);

  // ---------- fee income, fed into the world ----------
  // With INSTAR_COIN_MINT set, the coin's creator-fee vaults are claimed into
  // the fee keypair first; the sweep then moves everything above rent and
  // the gas reserve into the world. A failed claim leaves the sweep to run
  // on whatever is already there and is retried next interval.
  /// published on /api/config so the site can name the coin and where its
  /// creator fees go without a redeploy when the coin launches
  const coin: { mint: string | null; creator: string | null } = { mint: process.env.INSTAR_COIN_MINT ?? null, creator: null };
  if (feeFile) {
    const fee = loadKeypair(feeFile);
    coin.creator = fee.publicKey.toBase58();
    const claimer = coin.mint
      ? new FeeClaimer({ chain, mint: new PublicKey(coin.mint), fee, log })
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
  // flies have been named. Writing the journal right after the snapshot
  // keeps the pair consistent to within a moment rather than five minutes.
  setInterval(() => { saveSnapshot().then(() => store.persist()); }, SNAPSHOT_INTERVAL_MS);

  // ---------- the live frame ----------
  // What /api/stream sends: every living fly's pose and firing counts by
  // role group, straight from the engine's arrays, plus the events since
  // the previous frame. Positions in cells, angles in radians.
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const groupNames = Object.keys(FIRE_GROUP) as (keyof typeof FIRE_GROUP)[];
  /// `consume` false leaves the events for the next timer frame: a connect
  /// frame must not take what every other client is still owed.
  function frame(consume = true): Frame {
    const alive = engine.alive, x = engine.x, y = engine.y, z = engine.z, hd = engine.heading, energy = engine.energy;
    const gen = engine.generation, lin = engine.lineage, age = engine.age;
    const pose = engine.pose, counts = engine.firedCount, PL = engine.poseLen, FG = engine.fireGroups;
    const out: StreamFly[] = [];
    for (let s = 0; s < engine.maxPop; s++) {
      if (!alive[s] || slotUid[s] < 0) continue;
      const po = s * PL, fo = s * FG;
      const fired = {} as StreamFly["fired"];
      for (const g of groupNames) fired[g] = counts[fo + FIRE_GROUP[g]];
      out.push({
        id: slotUid[s], slot: s, gen: gen[s], lin: lin[s], age: age[s], mode: pose[po + POSE.MODE] ? 1 : 0, s: pose[po + POSE.SURFACE],
        x: r2(Engine.cells(x[s])), y: r2(Engine.cells(y[s])), z: r2(Engine.cells(z[s])),
        h: r3(hd[s] * TURN), p: r3(pose[po + POSE.PITCH] * TURN), r: r3(pose[po + POSE.ROLL] * TURN), e: energy[s],
        wb: r3((pose[po + POSE.WINGBEAT] & 0xffff) / 65536),
        legs: [pose[po + POSE.LEG0], pose[po + POSE.LEG0 + 1], pose[po + POSE.LEG0 + 2], pose[po + POSE.LEG0 + 3], pose[po + POSE.LEG0 + 4], pose[po + POSE.LEG0 + 5]],
        pr: r3(pose[po + POSE.PROBOSCIS] / 255), fired,
      });
    }
    const events = streamEvents;
    if (consume) streamEvents = [];
    return { t: tick, light: engine.light, temp: engine.temp, flies: out, events };
  }

  ops.start();
  await refreshChain().catch(e => log("initial chain read: " + String(e?.message ?? e).slice(0, 120)));

  return {
    cluster: CLUSTER, googleClientId: GOOGLE_CLIENT_ID, publicUrl: PUBLIC_URL, coin, build,
    // the rules the site quotes, so no rate is typed into a page
    economy: { offerBase: OFFER_BASE.toString(), offerPerGen: OFFER_PER_GEN.toString(), founderPremium: Number(FOUNDER_PREMIUM), rewardEveryEpochs: REWARD_EVERY_EPOCHS, poolPayoutBps: Number(POOL_PAYOUT_BPS), sweepIntervalMs: SWEEP_INTERVAL_MS, sweepPoolBps: SWEEP_POOL_BPS, gasReserve: GAS_RESERVE.toString() },
    corsOrigin: process.env.INSTAR_CORS_ORIGIN ?? "", siteDir: SITE_DIR, rootDir: ROOT, dataDir: DATA_DIR, adminToken: ADMIN_TOKEN,
    chain, store, engine, accounts, ops, log, bufferTicks: BUFFER_TICKS,
    tick: () => tick, capacity: () => capacity, lastEpoch: () => lastEpoch,
    // the clock's anchor: /api/health measures drift from here
    startedAt: { wall: Date.now(), tick },
    flies: () => flies, world: () => worldView, refreshChain, frame,
    arena: engine.arena(),
    // The five-minute file, refreshed first when this process has not
    // written one or it is older than refreshAfterMs: the admin's routes.
    snapshotFile: async (refreshAfterMs: number) => {
      if (!snapUsable || !fs.existsSync(SNAP_PATH) || Date.now() - savedAt > refreshAfterMs) await saveSnapshot();
      return SNAP_PATH;
    },
    // The public route: the newest image on disk, whichever kind. Only a
    // world that has no image at all yet pays the 0.6 GB copy and the gzip.
    latestSnapshotFile: async () => {
      const latest = latestImage();
      if (latest) return latest;
      await saveSnapshot();
      return SNAP_PATH;
    },
    snapshotEpochs: () => [...epochSnaps.keys()],
    snapshotEpochFile: (epoch: number) => epochSnaps.has(epoch) && fs.existsSync(epochSnapPath(epoch)) ? epochSnapPath(epoch) : null,
    engineFly: (id: number) => {
      const s = engine.slotOf(id);
      return s < 0 ? null : { slot: s, generation: engine.generation[s], lineage: engine.lineage[s], genomeHash: genomeHex(s) };
    },
    shutdown: () => { store.persist(); saveSnapshotSync(); store.releaseLock(); },
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
