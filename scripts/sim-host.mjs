// Boot the engine exactly the way the world process does: read the canonical
// CBG0 (edge table), the node file (roles), allocate the engine's slabs,
// upload the CSR and the roles, hand back the exports. Shared by every probe
// in scripts/ so they cannot drift from each other.

import * as fs from "fs";
import { loadNodes, rolesFor } from "./roles.mjs";

export const GRID = 128;
export const LAYERS = 16;
export const WASM_PATH = new URL("../site/instar_sim.wasm", import.meta.url);
export const CBG_PATH = new URL("../data/canonical/male-cns-v1.0.census.cbg", import.meta.url);
export const MAX_POP = 40;

/// Parse a CBG0 blob: header, node table (skipped by length), edge table as
/// typed columns. Edges are canonical order, sorted by (pre, post).
export function readCbg0(path = CBG_PATH) {
  const buf = fs.readFileSync(path);
  if (buf.toString("latin1", 0, 4) !== "CBG0") throw new Error("not a CBG0 file");
  const root = buf.toString("hex", 4, 36);
  const N = buf.readUInt32LE(36);
  const E = buf.readUInt32LE(40);
  let o = 44;
  for (let i = 0; i < N; i++) o += 1 + buf[o] + 1; // id_len, id, kind
  const pre = new Uint32Array(E), post = new Uint32Array(E), weight = new Int32Array(E);
  for (let k = 0; k < E; k++) {
    pre[k] = buf.readUInt32LE(o); post[k] = buf.readUInt32LE(o + 4); weight[k] = buf.readUInt32LE(o + 9);
    o += 13;
  }
  if (o !== buf.length) throw new Error(`CBG0 trailing bytes: ${buf.length - o}`);
  return { root, N, E, pre, post, weight };
}

/// CSR row starts from the pre column; throws if the edges are not sorted
/// by (pre, post), because then the CSR order would not be the canonical
/// (genome) order.
export function csrStarts(N, pre, post) {
  const start = new Uint32Array(N + 1);
  for (let k = 0; k < pre.length; k++) {
    if (k > 0 && (pre[k] < pre[k - 1] || (pre[k] === pre[k - 1] && post[k] < post[k - 1]))) throw new Error(`edge ${k} out of (pre, post) order`);
    start[pre[k] + 1]++;
  }
  for (let i = 0; i < N; i++) start[i + 1] += start[i];
  return start;
}

let graph = null;
export function graphOnce() {
  if (!graph) {
    const g = readCbg0();
    const nodes = loadNodes();
    if (nodes.node_count !== g.N || nodes.nodes.length !== g.N) throw new Error(`nodes.json (${nodes.nodes.length}) and CBG0 (${g.N}) disagree on node count`);
    if (nodes.root_sha256 !== g.root) throw new Error("nodes.json and CBG0 carry different Merkle roots");
    graph = { ...g, start: csrStarts(g.N, g.pre, g.post), roles: rolesFor(nodes.nodes) };
  }
  return graph;
}

export async function boot(maxPop = MAX_POP, wasmBytes = fs.readFileSync(WASM_PATH)) {
  const g = graphOnce();
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const sim = instance.exports;
  const mem = () => sim.memory.buffer;
  if (sim.world_alloc(g.N, g.E, maxPop) !== 1) throw new Error(`world_alloc(${g.N}, ${g.E}, ${maxPop}) refused`);
  new Uint8Array(mem(), sim.role_ptr(), g.N).set(g.roles);
  new Uint32Array(mem(), sim.out_start_ptr(), g.N + 1).set(g.start);
  new Uint32Array(mem(), sim.out_post_ptr(), g.E).set(g.post);
  new Int32Array(mem(), sim.edge_weight_ptr(), g.E).set(g.weight);
  const N = g.N, E = g.E, P = maxPop;
  const POSE = sim.pose_len(), GROUPS = sim.fire_groups(), RING = sim.event_ring();
  const view = {
    alive: () => new Uint8Array(mem(), sim.alive_ptr(), P),
    x: () => new Int32Array(mem(), sim.x_ptr(), P),
    y: () => new Int32Array(mem(), sim.y_ptr(), P),
    z: () => new Int32Array(mem(), sim.z_ptr(), P),
    heading: () => new Uint16Array(mem(), sim.heading_ptr(), P),
    energy: () => new Int32Array(mem(), sim.energy_ptr(), P),
    age: () => new Uint32Array(mem(), sim.age_ptr(), P),
    eaten: () => new Uint32Array(mem(), sim.eaten_ptr(), P),
    ateLast: () => new Int32Array(mem(), sim.ate_last_ptr(), P),
    hormone: () => new Uint32Array(mem(), sim.hormone_ptr(), P),
    pose: () => new Int16Array(mem(), sim.pose_ptr(), P * POSE),
    firedCount: () => new Uint32Array(mem(), sim.fired_count_ptr(), P * GROUPS),
    fired: () => new Uint8Array(mem(), sim.fired_ptr(), P * N),
    food: () => new Int32Array(mem(), sim.food_ptr(), GRID * GRID),
    biome: () => new Uint8Array(mem(), sim.biome_ptr(), GRID * GRID),
    height: () => new Uint8Array(mem(), sim.height_ptr(), GRID * GRID),
    moisture: () => new Uint8Array(mem(), sim.moisture_ptr(), GRID * GRID),
    odor: () => new Int32Array(mem(), sim.odor_ptr(), GRID * GRID),
    genome: () => new Int16Array(mem(), sim.genome_ptr(), P * E),
    events: () => new Uint32Array(mem(), sim.event_ptr(), RING * 4),
  };
  return { sim, mem, view, N, E, P, POSE, GROUPS, RING, roles: g.roles };
}

export const cellOf = (x, y) => {
  const cx = Math.min(GRID - 1, Math.max(0, x >> 16));
  const cy = Math.min(GRID - 1, Math.max(0, y >> 16));
  return cy * GRID + cx;
};
// wasm u64 returns arrive as signed BigInt; this is the unsigned value
export const u64 = (v) => BigInt.asUintN(64, v);

export const BIOME = ["FLOOR", "YEAST", "BANANA", "WATER", "SALT"];
export const GROUP = ["any", "sens", "dn", "legL", "legR", "wingP", "wingS", "haltere", "prob", "neuro", "an", "other"];
export const EVENT = ["", "birth", "death", "lights_off", "bloom", "dry_spell", "mature", "takeoff", "landing"];
export const SEED = 0x494e535441n; // "INSTA"
// The world process steps the engine at this rate (services/world/index.mts
// TICKRATE); every per-hour figure a probe prints is at this rate.
export const TICKRATE = 10;

/// A probe's published numbers, one line the gate runner collects into
/// site/measurements.json: `{label, value, unit?, horizon}` each, the horizon
/// stated with every value.
export function measure(items) {
  console.log(`MEASURE ${JSON.stringify(items)}`);
}
