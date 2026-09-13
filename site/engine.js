// Engine host for the browser: boots instar_sim.wasm from the canonical census,
// then either mirrors the one live world (snapshot join or genesis replay,
// journal entries, independent epoch-hash verification) or runs a local
// sandbox from a fresh genesis when no world API answers.
import { rolesFor } from "./roles.js";

export const CENSUS_URL = "/data/canonical/droso-winding2023-larva.census.json";
export const WASM_URL = "./instar_sim.wasm";
const SANDBOX_SEED = 0x494e5354n; // "INST"
const SANDBOX_FOUNDERS = 24;
const SANDBOX_CAPACITY = 36;
const SANDBOX_TICKRATE = 20;
const SANDBOX_EPOCH_INTERVAL = 2400;
// the service steps in chunks of at most this many ticks and drains the event
// ring after each chunk; uid assignment depends on seeing every birth in order
const STEP_CHUNK = 128;
// a sandbox keeps asking whether a world has come up, this often
const SANDBOX_RETRY_MS = 10000;

const params = new URLSearchParams(location.search);
export const FULL_REPLAY = params.get("full") === "1";
// Served by the world process the API is same-origin and nothing else may
// name it: a foreign ?api= would receive this page's session token. Served
// from the repo by a plain static server (dev) the page lives under /site/,
// has no API of its own, and ?api= may point at one; otherwise it is a sandbox.
export const API = location.pathname.startsWith("/site/") ? params.get("api") : location.origin;
export const SAME_ORIGIN_API = API === location.origin;

export const DEATH_CAUSE = { 1: "starved", 2: "senescence", 3: "killed", 4: "desiccated", 5: "drowned", 6: "culled" };
export const BIOME = { WALL: 0, AGAR: 1, YEAST: 2, FRUIT: 3, DRY: 4, POOL: 5, LIT: 6, RIM: 7 };

export async function loadAssets() {
  const [census, wasmBytes] = await Promise.all([
    fetch(CENSUS_URL).then(r => { if (!r.ok) throw new Error("census " + r.status); return r.json(); }),
    fetch(WASM_URL).then(r => { if (!r.ok) throw new Error("engine " + r.status); return r.arrayBuffer(); }),
  ]);
  return { census, wasmBytes };
}

// Instantiate the engine and upload the census: roles, edge list, base
// weights. Returns the exports; the caller runs world_init.
export async function instantiate(wasmBytes, census) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const s = instance.exports;
  const nodeIndex = new Map(census.nodes.map((n, i) => [n.id, i]));
  const roles = rolesFor(census.nodes);
  new Uint8Array(s.memory.buffer, s.role_ptr(), s.max_nodes()).set(roles);
  const pre = new Uint16Array(s.memory.buffer, s.edge_pre_ptr(), s.max_edges());
  const post = new Uint16Array(s.memory.buffer, s.edge_post_ptr(), s.max_edges());
  const wts = new Int32Array(s.memory.buffer, s.edge_weight_ptr(), s.max_edges());
  census.edges.forEach((e, i) => {
    pre[i] = nodeIndex.get(e.pre);
    post[i] = nodeIndex.get(e.post);
    wts[i] = e.weight;
  });
  return s;
}

const hex64 = (v) => (BigInt.asUintN(64, v)).toString(16).padStart(16, "0");

