// Verification worker: the engine, run once, on purpose. Loads the canonical
// graph (CBG0) and node file, hands the engine the same roles the world
// process uses, streams the world's snapshot straight into the engine's
// memory, checks that the image carries the canonical graph, replays the
// journal's host inputs to the epoch boundary exactly as the world does,
// and posts the state hash back. The page compares it with the journal and
// with the World account. Nothing here is shown as animation; it is a check.
//
// Memory: the engine's image (~0.7 GB at 40 slots) lives in wasm linear
// memory and is never held in JavaScript as a whole: the gzip is inflated
// chunk by chunk and each chunk copied at its offset. What stays around
// beside the image is the canonical graph's CSR (out_start, out_post and
// weights, ~50 MB) kept for the post-restore comparison, plus one pending
// buffer of at most FLUSH_BYTES. `peakBytes` in the done message is this
// worker's own accounting of the largest total it held at once.
import { rolesFor } from "./roles.js";

const say = (text) => postMessage({ type: "status", text });
const fail = (text) => postMessage({ type: "error", text });
const PAGE = 65536;
// inflated bytes are copied into the engine in runs of this size, so the
// engine grows once per run rather than once per network chunk
const FLUSH_BYTES = 32 << 20;
// the world's own replay granularity (services/world/index.mts DRAIN_CHUNK)
const DRAIN_CHUNK = 128;
const POLL_MS = 5000;
const JOURNAL_WAIT_MS = 10 * 60_000;
const fmtN = (n) => n.toLocaleString("en-US");

let peakBytes = 0, heldBytes = 0;
const hold = (n) => { heldBytes += n; if (heldBytes > peakBytes) peakBytes = heldBytes; };

