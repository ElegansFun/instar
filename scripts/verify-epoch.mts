// The public verification path: replay the world to an epoch boundary on
// this machine and compare the hash with what the World account holds.
//
//   npm run verify:epoch -- [--world http://host:8787] [--rpc URL] [--post] [--next]
//
// Two starting points, both an engine memory image with a JSON header:
//
//   - the epoch the chain holds now: the world keeps the image it took a
//     minute before each of its last two boundaries, /api/snapshot?epoch=N
//     serves it, and the replay from it to the boundary is compared with
//     the account at once. The default whenever the posted epoch is retained.
//   - the latest image: /api/snapshot is the world's five-minute image at
//     some tick S. If S is at or before the boundary the chain holds, the
//     replay runs to that boundary and is compared at once; otherwise it
//     runs to the next boundary B >= S, polling /api/journal for the inputs
//     as they are scheduled, and waits (up to CHAIN_WAIT_MS) for the world
//     to post epoch B. `--next` always takes the first boundary the chain
//     has not posted, so the waiting path is exercised.
//
// Either way the same instar_sim.wasm is booted over the same canonical
// graph (data/canonical/*.cbg + nodes.json, the files the world itself
// reads), the image is checked against that graph as it is restored, and
// every journaled input is applied exactly the way the world does
// (services/world/index.mts stepChunk: step, drain events, apply the entries
// due at that tick). The account is read raw at the offsets /api/config
// publishes, so VERIFIED means the chain agrees, not the server. With --post
// and INSTAR_ADMIN_TOKEN, the verdict is posted to /api/verifier for the
// site's status line; the server keeps the set of distinct verified epochs.
//
// Needs about 1.5 GB of memory (the inflated image and the engine at 40
// flies are each ~0.65 GB) and the repo checkout.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Connection, PublicKey } from "@solana/web3.js";
import { EVENT, Engine, NO_PARENT, hashHex, loadGraph } from "../services/world/engine.mts";
import type { Entry } from "../services/world/journal.mts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASE = (opt("--world") ?? process.env.INSTAR_URL ?? "http://localhost:8787").replace(/\/$/, "");
const POST = args.includes("--post");
const FORCE_NEXT = args.includes("--next");
const ADMIN_TOKEN = process.env.INSTAR_ADMIN_TOKEN ?? "";
const DRAIN_CHUNK = 128;
const POLL_MS = 5000;
const CHAIN_WAIT_MS = 10 * 60_000;

const log = (line: string) => console.log(`[verify-epoch] ${line}`);
const fail = (line: string): never => { console.error(`[verify-epoch] ${line}`); process.exit(1); };