export class World {
  constructor(sim, census) {
    this.sim = sim;
    this.census = census;
    this.roles = rolesFor(census.nodes);
    this.nNodes = census.nodes.length;
    this.nEdges = census.edges.length;
    this.MAXP = sim.max_pop();
    this.MAXN = sim.max_nodes();
    this.MAXE = sim.max_edges();
    this.NSEG = sim.nseg();
    this.G = sim.grid();
    this.R = sim.dish_radius();
    this.nextUid = 0;
    this.lastEvHead = sim.event_head();
    this.listeners = [];
    this.live = null;       // journal state when mirroring the real world
    this.joinedAt = 0;
    this.tickrate = SANDBOX_TICKRATE;
    this.sandboxCapacity = SANDBOX_CAPACITY;
    this.sandboxEpochInterval = SANDBOX_EPOCH_INTERVAL;
    this.clockTick = 0;     // wall-clock anchor for pacing
    this.clockAt = performance.now();
  }
  mem() { return this.sim.memory.buffer; }
  tick() { return Number(this.sim.get_tick()); }
  // typed views are rebuilt on demand: memory.grow detaches old buffers
  u8(ptr, n) { return new Uint8Array(this.mem(), ptr, n); }
  i16(ptr, n) { return new Int16Array(this.mem(), ptr, n); }
  u16(ptr, n) { return new Uint16Array(this.mem(), ptr, n); }
  i32(ptr, n) { return new Int32Array(this.mem(), ptr, n); }
  u32(ptr, n) { return new Uint32Array(this.mem(), ptr, n); }
  alive() { return this.u8(this.sim.alive_ptr(), this.MAXP); }
  xs() { return this.i32(this.sim.x_ptr(), this.MAXP); }
  ys() { return this.i32(this.sim.y_ptr(), this.MAXP); }
  headings() { return this.u16(this.sim.heading_ptr(), this.MAXP); }
  bends() { return this.i16(this.sim.bend_ptr(), this.MAXP * this.NSEG); }
  energy() { return this.i32(this.sim.energy_ptr(), this.MAXP); }
  ages() { return this.u32(this.sim.age_ptr(), this.MAXP); }
  generations() { return this.u32(this.sim.generation_ptr(), this.MAXP); }
  lineages() { return this.u32(this.sim.lineage_ptr(), this.MAXP); }
  ecdysone() { return this.u32(this.sim.ecdysone_ptr(), this.MAXP); }
  eaten() { return this.u32(this.sim.eaten_ptr(), this.MAXP); }
  fed() { return this.u32(this.sim.fed_ptr(), this.MAXP); }
  uids() { return this.u32(this.sim.uid_ptr(), this.MAXP); }
  fired() { return this.u8(this.sim.fired_ptr(), this.MAXP * this.MAXN); }
  food() { return this.i32(this.sim.food_ptr(), this.G * this.G); }
  moisture() { return this.u8(this.sim.moisture_ptr(), this.G * this.G); }
  biome() { return this.u8(this.sim.biome_ptr(), this.G * this.G); }
  genome(slot) { return this.i16(this.sim.genome_ptr() + slot * this.MAXE * 2, this.nEdges); }
  stateHash() { return hex64(this.sim.state_hash()); }
  slotOfUid(uid) {
    const alive = this.alive(), uids = this.uids();
    for (let i = 0; i < this.MAXP; i++) if (alive[i] && uids[i] === uid) return i;
    return -1;
  }
  capacity() { return this.live ? this.live.capacity : this.sandboxCapacity; }
  epochInterval() { return this.live ? this.live.epochInterval : this.sandboxEpochInterval; }
  epoch() { return Math.floor(this.tick() / this.epochInterval()); }
  onEvent(fn) { this.listeners.push(fn); }

  // Read new entries from the engine's event ring. Births get the next uid,
  // exactly as the world process assigns them, so the ids shown here are the
  // ids on chain. Must run after every step chunk or the 256-entry ring wraps.
  drainEvents() {
    const s = this.sim;
    const head = s.event_head();
    let n = head - this.lastEvHead;
    if (n <= 0) return;
    if (n > 256) { this.lastEvHead = head - 256; n = 256; }
    const ring = this.u32(s.event_ptr(), 256 * 4);
    const uids = this.uids();
    for (let k = this.lastEvHead; k < head; k++) {
      const o = (k % 256) * 4;
      const ev = { tick: ring[o], kind: ring[o + 1], a: ring[o + 2], b: ring[o + 3] };
      if (ev.kind === 1) { uids[ev.a] = this.nextUid++; ev.uid = uids[ev.a]; }
      else if (ev.kind === 2 || ev.kind === 6) ev.uid = uids[ev.a];
      for (const fn of this.listeners) fn(ev);
    }
    this.lastEvHead = head;
  }
  // Step up to `n` ticks in service-sized chunks, stopping early once the
  // wall-clock deadline passes so a long catch-up never freezes the page.
  stepChunked(n, deadline = Infinity) {
    let done = 0;
    while (done < n) {
      const c = Math.min(STEP_CHUNK, n - done);
      this.sim.step(c);
      this.drainEvents();
      done += c;
      if (performance.now() > deadline) break;
    }
    return done;
  }