async function fetchBytes(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label}: ${r.status}`);
  const total = Number(r.headers.get("content-length")) || 0;
  if (!r.body) { const b = new Uint8Array(await r.arrayBuffer()); hold(b.length); return b; }
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0, lastSaid = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length; hold(value.length);
    if (got - lastSaid > 8 << 20) { lastSaid = got; say(`${label}: ${(got / 1048576).toFixed(0)}${total ? ` of ${(total / 1048576).toFixed(0)}` : ""} MB`); }
  }
  const out = new Uint8Array(got);
  hold(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  hold(-got);
  return out;
}

// CBG0: "CBG0", root[32], u32 n, u32 e, node table (u8 len, id, u8 kind),
// edge table (u32 pre, u32 post, u8 kind, u32 weight), little-endian, packed
function parseCbg(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "CBG0") throw new Error("not a CBG0 file");
  const n = dv.getUint32(36, true), e = dv.getUint32(40, true);
  let off = 44;
  for (let i = 0; i < n; i++) off += 2 + buf[off];
  const outStart = new Uint32Array(n + 1), outPost = new Uint32Array(e), weight = new Int32Array(e);
  hold((n + 1) * 4 + e * 8);
  let prevPre = -1, prevPost = -1;
  for (let k = 0; k < e; k++, off += 13) {
    const pre = dv.getUint32(off, true), post = dv.getUint32(off + 4, true);
    if (pre >= n || post >= n) throw new Error(`edge ${k} names node ${Math.max(pre, post)} of ${n}`);
    if (pre < prevPre || (pre === prevPre && post <= prevPost)) throw new Error(`edge ${k} is out of (pre, post) order`);
    prevPre = pre; prevPost = post;
    outStart[pre + 1]++;
    outPost[k] = post;
    weight[k] = dv.getUint32(off + 9, true);
  }
  for (let i = 0; i < n; i++) outStart[i + 1] += outStart[i];
  return { n, e, outStart, outPost, weight };
}

const hex64 = (v) => BigInt.asUintN(64, v).toString(16).padStart(16, "0");

// The snapshot, streamed: [u32 LE metaLen][JSON meta][engine memory]. The
// route sends gzip; the browser inflates a `content-encoding: gzip` body
// itself, and a body that still begins with the gzip magic goes through
// DecompressionStream. `onMeta(meta)` runs once the header is complete and
// returns the wasm memory that receives the image, grown exactly to the
// image as it arrives.
export async function streamSnapshot(url, onMeta) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status === 404 ? "the world no longer holds that snapshot" : `snapshot: ${r.status}`);
  if (!r.body) throw new Error("snapshot: no body stream");
  let body;
  {
    // peek the first two bytes for the gzip magic, then hand the first
    // chunk and the rest of the body on as one stream (a tee() of a fetch
    // body stalls in Chrome once a branch is cancelled)
    const raw = r.body.getReader();
    const first = await raw.read();
    const b = first.done ? null : first.value;
    const source = new ReadableStream({
      start(c) { if (b) c.enqueue(b); else c.close(); },
      async pull(c) { const { done, value } = await raw.read(); if (done) c.close(); else c.enqueue(value); },
      cancel() { return raw.cancel(); },
    });
    body = b && b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b ? source.pipeThrough(new DecompressionStream("gzip")) : source;
  }
  const reader = body.getReader();
  let head = new Uint8Array(0);      // bytes before the image is known
  let metaLen = -1, meta = null, mem = null;
  let offset = 0;                     // image bytes copied so far
  let pending = [], pendingLen = 0;   // inflated image bytes not yet copied
  let lastSaid = 0;
  const flush = () => {
    if (!pendingLen) return;
    const need = offset + pendingLen, have = mem.buffer.byteLength;
    if (need > have) {
      try { mem.grow(Math.ceil((need - have) / PAGE)); }
      catch { throw new Error(`the engine could not grow to ${fmtN(need)} bytes; not enough memory`); }
      hold(mem.buffer.byteLength - have);
    }
    const u8 = new Uint8Array(mem.buffer);
    for (const c of pending) { u8.set(c, offset); offset += c.length; }
    hold(-pendingLen);
    pending = []; pendingLen = 0;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    if (!meta) {
      const joined = new Uint8Array(head.length + chunk.length);
      joined.set(head); joined.set(chunk, head.length);
      head = joined;
      if (metaLen < 0 && head.length >= 4) metaLen = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true);
      if (metaLen < 0 || head.length < 4 + metaLen) continue;
      meta = JSON.parse(new TextDecoder().decode(head.subarray(4, 4 + metaLen)));
      mem = await onMeta(meta);
      chunk = head.subarray(4 + metaLen);
      head = null;
      if (!chunk.length) continue;
    }
    pending.push(chunk); pendingLen += chunk.length; hold(chunk.length);
    if (pendingLen >= FLUSH_BYTES) flush();
    if (offset + pendingLen - lastSaid > 32 << 20) { lastSaid = offset + pendingLen; say(`snapshot: ${(lastSaid / 1048576).toFixed(0)} MB into the engine`); }
  }
  if (!meta) throw new Error("the snapshot ended before its header");
  flush();
  return { meta, imageBytes: offset };
}

async function getJournal(api) {
  const r = await fetch(api + "/api/journal");
  if (!r.ok) throw new Error(`journal: ${r.status}`);
  return r.json();
}

onmessage = async (ev) => {
  const { api, cbg, nodes: nodesUrl, wasm, epoch: wantEpoch } = ev.data;
  const posted = wantEpoch !== undefined && wantEpoch !== null;
  let journal = ev.data.journal;
  const t0 = performance.now();
  try {
    say("fetching the canonical graph");
    const [cbgBytes, nodesDoc, wasmBytes] = await Promise.all([
      fetchBytes(api + cbg, "graph"),
      fetch(api + nodesUrl).then(r => { if (!r.ok) throw new Error("nodes " + r.status); return r.json(); }),
      fetchBytes(wasm, "engine"),
    ]);
    say("parsing the graph");
    const g = parseCbg(cbgBytes);
    hold(-cbgBytes.length);
    if (nodesDoc.nodes.length !== g.n) throw new Error(`node file has ${nodesDoc.nodes.length} nodes, graph has ${g.n}`);
    const roles = rolesFor(nodesDoc.nodes);
    hold(roles.length);

    say("instantiating the engine");
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    hold(-wasmBytes.length);
    const s = instance.exports;
    for (const name of ["world_alloc", "world_rederive", "event_ring", "node_count", "edge_count", "max_pop"]) {
      if (typeof s[name] !== "function") throw new Error(`this engine build has no ${name} export; rebuild site/instar_sim.wasm`);
    }

    // world_alloc is once per instance and needs the slot count, so the
    // header is read before the image streams over the slabs
    let allocatedBytes = 0;
    say(posted ? `fetching the world's snapshot before epoch ${wantEpoch}` : "fetching the world's latest snapshot");
    const { meta, imageBytes } = await streamSnapshot(api + "/api/snapshot" + (posted ? `?epoch=${wantEpoch}` : ""), (meta) => {
      if (meta.magic !== "instar-snap-2") throw new Error(`snapshot magic ${meta.magic}`);
      if (meta.nodes !== g.n || meta.edges !== g.e) throw new Error(`the snapshot was taken on a ${meta.nodes}-node, ${meta.edges}-edge graph; this page has ${g.n} and ${g.e}`);
      if (journal.seed !== meta.seed || journal.era !== meta.era) throw new Error(`the journal is seed ${journal.seed} era ${journal.era}, the snapshot seed ${meta.seed} era ${meta.era}`);
      if (!s.world_alloc(g.n, g.e, meta.maxPop)) throw new Error("the engine refused world_alloc");
      new Uint8Array(s.memory.buffer, s.role_ptr(), g.n).set(roles);
      new Uint32Array(s.memory.buffer, s.out_start_ptr(), g.n + 1).set(g.outStart);
      new Uint32Array(s.memory.buffer, s.out_post_ptr(), g.e).set(g.outPost);
      new Int32Array(s.memory.buffer, s.edge_weight_ptr(), g.e).set(g.weight);
      allocatedBytes = s.memory.buffer.byteLength;
      hold(allocatedBytes);
      say(`engine allocated (${(allocatedBytes / 1048576).toFixed(0)} MB); streaming the snapshot into it`);
      return s.memory;
    });
    // the image may be larger than a fresh instance (the world's allocator
    // grew while it ran); smaller, or not page-sized, means another build
    if (imageBytes % PAGE !== 0 || imageBytes < allocatedBytes) throw new Error(`the snapshot image is ${imageBytes} bytes, this engine's memory ${allocatedBytes}: different builds`);
    if (s.memory.buffer.byteLength !== imageBytes) throw new Error(`engine memory is ${s.memory.buffer.byteLength} bytes after the copy, the image ${imageBytes}`);

    // The image overwrote the slabs the graph was just written to. It must
    // carry the canonical graph, byte for byte, and its sizes must be the
    // ones this instance was allocated with; then the engine rebuilds its
    // derived tables from the slabs rather than trusting the image's.
    say("checking the restored graph against the canonical upload");
    if (s.node_count() !== g.n || s.edge_count() !== g.e || s.max_pop() !== meta.maxPop) throw new Error(`the restored engine reports ${s.node_count()} nodes, ${s.edge_count()} edges, ${s.max_pop()} slots; expected ${g.n}, ${g.e}, ${meta.maxPop}`);
    const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
    if (!same(new Uint8Array(s.memory.buffer, s.role_ptr(), g.n), roles)) throw new Error("the snapshot's node roles differ from the canonical roles");
    if (!same(new Uint32Array(s.memory.buffer, s.out_start_ptr(), g.n + 1), g.outStart)) throw new Error("the snapshot's graph offsets differ from the canonical graph");
    if (!same(new Uint32Array(s.memory.buffer, s.out_post_ptr(), g.e), g.outPost)) throw new Error("the snapshot's graph targets differ from the canonical graph");
    if (!same(new Int32Array(s.memory.buffer, s.edge_weight_ptr(), g.e), g.weight)) throw new Error("the snapshot's connection weights differ from the canonical graph");
    if (!s.world_rederive()) throw new Error("the engine refused to rederive its tables from the restored graph");
    const maxPop = s.max_pop();
    const uids = () => new Uint32Array(s.memory.buffer, s.uid_ptr(), maxPop);
    const snapshotTick = s.get_tick();
    if (snapshotTick !== meta.tick) throw new Error(`snapshot says tick ${meta.tick}, engine reads ${snapshotTick}`);

    // The boundary to hash at: for a retained pre-boundary image, its own
    // epoch; otherwise the next boundary at or after the snapshot that the
    // world has not posted yet, so the chain's next post is the comparison.
    const interval = journal.epochInterval;
    const lastPostedTick = journal.epochs.reduce((m, e) => Math.max(m, e.tick), 0);
    let boundary = Math.ceil(snapshotTick / interval) * interval;
    if (!posted) while (boundary <= lastPostedTick) boundary += interval;
    else if (boundary !== wantEpoch * interval) throw new Error(`the snapshot for epoch ${wantEpoch} is at tick ${fmtN(snapshotTick)}, not inside that epoch`);
    const epoch = boundary / interval;
    if (boundary - snapshotTick > interval * 4) throw new Error(`the snapshot is ${fmtN(boundary - snapshotTick)} ticks behind epoch ${epoch}; too far to replay here`);

    // replay: step at most DRAIN_CHUNK ticks at a time as the world does,
    // drain births into uids, apply the entries due at that tick, never
    // past what the journal has scheduled
    const RING = s.event_ring();
    let nextUid = meta.nextUid, lastEvHead = meta.lastEvHead ?? s.event_head();
    const drain = () => {
      const head = s.event_head();
      const n = head - lastEvHead;
      if (n <= 0) return;
      if (n > RING) throw new Error("the event ring wrapped; the replay stepped too far at once");
      const r = new Uint32Array(s.memory.buffer, s.event_ptr(), RING * 4), u = uids();
      for (let k = lastEvHead; k < head; k++) {
        const o = (k % RING) * 4;
        if (r[o + 1] === 1) u[r[o + 2]] = nextUid++;
      }
      lastEvHead = head;
    };
    const apply = (e) => {
      if (e.type === "cap") s.set_capacity(e.value);
      else if (e.type === "cull") s.int_kill(e.uid);
      else if (e.type === "provision") s.int_provision(e.uid);
      else if (e.type === "gen") s.spawn_founders(e.n);
    };
    let t = snapshotTick, lastSaid = 0, stepped = 0;
    const advance = (entries, target) => {
      while (t < target) {
        let stop = Math.min(target, t + DRAIN_CHUNK);
        for (const e of entries) if (e.tick > t && e.tick < stop) stop = e.tick;
        s.step(stop - t); stepped += stop - t;
        drain();
        for (const e of entries) if (e.tick === stop) apply(e);
        t = stop;
        if (performance.now() - lastSaid > 700) { lastSaid = performance.now(); say(`replaying: tick ${fmtN(t)} of ${fmtN(boundary)} (${(((t - snapshotTick) / (boundary - snapshotTick)) * 100).toFixed(0)}%)`); }
      }
    };
    const giveUp = performance.now() + JOURNAL_WAIT_MS;
    while (t < boundary) {
      // an input the world will schedule at tick T is in the journal by T - bufferTicks + 1
      const safe = Math.min(boundary, journal.tick + journal.bufferTicks - 1);
      if (safe > t) advance(journal.entries, safe);
      if (t < boundary) {
        if (performance.now() > giveUp) throw new Error(`the world did not reach tick ${fmtN(boundary)} within ten minutes; it is at ${fmtN(journal.tick)}`);
        say(`replayed to tick ${fmtN(t)}; waiting for the world to schedule inputs up to ${fmtN(boundary)} (it is at ${fmtN(journal.tick)})`);
        await new Promise(r => setTimeout(r, POLL_MS));
        journal = await getJournal(api);
        if (journal.seed !== meta.seed || journal.era !== meta.era) throw new Error("the world was reset while this replay was waiting for it");
      }
    }
    if (s.get_tick() !== boundary) throw new Error(`replay stopped at tick ${s.get_tick()}, not ${boundary}`);
    const hash = hex64(s.state_hash());
    postMessage({ type: "done", epoch, tick: boundary, hash, snapshotTick, ticks: stepped, ms: performance.now() - t0, peakBytes, imageBytes });
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
};
