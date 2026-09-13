// Boot the engine exactly the way the world process and the browser do: load
// the canonical census, upload the graph and the roles, hand back the exports.
// Shared by every probe in scripts/ so they cannot drift from each other.

import * as fs from "fs";
import { loadCensus, rolesFor } from "./roles.mjs";

export const GRID = 128;
export const WASM_PATH = new URL("../site/instar_sim.wasm", import.meta.url);

let census = null;
export function censusOnce() {
  if (!census) census = loadCensus();
  return census;
}

export async function boot() {
  const c = censusOnce();
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(WASM_PATH), {});
  const sim = instance.exports;
  const mem = () => sim.memory.buffer;
  const N = c.nodes.length;
  const E = c.edges.length;
  if (N > sim.max_nodes() || E > sim.max_edges()) throw new Error(`census exceeds engine capacity: ${N} nodes / ${E} edges`);
  const idx = new Map(c.nodes.map((n, i) => [n.id, i]));
  new Uint8Array(mem(), sim.role_ptr(), sim.max_nodes()).set(rolesFor(c.nodes));
  const pre = new Uint16Array(mem(), sim.edge_pre_ptr(), sim.max_edges());
  const post = new Uint16Array(mem(), sim.edge_post_ptr(), sim.max_edges());
  const wts = new Int32Array(mem(), sim.edge_weight_ptr(), sim.max_edges());
  c.edges.forEach((e, i) => {
    const a = idx.get(e.pre), b = idx.get(e.post);
    if (a === undefined || b === undefined) throw new Error(`census edge ${i} references unknown node ${a === undefined ? e.pre : e.post}`);
    pre[i] = a;
    post[i] = b;
    wts[i] = e.weight;
  });
  const P = sim.max_pop();
  const MAXN = sim.max_nodes();
  const view = {
    alive: () => new Uint8Array(mem(), sim.alive_ptr(), P),
    x: () => new Int32Array(mem(), sim.x_ptr(), P),
    y: () => new Int32Array(mem(), sim.y_ptr(), P),
    heading: () => new Uint16Array(mem(), sim.heading_ptr(), P),
    energy: () => new Int32Array(mem(), sim.energy_ptr(), P),
    eaten: () => new Uint32Array(mem(), sim.eaten_ptr(), P),
    ateLast: () => new Int32Array(mem(), sim.ate_last_ptr(), P),
    ecdysone: () => new Uint32Array(mem(), sim.ecdysone_ptr(), P),
    fired: () => new Uint8Array(mem(), sim.fired_ptr(), P * MAXN),
    food: () => new Int32Array(mem(), sim.food_ptr(), GRID * GRID),
    biome: () => new Uint8Array(mem(), sim.biome_ptr(), GRID * GRID),
    moisture: () => new Uint8Array(mem(), sim.moisture_ptr(), GRID * GRID),
    genome: () => new Int16Array(mem(), sim.genome_ptr(), P * sim.max_edges()),
    events: () => new Uint32Array(mem(), sim.event_ptr(), 256 * 4),
  };
  return { sim, mem, view, N, E, P, MAXN, roles: rolesFor(c.nodes) };
}

export const cellOf = (x, y) => {
  const cx = Math.min(GRID - 1, Math.max(0, x >> 16));
  const cy = Math.min(GRID - 1, Math.max(0, y >> 16));
  return cy * GRID + cx;
};
// wasm u64 returns arrive as signed BigInt; this is the unsigned value
export const u64 = (v) => BigInt.asUintN(64, v);

export const BIOME = ["WALL", "AGAR", "YEAST", "FRUIT", "DRY", "POOL", "LIT", "RIM"];
export const SEED = 0x494e535441n; // "INSTA"