  // ---- journal replay (live mirror) ----
  applyEntriesAt(t) {
    const live = this.live;
    for (const e of live.entries) {
      if (e.tick !== t) continue;
      if (e.type === "cap") this.sim.set_capacity(e.value);
      else if (e.type === "cull") this.sim.int_kill(e.uid);
      else if (e.type === "provision") this.sim.int_provision(e.uid);
      else if (e.type === "gen") { this.sim.spawn_founders(e.n); this.drainEvents(); }
    }
  }
  nextStopAfter(t) {
    const live = this.live;
    let stop = Infinity;
    for (const e of live.entries) if (e.tick > t && e.tick < stop) stop = e.tick;
    const boundary = (Math.floor(t / live.epochInterval) + 1) * live.epochInterval;
    return Math.min(stop, boundary);
  }
  recordEpochHash(t) {
    const live = this.live;
    if (t === 0 || t % live.epochInterval !== 0) return;
    live.localHashes.set(t / live.epochInterval, this.stateHash());
    if (live.localHashes.size > 120) live.localHashes.delete(Math.min(...live.localHashes.keys()));
  }
  // Advance toward `target` honouring journal entries and epoch boundaries,
  // in the same order the world process does: step, drain, apply entries,
  // hash. Entries and hashes only happen when the stop tick is reached.
  advanceTo(target, deadline) {
    let t = this.tick();
    while (t < target) {
      const stop = Math.min(target, this.nextStopAfter(t));
      t += this.stepChunked(stop - t, deadline);
      if (t < stop) return t;
      this.applyEntriesAt(t);
      this.recordEpochHash(t);
    }
    return t;
  }
  // Called every frame. Mirrors the server clock when live; otherwise runs the
  // sandbox at the same ticks per second the real world runs at.
  pace(now) {
    if (this.live) {
      const live = this.live;
      // Every journal entry is scheduled at least bufferTicks after the server
      // tick that scheduled it, so the mirror may never pass the last polled
      // tick plus that buffer: an entry it has not heard of yet would be
      // skipped. A slow poll pauses the mirror instead of desyncing it.
      const wall = Math.floor(live.serverTick + ((now - live.fetchedAt) / 1000) * live.tickrate);
      const target = Math.min(wall, live.serverTick + live.bufferTicks - 1);
      const behind = target - this.tick();
      // catching up gets more of the frame than keeping up
      if (behind > 0) this.advanceTo(target, now + (behind > 2000 ? 70 : 20));
      return target - this.tick();
    }
    const target = this.clockTick + Math.floor(((now - this.clockAt) / 1000) * this.tickrate);
    const behind = target - this.tick();
    if (behind > 0) this.stepChunked(Math.min(behind, 600), now + 20);
    return 0;
  }
}

