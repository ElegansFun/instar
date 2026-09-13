// Verification worker: the engine, run once, on purpose. Loads the canonical
// graph (CBG0) and node file, hands the engine the same roles the world
// process uses, restores the world's latest snapshot, replays the journal's
// host inputs to the next posted epoch boundary exactly as the world does,
// and posts the state hash back. The page compares it with the journal and
// with the World account. Nothing here is shown as animation; it is a check.
import { rolesFor } from "./roles.js";

const say = (text) => postMessage({ type: "status", text });
const fail = (text) => postMessage({ type: "error", text });

async function fetchBytes(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label}: ${r.status}`);
  const total = Number(r.headers.get("content-length")) || 0;
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0, lastSaid = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (got - lastSaid > 8 << 20) { lastSaid = got; say(`${label}: ${(got / 1048576).toFixed(0)}${total ? ` of ${(total / 1048576).toFixed(0)}` : ""} MB`); }
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
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

onmessage = async (ev) => {
  const { api, cbg, nodes: nodesUrl, wasm, journal } = ev.data;
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
    if (nodesDoc.nodes.length !== g.n) throw new Error(`node file has ${nodesDoc.nodes.length} nodes, graph has ${g.n}`);
    const roles = rolesFor(nodesDoc.nodes);

    say("fetching the world's snapshot");
    const snap = await fetchBytes(api + "/api/snapshot", "snapshot");
    const metaLen = new DataView(snap.buffer, snap.byteOffset, 4).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(snap.subarray(4, 4 + metaLen)));
    const image = snap.subarray(4 + metaLen);
    if (meta.nodes !== g.n || meta.edges !== g.e) throw new Error(`the snapshot was taken on a ${meta.nodes}-node, ${meta.edges}-edge graph; this page has ${g.n} and ${g.e}`);

    say("instantiating the engine");
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const s = instance.exports;
    if (!s.world_alloc(g.n, g.e, meta.maxPop)) throw new Error("the engine refused world_alloc");
    new Uint8Array(s.memory.buffer, s.role_ptr(), g.n).set(roles);
    new Uint32Array(s.memory.buffer, s.out_start_ptr(), g.n + 1).set(g.outStart);
    new Uint32Array(s.memory.buffer, s.out_post_ptr(), g.e).set(g.outPost);
    new Int32Array(s.memory.buffer, s.edge_weight_ptr(), g.e).set(g.weight);
    // the image may be larger than a fresh instance (the world's allocator
    // grew while it ran); smaller, or not page-sized, means another build
    const PAGE = 65536, have = s.memory.buffer.byteLength;
    if (image.length % PAGE !== 0 || image.length < have) throw new Error(`the snapshot image is ${image.length} bytes, this engine's memory ${have}: different builds`);
    if (image.length > have) s.memory.grow((image.length - have) / PAGE);
    new Uint8Array(s.memory.buffer).set(image);
    const maxPop = s.max_pop();
    const uids = () => new Uint32Array(s.memory.buffer, s.uid_ptr(), maxPop);
    const snapshotTick = s.get_tick();
    if (snapshotTick !== meta.tick) throw new Error(`snapshot says tick ${meta.tick}, engine reads ${snapshotTick}`);

    // the epoch to check: the first posted boundary after the snapshot
    const target = journal.epochs.map(e => e).sort((a, b) => a.tick - b.tick).find(e => e.tick > snapshotTick);
    if (!target) throw new Error(`the snapshot (tick ${snapshotTick.toLocaleString("en-US")}) is newer than every posted epoch; try again after the next epoch is posted`);
    if (target.tick - snapshotTick > journal.epochInterval * 4) throw new Error(`the snapshot is ${(target.tick - snapshotTick).toLocaleString("en-US")} ticks behind epoch ${target.epoch}; too far to replay here`);

    // replay: step to each entry tick in order, drain births into uids,
    // apply the entries, until the boundary
    let nextUid = meta.nextUid, lastEvHead = meta.lastEvHead ?? s.event_head();
    const ring = () => new Uint32Array(s.memory.buffer, s.event_ptr(), 256 * 4);
    const drain = () => {
      const head = s.event_head();
      let n = head - lastEvHead;
      if (n <= 0) return;
      if (n > 256) throw new Error("the event ring wrapped; the replay stepped too far at once");
      const r = ring(), u = uids();
      for (let k = lastEvHead; k < head; k++) {
        const o = (k % 256) * 4;
        if (r[o + 1] === 1) u[r[o + 2]] = nextUid++;
      }
      lastEvHead = head;
    };
    const entries = journal.entries.filter(e => e.tick > snapshotTick && e.tick <= target.tick).sort((a, b) => a.tick - b.tick);
    let t = snapshotTick, ei = 0, lastSaid = 0;
    while (t < target.tick) {
      const stop = ei < entries.length ? Math.min(target.tick, entries[ei].tick) : target.tick;
      while (t < stop) {
        const c = Math.min(64, stop - t);
        s.step(c); t += c;
        drain();
        if (performance.now() - lastSaid > 700) { lastSaid = performance.now(); say(`replaying: tick ${t.toLocaleString("en-US")} of ${target.tick.toLocaleString("en-US")} (${(((t - snapshotTick) / (target.tick - snapshotTick)) * 100).toFixed(0)}%)`); }
      }
      for (; ei < entries.length && entries[ei].tick === t; ei++) {
        const e = entries[ei];
        if (e.type === "cap") s.set_capacity(e.value);
        else if (e.type === "cull") s.int_kill(e.uid);
        else if (e.type === "provision") s.int_provision(e.uid);
        else if (e.type === "gen") { s.spawn_founders(e.n); drain(); }
      }
    }
    if (s.get_tick() !== target.tick) throw new Error(`replay stopped at tick ${s.get_tick()}, not ${target.tick}`);
    const hash = hex64(s.state_hash());
    postMessage({ type: "done", epoch: target.epoch, tick: target.tick, hash, snapshotTick, ticks: target.tick - snapshotTick, ms: performance.now() - t0 });
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
};