async function getJson(route: string): Promise<any> {
  const res = await fetch(BASE + route);
  if (!res.ok) fail(`${route}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---- what the world says about itself
const cfg = await getJson("/api/config");
const layout = cfg.world;
if (!layout?.lastStateHash || layout.lastStateHash.size !== 32) fail(`/api/config carries no World layout: ${JSON.stringify(layout)}`);
const EPOCH_INTERVAL: number = cfg.epochInterval;
const rpcUrl = opt("--rpc") ?? process.env.INSTAR_RPC ?? cfg.rpc;
const rpc = new Connection(rpcUrl, "confirmed");
const worldPda = new PublicKey(cfg.worldPda);
log(`world ${BASE}  cluster ${cfg.cluster}  program ${cfg.programId}  World ${cfg.worldPda}  rpc ${rpcUrl}`);
log(`brain ${cfg.nodes} neurons, ${cfg.edges} connections; epoch every ${EPOCH_INTERVAL} ticks`);

// ---- the chain: the raw World account at the published offsets
type OnChain = { lastEpoch: number; lastEpochTick: number; hash: string };
async function readWorld(): Promise<OnChain> {
  const info = await rpc.getAccountInfo(worldPda, "confirmed");
  if (!info) fail(`World account ${cfg.worldPda} is not on chain at ${rpcUrl}`);
  const d = info!.data;
  const u64 = (f: { offset: number; size: number }) => Number(d.readBigUInt64LE(f.offset));
  return {
    lastEpoch: u64(layout.lastEpoch), lastEpochTick: u64(layout.lastEpochTick),
    hash: d.subarray(layout.lastStateHash.offset, layout.lastStateHash.offset + 32).toString("hex"),
  };
}
let onChain = await readWorld();
let journal = await getJson("/api/journal");

// ---- which image: the posted epoch's if the world kept it, else the latest
const retained: number[] = journal.snapshotEpochs ?? [];
const targetEpoch = !FORCE_NEXT && onChain.lastEpoch > 0 && retained.includes(onChain.lastEpoch) ? onChain.lastEpoch : 0;
log(`chain holds epoch ${onChain.lastEpoch} @tick ${onChain.lastEpochTick}; the world retains images for epoch(s) ${retained.join(", ") || "none"}` +
  (targetEpoch ? ` — replaying epoch ${targetEpoch} from its image` : ` — replaying from the latest image${FORCE_NEXT ? " to the next boundary (--next)" : ""}`));

// ---- the snapshot: fetch() inflates the gzip transfer encoding
const t0 = Date.now();
const snapRes = await fetch(BASE + (targetEpoch ? `/api/snapshot?epoch=${targetEpoch}` : "/api/snapshot"));
if (!snapRes.ok) fail(`/api/snapshot: ${snapRes.status} ${(await snapRes.text()).slice(0, 200)}`);
const snap = Buffer.from(await snapRes.arrayBuffer());
const metaLen = snap.readUInt32LE(0);
const meta = JSON.parse(snap.subarray(4, 4 + metaLen).toString());
const image = snap.subarray(4 + metaLen);
if (meta.magic !== "instar-snap-2") fail(`snapshot magic ${meta.magic}`);
if (meta.cluster !== cfg.cluster || meta.programId !== cfg.programId) fail(`snapshot is for ${meta.cluster}:${meta.programId}`);
if (targetEpoch && (meta.epoch !== targetEpoch || meta.tick >= targetEpoch * EPOCH_INTERVAL || meta.tick < (targetEpoch - 1) * EPOCH_INTERVAL)) {
  fail(`the epoch ${targetEpoch} image says epoch ${meta.epoch} tick ${meta.tick}`);
}
log(`snapshot @tick ${meta.tick}: ${(image.length / 1e6).toFixed(0)} MB image, ${meta.nextUid} flies named, fetched in ${Date.now() - t0} ms`);

// ---- the same engine over the same graph
const CANON = path.join(ROOT, "data", "canonical");
const graph = loadGraph(path.join(CANON, "male-cns-v1.0.census.cbg"), path.join(CANON, "male-cns-v1.0.nodes.json"));
if (graph.nodeCount !== meta.nodes || graph.edgeCount !== meta.edges) fail(`local graph is ${graph.nodeCount}/${graph.edgeCount}, the snapshot's is ${meta.nodes}/${meta.edges}`);
const engine = await Engine.load(path.join(ROOT, "site", "instar_sim.wasm"), graph, meta.maxPop);
// restore() checks the image against the canonical graph as it copies it:
// an image with a different connectome in it (or different derived tables)
// is refused here rather than replayed
try {
  if (!engine.restore(image)) fail(`the snapshot (${image.length} bytes) does not fit this engine build (${engine.memory.byteLength} bytes): rebuild site/instar_sim.wasm from the world's commit`);
} catch (e: any) {
  fail(`the snapshot is not an image of the canonical world: ${e.message}`);
}
if (engine.tick !== meta.tick) fail(`restored engine is at tick ${engine.tick}, snapshot says ${meta.tick}`);
const slotUid: number[] = meta.slotUid;
let nextUid: number = meta.nextUid;
let lastEvHead: number = meta.lastEvHead;
log(`engine restored: tick ${engine.tick}, pop ${engine.popCount}, ${(engine.heapBytes / 1e6).toFixed(0)} MB`);

// ---- the replay rule, as the world runs it
function drainEvents() {
  const uids = engine.uid;
  for (const ev of engine.eventsSince(lastEvHead)) {
    if (ev.kind === EVENT.BIRTH) {
      const uid = nextUid++;
      slotUid[ev.a] = uid;
      uids[ev.a] = uid;
      if (ev.b !== NO_PARENT && slotUid[ev.b] < 0) log(`birth ${uid} from an unnamed parent slot ${ev.b} — the snapshot predates it`);
    } else if (ev.kind === EVENT.DEATH) {
      slotUid[ev.a] = -1;
    }
  }
  lastEvHead = engine.eventHead;
}
const applyEntry = (e: Entry) => {
  if (e.type === "cap") engine.setCapacity(e.value);
  else if (e.type === "cull") engine.kill(e.uid);
  else if (e.type === "gen") engine.spawnFounders(e.n);
  else if (e.type === "provision") engine.provision(e.uid);
};
function advance(entries: Entry[], target: number) {
  let t = engine.tick;
  while (t < target) {
    let stop = Math.min(target, t + DRAIN_CHUNK);
    for (const e of entries) if (e.tick > t && e.tick < stop) stop = e.tick;
    engine.step(stop - t);
    drainEvents();
    for (const e of entries) if (e.tick === stop) applyEntry(e);
    t = stop;
  }
  return t;
}

// ---- the boundary: the posted one when the image predates it (the chain
// already holds the answer; a retained epoch image always does), else the
// image's next boundary, which the world has still to post. --next always
// takes the first boundary the chain has not posted.
const nextOfImage = Math.ceil(meta.tick / EPOCH_INTERVAL) * EPOCH_INTERVAL;
const boundary = FORCE_NEXT ? Math.max(nextOfImage, onChain.lastEpochTick + EPOCH_INTERVAL)
  : meta.tick <= onChain.lastEpochTick ? onChain.lastEpochTick : nextOfImage;
const epoch = boundary / EPOCH_INTERVAL;
if (journal.seed !== meta.seed || journal.era !== meta.era) fail(`journal is seed ${journal.seed} era ${journal.era}, snapshot is seed ${meta.seed} era ${meta.era}`);
log(`replaying tick ${engine.tick} -> ${boundary} (epoch ${epoch}); the journal is at tick ${journal.tick}, inputs scheduled ${journal.bufferTicks} ahead`);
const t1 = Date.now();
let stepped = 0;
while (engine.tick < boundary) {
  // an input the world will schedule at tick T is in the journal by T - bufferTicks + 1
  const safe = Math.min(boundary, journal.tick + journal.bufferTicks - 1);
  if (safe > engine.tick) {
    const from = engine.tick;
    advance(journal.entries, safe);
    stepped += engine.tick - from;
  }
  if (engine.tick < boundary) {
    await new Promise(r => setTimeout(r, POLL_MS));
    journal = await getJson("/api/journal");
  }
}
const ms = Date.now() - t1;
const hash = hashHex(engine.stateHash());
log(`replayed ${stepped} ticks in ${ms} ms (${stepped ? (ms / stepped).toFixed(2) : "0"} ms/tick), pop ${engine.popCount}: hash ${hash} at tick ${boundary}`);

// ---- the chain: for a posted boundary the read above is the word (the
// world may post the next one while the replay runs); an unposted one is
// read again and waited for
if (boundary > onChain.lastEpochTick) onChain = await readWorld();
const waitUntil = Date.now() + CHAIN_WAIT_MS;
while (onChain.lastEpochTick < boundary && Date.now() < waitUntil) {
  log(`chain holds epoch ${onChain.lastEpoch} @tick ${onChain.lastEpochTick}; waiting for tick ${boundary} to be posted`);
  await new Promise(r => setTimeout(r, POLL_MS));
  onChain = await readWorld();
}
if (onChain.lastEpochTick !== boundary) {
  // posted past it, or not at all in time: the epoch record in the journal
  // is this server's word, so it is reported but not what we compare with
  const rec = journal.epochs.find((e: any) => e.tick === boundary);
  fail(`the World account holds epoch ${onChain.lastEpoch} @tick ${onChain.lastEpochTick}, not tick ${boundary}` +
    (rec ? ` (the journal's own record of it: ${rec.hash}, ${rec.hash === hash ? "matches" : "DIFFERS FROM"} this replay)` : "") +
    ` — run again for the next epoch`);
}
const chainHash = onChain.hash.slice(-16);
const verdict = chainHash === hash ? "VERIFIED" : "MISMATCH";
console.log(`\n${verdict}: epoch ${onChain.lastEpoch} at tick ${boundary} — replayed ${hash}, World account ${chainHash} (${cfg.worldPda} on ${cfg.cluster})`);

if (POST) {
  if (!ADMIN_TOKEN) fail("--post needs INSTAR_ADMIN_TOKEN");
  const epochRec = journal.epochs.find((e: any) => e.tick === boundary);
  const res = await fetch(BASE + "/api/verifier", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ epoch: onChain.lastEpoch, hash, verdict, sig: epochRec?.sig ?? null }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) fail(`/api/verifier: ${res.status} ${body.error ?? ""}`);
  log(`posted: ${body.verifier.verdict} epoch ${body.verifier.epoch}; ${body.verifier.epochs.length} distinct epoch(s) verified (${body.verifier.epochs.join(", ")}), at ${body.verifier.at}`);
}
process.exit(verdict === "VERIFIED" ? 0 : 1);