// Fetch the journal; null when no world answers.
export async function fetchJournal(timeoutMs = 2500) {
  if (!API) return null;
  try {
    const r = await fetch(API + "/api/journal", { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.name === "instar" ? j : null;
  } catch { return null; }
}
// Boot asks three times with a patient timeout before calling the world
// absent: a first byte delayed by a snapshot being gzipped is not an outage.
async function fetchJournalPatiently() {
  for (let i = 0; i < 3; i++) {
    const j = await fetchJournal(6000);
    if (j || !API) return j;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}
async function fetchConfig() {
  try {
    const r = await fetch(API + "/api/config", { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

const entryKey = (e) =>
  e.type === "cull" ? "u" + e.uid :
  e.type === "provision" ? "p" + e.tick + ":" + e.uid :
  e.type === "gen" ? "g" + e.tick :
  "c" + e.tick + ":" + e.value;

// Build the world: live mirror when a journal is reachable, sandbox otherwise.
export async function boot({ status = () => {} } = {}) {
  status("loading census and engine");
  const [{ census, wasmBytes }, journal] = await Promise.all([loadAssets(), fetchJournalPatiently()]);
  status(journal ? "connecting to the world" : "no world reachable: local sandbox");
  const sim = await instantiate(wasmBytes, census);
  const world = new World(sim, census);
  const seed = journal ? BigInt(journal.seed) : SANDBOX_SEED;
  sim.world_init(seed, census.nodes.length, census.edges.length, 0);
  world.lastEvHead = sim.event_head();

  if (!journal) {
    sim.set_capacity(SANDBOX_CAPACITY);
    sim.spawn_founders(SANDBOX_FOUNDERS);
    world.drainEvents();
    world.clockTick = 0;
    world.clockAt = performance.now();
    // a world that comes up later replaces the sandbox with the real thing
    if (API) setInterval(async () => { if (await fetchJournal(8000)) location.reload(); }, SANDBOX_RETRY_MS);
    return world;
  }

  world.live = {
    ...journal,
    config: await fetchConfig(),
    fetchedAt: performance.now(),
    serverTick: journal.tick,
    keys: new Set(journal.entries.map(entryKey)),
    localHashes: new Map(),
    lastCheckedEpoch: 0,
    // per epoch this mirror hashed: { journal, chain, local, posted, onChain }
    epochState: new Map(),
    verified: 0,      // the chain holds the hash this mirror computed
    journalOnly: 0,   // the journal agrees, the chain has not been read for it
    mismatched: 0,    // the journal or the chain disagrees
    chain: null,      // last World account read: { at, epoch, tick, hash, hash32 } or { at, error }
    chainBusy: false,
  };
  world.tickrate = journal.tickrate;

  // Join instantly from the world's own memory image, then verify every epoch
  // from here on. ?full=1 replays the whole history from genesis instead.
  if (!FULL_REPLAY) {
    try {
      status("loading snapshot");
      const r = await fetch(API + "/api/snapshot", { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("snapshot " + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      const metaLen = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
      const meta = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + metaLen)));
      const memBytes = buf.subarray(4 + metaLen);
      const have = sim.memory.buffer.byteLength;
      if (memBytes.length > have) sim.memory.grow(Math.ceil((memBytes.length - have) / 65536));
      new Uint8Array(sim.memory.buffer).set(memBytes);
      world.joinedAt = world.tick();
      world.nextUid = meta.nextUid;
      world.lastEvHead = meta.eventHead ?? sim.event_head();
      if (world.joinedAt !== meta.tick) console.warn("[snapshot] tick mismatch", world.joinedAt, meta.tick);
    } catch (e) {
      console.warn("[snapshot] unavailable, replaying from genesis:", e.message);
      world.joinedAt = 0;
    }
  }
  if (world.tick() === 0) {
    // genesis: entries scheduled at tick 0 apply before the first step
    world.applyEntriesAt(0);
  }
  return world;
}

// The chain keeps only the newest epoch's hash on the World account, so an
// epoch is checked there while it is the newest; one the chain has moved past
// stays "journal only". Offsets come from /api/config, computed from the IDL.
async function readWorldAccount(config) {
  const w = config.world;
  if (!config.rpc || !w) throw new Error("the world did not publish its account layout");
  const r = await fetch(config.rpc, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [w.account, { encoding: "base64", commitment: "confirmed" }] }),
  });
  if (!r.ok) throw new Error("rpc " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  if (!j.result || !j.result.value) throw new Error("World account not found on this cluster");
  const bytes = Uint8Array.from(atob(j.result.value.data[0]), c => c.charCodeAt(0));
  const dv = new DataView(bytes.buffer);
  const u64 = (f) => Number(dv.getBigUint64(f.offset, true));
  const hash = bytes.subarray(w.lastStateHash.offset, w.lastStateHash.offset + w.lastStateHash.size);
  const hex = (b) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  // the engine's u64 sits big-endian in the last 8 bytes; the rest is zero
  return { at: Date.now(), epoch: u64(w.lastEpoch), tick: u64(w.lastEpochTick), hash32: hex(hash), hash: hex(hash.subarray(hash.length - 8)) };
}
async function checkChain(world, onEpoch) {
  const live = world.live;
  if (live.chainBusy) return;
  live.chainBusy = true;
  try {
    const c = await readWorldAccount(live.config);
    live.chain = c;
    for (const [epoch, st] of live.epochState) {
      if (st.chain !== null) continue;
      if (c.epoch < epoch) continue;               // not posted yet
      if (c.epoch > epoch) { st.chain = "passed"; continue; }
      st.onChain = c.hash;
      st.chain = c.hash === st.local;
      live.journalOnly--;
      if (st.chain) live.verified++; else live.mismatched++;
      console.info(`[chain] epoch ${epoch} World.last_state_hash ${c.hash32} local ${st.local} ${st.chain ? "agree" : "DIFFER"}`);
      onEpoch?.(st.posted, st);
    }
  } catch (e) {
    live.chain = { at: Date.now(), error: e.message };
  } finally {
    live.chainBusy = false;
  }
}

// Poll the journal: merge new entries, check the epochs the mirror has hashed
// itself against what the world posted, then against the chain. Returns the
// fresh journal.
export async function pollJournal(world, onEntry, onEpoch) {
  const j = await fetchJournal(8000);
  if (!j) return null;
  const live = world.live;
  live.serverTick = j.tick;
  live.fetchedAt = performance.now();
  if (j.bufferTicks !== undefined) live.bufferTicks = j.bufferTicks;
  const localT = world.tick();
  for (const e of j.entries) {
    const key = entryKey(e);
    if (live.keys.has(key)) continue;
    if (e.tick <= localT) return { desynced: true };
    live.keys.add(key);
    live.entries.push(e);
    onEntry?.(e);
  }
  for (const ep of j.epochs) {
    if (ep.epoch <= live.lastCheckedEpoch) continue;
    const mine = live.localHashes.get(ep.epoch);
    if (mine === undefined) {
      if (ep.tick > localT) continue;     // not there yet
      live.lastCheckedEpoch = ep.epoch;   // before we joined: cannot check
      continue;
    }
    live.lastCheckedEpoch = ep.epoch;
    const st = { journal: mine === ep.hash, chain: null, local: mine, posted: ep, onChain: null };
    live.epochState.set(ep.epoch, st);
    if (st.journal) live.journalOnly++; else live.mismatched++;
    onEpoch?.(ep, st);
  }
  for (const k of ["capacity", "metabolism", "pool", "operator", "operatorBalance", "pendingOps", "settling", "txlog", "larvae", "lineageNames", "stats", "epochs", "epoch", "explorer", "explorerQuery", "cluster", "programId", "worldPda"]) {
    if (k in j) live[k] = j[k];
  }
  let awaiting = false;
  for (const st of live.epochState.values()) if (st.chain === null) { awaiting = true; break; }
  if (awaiting) checkChain(world, onEpoch);
  return j;
}

// One line for the HUD: what this mirror can honestly say about the epochs
// it has hashed. VERIFIED means the chain holds the same hash and was read
// the last time it was asked; an unreachable RPC demotes the claim to what
// the journal alone supports.
export function verdict(live) {
  const n = (k) => `${live[k]} epoch${live[k] > 1 ? "s" : ""}`;
  if (live.mismatched) return { cls: "bad", word: "DIVERGED", detail: n("mismatched") };
  const unread = live.chain && live.chain.error;
  if (unread && live.journalOnly) return { cls: "", word: "JOURNAL MATCHES", detail: `${n("journalOnly")}, chain unread` };
  if (live.verified) return { cls: "ok", word: "VERIFIED", detail: `${n("verified")} on chain` };
  if (live.journalOnly) {
    let pending = false;
    for (const st of live.epochState.values()) if (st.chain === null) { pending = true; break; }
    return { cls: "", word: "JOURNAL MATCHES", detail: `${n("journalOnly")}, ${pending ? "chain pending" : "chain moved on"}` };
  }
  return null;
}

// Fill every <span data-n="..."> in the page from the census, the engine and
// the journal, so no count or rate is typed into the HTML.
export function fillConstants(world) {
  const v = {
    nodes: world.nNodes,
    edges: world.nEdges,
    syn: world.census.edges.reduce((a, e) => a + e.weight, 0),
    tickrate: world.tickrate,
    epoch: world.epochInterval(),
    grid: world.G,
    radius: world.R,
  };
  for (const el of document.querySelectorAll("[data-n]")) {
    const n = v[el.dataset.n];
    if (n !== undefined) el.textContent = n.toLocaleString("en-US");
  }
}
