// The engine host. Loads instar_sim.wasm, reads the canonical graph (CBG0
// edge table + nodes.json roles), uploads it into the engine's slabs and
// exposes typed views over the exported pointers. The ABI is sim/ABI.md.
//
// Views are re-created on demand because WASM memory grows at world_alloc,
// and a growth detaches every ArrayBuffer view taken before it.

import * as fs from "fs";
import { rolesFor, type CensusNode } from "./roles.mts";

export const EVENT = { BIRTH: 1, DEATH: 2, LIGHTS_OFF: 3, BLOOM: 4, DRY_SPELL: 5, MATURE: 6, TAKEOFF: 7, LANDING: 8 } as const;
export const EVENT_NAME: Record<number, string> = {
  1: "birth", 2: "death", 3: "lights_off", 4: "bloom", 5: "dry_spell", 6: "mature", 7: "takeoff", 8: "landing",
};
/// Death causes as the engine reports them in `b` of a death event.
export const CAUSE_NAME: Record<number, string> = {
  1: "starved", 2: "senescence", 3: "killed", 4: "desiccated", 5: "drowned", 6: "culled", 7: "exhausted",
};
export const NO_PARENT = 0xff;
export const NO_UID = 0xffffffff;
/// Index of each firing counter at fired_count_ptr (sim/ABI.md).
export const FIRE_GROUP = { any: 0, sens: 1, dn: 2, legL: 3, legR: 4, wingP: 5, wingS: 6, haltere: 7, prob: 8, neuro: 9, an: 10, other: 11 } as const;
/// Index of each pose field at pose_ptr.
export const POSE = { MODE: 0, SURFACE: 1, PITCH: 2, ROLL: 3, WINGBEAT: 4, LEG0: 5, PROBOSCIS: 11 } as const;
export const BIOME_NAME: Record<number, string> = { 1: "yeast", 2: "banana", 3: "water", 4: "salt" };

type Exports = {
  memory: WebAssembly.Memory;
  world_alloc(nodes: number, edges: number, maxPop: number): number;
  world_init(seed: bigint, nodes: number, edges: number, maxPop: number, startPop: number): void;
  step(ticks: number): void;
  role_ptr(): number; out_start_ptr(): number; out_post_ptr(): number; edge_weight_ptr(): number;
  node_count(): number; edge_count(): number; max_pop(): number; grid(): number; layers(): number;
  pose_len(): number; fire_groups(): number; heap_bytes(): bigint;
  get_tick(): number; pop_count(): number; births_total(): number; deaths_total(): number; kills_total(): number; max_generation(): number;
  light_now(): number; temp_now(): number; lamp_on(): number; biome_foodcap(b: number): number;
  state_hash(): bigint; creature_genome_hash(slot: number): bigint; creature_genome_hash_full(slot: number): bigint;
  set_capacity(c: number): void;
  alive_ptr(): number; uid_ptr(): number; age_ptr(): number; energy_ptr(): number; generation_ptr(): number; lineage_ptr(): number;
  eaten_ptr(): number; fed_ptr(): number; ate_last_ptr(): number; hormone_ptr(): number;
  x_ptr(): number; y_ptr(): number; z_ptr(): number; heading_ptr(): number; pose_ptr(): number;
  fired_ptr(): number; fired_count_ptr(): number; genome_ptr(): number;
  food_ptr(): number; biome_ptr(): number; height_ptr(): number; moisture_ptr(): number; odor_ptr(): number;
  dish_count(): number; dish_x(i: number): number; dish_y(i: number): number; dish_r(i: number): number; dish_kind(i: number): number;
  water_x(): number; water_y(): number; water_r(): number; lamp_x(): number; lamp_y(): number; salt_corner(): number;
  event_ptr(): number; event_head(): number; event_ring(): number;
  world_rederive(): number;
  spawn_founders(n: number): void; int_provision(uid: number): void; int_kill(uid: number): void;
  int_bloom(cx: number, cy: number): void; int_dry_spell(): void; int_lights_off(ticks: number): void;
};

export type SimEvent = { tick: number; kind: number; a: number; b: number };

/// The canonical graph as the engine takes it: CSR by presynaptic node in
/// canonical edge order, one role byte per node.
export type Graph = {
  root: string;
  nodeCount: number;
  edgeCount: number;
  outStart: Uint32Array;
  outPost: Uint32Array;
  weight: Int32Array;
  roles: Uint8Array;
};

export type NodesFile = { census_format: string; dataset_id: string; root_sha256: string; node_count: number; nodes: CensusNode[] };

/// Read a CBG0 file (docs/SCHEMA.md appendix, v0.2: u32 node indexes). The
/// node table must list exactly `nodes` in order: node i of the edge table is
/// nodes[i], and that is what gives it its role. Edges must be sorted by
/// (pre, post) so the CSR the engine builds is the canonical edge order.
export function readCbg0(file: string, nodes: CensusNode[]): Omit<Graph, "roles"> {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "CBG0") throw new Error(`${file}: not a CBG0 file`);
  const root = buf.toString("hex", 4, 36);
  const nodeCount = buf.readUInt32LE(36), edgeCount = buf.readUInt32LE(40);
  if (nodeCount !== nodes.length) throw new Error(`${file}: ${nodeCount} nodes in the CBG0, ${nodes.length} in nodes.json`);
  let off = 44;
  for (let i = 0; i < nodeCount; i++) {
    const len = buf[off];
    const id = buf.toString("ascii", off + 1, off + 1 + len);
    if (id !== nodes[i].id) throw new Error(`${file}: node ${i} is ${id} in the CBG0 and ${nodes[i].id} in nodes.json`);
    off += 2 + len;
  }
  if (buf.length !== off + edgeCount * 13) throw new Error(`${file}: expected ${off + edgeCount * 13} bytes for ${edgeCount} edges, got ${buf.length}`);
  const outStart = new Uint32Array(nodeCount + 1);
  const outPost = new Uint32Array(edgeCount);
  const weight = new Int32Array(edgeCount);
  let lastPre = -1, lastPost = -1;
  for (let e = 0; e < edgeCount; e++, off += 13) {
    const pre = buf.readUInt32LE(off), post = buf.readUInt32LE(off + 4);
    if (pre >= nodeCount || post >= nodeCount) throw new Error(`${file}: edge ${e} references node ${Math.max(pre, post)} of ${nodeCount}`);
    if (pre < lastPre || (pre === lastPre && post <= lastPost)) throw new Error(`${file}: edge ${e} (${pre}->${post}) is out of (pre, post) order`);
    lastPre = pre; lastPost = post;
    outStart[pre + 1]++;
    outPost[e] = post;
    weight[e] = buf.readUInt32LE(off + 9);
  }
  for (let n = 0; n < nodeCount; n++) outStart[n + 1] += outStart[n];
  return { root, nodeCount, edgeCount, outStart, outPost, weight };
}

export function loadGraph(cbgPath: string, nodesPath: string): Graph & { nodes: NodesFile } {
  const nodes: NodesFile = JSON.parse(fs.readFileSync(nodesPath, "utf8"));
  const g = readCbg0(cbgPath, nodes.nodes);
  if (nodes.root_sha256 !== g.root) throw new Error(`${nodesPath} is for census ${nodes.root_sha256.slice(0, 12)}…, the CBG0 is ${g.root.slice(0, 12)}…`);
  return { ...g, roles: rolesFor(nodes.nodes), nodes };
}

export type Dish = { kind: string; x: number; y: number; r: number; h: number };
export type Arena = {
  floor: number; layers: number; dishes: Dish[]; lamp: { x: number; y: number; z: number };
  temp: { cold: [number, number]; hot: [number, number] }; humidity: { dry: [number, number] };
};

const FIX = 65536;

export class Engine {
  readonly sim: Exports;
  readonly maxPop: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly grid: number;
  readonly layers: number;
  readonly poseLen: number;
  readonly fireGroups: number;
  readonly heapBytes: number;
  /// records the event ring holds; `eventsSince` refuses to fall further behind
  readonly eventRing: number;
  /// the canonical upload, kept so a restored image can be checked against it
  private readonly graph: Graph;

  private constructor(sim: Exports, graph: Graph, maxPop: number) {
    this.sim = sim;
    this.graph = graph;
    this.nodeCount = graph.nodeCount;
    this.edgeCount = graph.edgeCount;
    this.maxPop = maxPop;
    if (!sim.world_alloc(graph.nodeCount, graph.edgeCount, maxPop)) {
      throw new Error(`world_alloc(${graph.nodeCount}, ${graph.edgeCount}, ${maxPop}) refused`);
    }
    this.grid = sim.grid();
    this.layers = sim.layers();
    this.poseLen = sim.pose_len();
    this.fireGroups = sim.fire_groups();
    this.heapBytes = Number(sim.heap_bytes());
    this.eventRing = sim.event_ring();
    this.u8(sim.role_ptr(), this.nodeCount).set(graph.roles);
    this.u32(sim.out_start_ptr(), this.nodeCount + 1).set(graph.outStart);
    this.u32(sim.out_post_ptr(), this.edgeCount).set(graph.outPost);
    this.i32(sim.edge_weight_ptr(), this.edgeCount).set(graph.weight);
  }

  static async load(wasmPath: string, graph: Graph, maxPop: number): Promise<Engine> {
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    return new Engine(instance.exports as unknown as Exports, graph, maxPop);
  }

  init(seed: bigint, startPop: number) {
    this.sim.world_init(seed, this.nodeCount, this.edgeCount, this.maxPop, startPop);
  }

  // ---- views ----------------------------------------------------------------

  get memory(): ArrayBuffer { return this.sim.memory.buffer; }
  private u8(p: number, n: number) { return new Uint8Array(this.memory, p, n); }
  private u16(p: number, n: number) { return new Uint16Array(this.memory, p, n); }
  private i16(p: number, n: number) { return new Int16Array(this.memory, p, n); }
  private u32(p: number, n: number) { return new Uint32Array(this.memory, p, n); }
  private i32(p: number, n: number) { return new Int32Array(this.memory, p, n); }

  get alive() { return this.u8(this.sim.alive_ptr(), this.maxPop); }
  get uid() { return this.u32(this.sim.uid_ptr(), this.maxPop); }
  get age() { return this.u32(this.sim.age_ptr(), this.maxPop); }
  get energy() { return this.i32(this.sim.energy_ptr(), this.maxPop); }
  get generation() { return this.u32(this.sim.generation_ptr(), this.maxPop); }
  get lineage() { return this.u32(this.sim.lineage_ptr(), this.maxPop); }
  get eaten() { return this.u32(this.sim.eaten_ptr(), this.maxPop); }
  get fed() { return this.u32(this.sim.fed_ptr(), this.maxPop); }
  /// the role byte per node, as uploaded
  get roles() { return this.u8(this.sim.role_ptr(), this.nodeCount); }
  get hormone() { return this.u32(this.sim.hormone_ptr(), this.maxPop); }
  get x() { return this.i32(this.sim.x_ptr(), this.maxPop); }
  get y() { return this.i32(this.sim.y_ptr(), this.maxPop); }
  get z() { return this.i32(this.sim.z_ptr(), this.maxPop); }
  get heading() { return this.u16(this.sim.heading_ptr(), this.maxPop); }
  get pose() { return this.i16(this.sim.pose_ptr(), this.maxPop * this.poseLen); }
  get firedCount() { return this.u32(this.sim.fired_count_ptr(), this.maxPop * this.fireGroups); }
  /// one slot's row of fired flags, N bytes
  firedOf(slot: number) { return this.u8(this.sim.fired_ptr() + slot * this.nodeCount, this.nodeCount); }
  get food() { return this.i32(this.sim.food_ptr(), this.grid * this.grid); }
  get biome() { return this.u8(this.sim.biome_ptr(), this.grid * this.grid); }
  get events() { return this.u32(this.sim.event_ptr(), this.eventRing * 4); }

  // ---- scalars --------------------------------------------------------------

  get tick() { return this.sim.get_tick() >>> 0; }
  get eventHead() { return this.sim.event_head() >>> 0; }
  get popCount() { return this.sim.pop_count(); }
  get maxGeneration() { return this.sim.max_generation(); }
  get births() { return this.sim.births_total(); }
  get deaths() { return this.sim.deaths_total(); }
  get kills() { return this.sim.kills_total(); }
  get light() { return this.sim.light_now(); }
  get temp() { return this.sim.temp_now(); }
  stateHash(): bigint { return BigInt.asUintN(64, this.sim.state_hash()); }
  genomeHash(slot: number): bigint { return BigInt.asUintN(64, this.sim.creature_genome_hash(slot)); }
  genomeHashFull(slot: number): bigint { return BigInt.asUintN(64, this.sim.creature_genome_hash_full(slot)); }

  step(n: number) { this.sim.step(n); }
  setCapacity(c: number) { this.sim.set_capacity(c); }
  spawnFounders(n: number) { this.sim.spawn_founders(n); }
  provision(uid: number) { this.sim.int_provision(uid); }
  kill(uid: number) { this.sim.int_kill(uid); }

  /// 16.16 fixed point to cells
  static cells(v: number) { return v / FIX; }

  /// Fixed at world_init from the seed; read once the world exists.
  arena(): Arena {
    const s = this.sim;
    const dishes: Dish[] = [];
    for (let i = 0; i < s.dish_count(); i++) {
      dishes.push({ kind: BIOME_NAME[s.dish_kind(i)] ?? String(s.dish_kind(i)), x: s.dish_x(i), y: s.dish_y(i), r: s.dish_r(i), h: 1 });
    }
    dishes.push({ kind: "water", x: s.water_x(), y: s.water_y(), r: s.water_r(), h: 0 });
    const g = this.grid, corner = s.salt_corner();
    const dry: [number, number] = [corner & 1 ? g - 1 : 0, corner & 2 ? g - 1 : 0];
    const lampX = s.lamp_x();
    // the gradient runs across x, hot on the lamp's side
    const hot: [number, number] = [lampX >= g / 2 ? g - 1 : 0, g / 2];
    const cold: [number, number] = [lampX >= g / 2 ? 0 : g - 1, g / 2];
    return { floor: g, layers: this.layers, dishes, lamp: { x: lampX, y: s.lamp_y(), z: this.layers }, temp: { cold, hot }, humidity: { dry } };
  }

  /// Events since `from` (an event_head value). Throws on ring overflow: a
  /// host that missed events cannot keep identity in step with the engine.
  eventsSince(from: number): SimEvent[] {
    const head = this.eventHead;
    if (head === from) return [];
    if (head - from > this.eventRing) throw new Error(`event ring overflow (${head - from} unread)`);
    const ring = this.events;
    const out: SimEvent[] = [];
    for (let k = from; k < head; k++) {
      const o = (k % this.eventRing) * 4;
      out.push({ tick: ring[o], kind: ring[o + 1], a: ring[o + 2], b: ring[o + 3] });
    }
    return out;
  }

  slotOf(uid: number): number {
    const alive = this.alive, uids = this.uid;
    for (let s = 0; s < this.maxPop; s++) if (alive[s] && uids[s] === uid) return s;
    return -1;
  }

  /// Restore a memory image taken from the same build after the same
  /// world_alloc. The engine allocates nothing after world_alloc, so a live
  /// image is normally exactly this memory's size; a larger whole-page
  /// image (a build whose init did grow) is accepted by growing the memory
  /// first, since the image carries the allocator state that matches it.
  /// An image smaller than this memory, or not a whole number of pages, is
  /// from a different build or different sizes: returns false with nothing
  /// copied.
  ///
  /// The image is the operator's word, the graph is not: after the copy the
  /// engine's sizes must be the alloc sizes, the four graph slabs must be
  /// byte-for-byte the canonical upload, and the derived tables (role
  /// lists, normalisation, base digest) are rebuilt from those slabs by the
  /// engine, so a snapshot cannot smuggle an edited connectome into a
  /// replay. Any of those failing throws with the reason; the instance then
  /// holds the bad image and must be discarded.
  restore(image: Uint8Array): boolean {
    const PAGE = 65536;
    const have = this.memory.byteLength;
    if (image.byteLength % PAGE !== 0 || image.byteLength < have) return false;
    if (image.byteLength > have) this.sim.memory.grow((image.byteLength - have) / PAGE);
    new Uint8Array(this.memory).set(image);
    const s = this.sim;
    if (s.node_count() !== this.nodeCount || s.edge_count() !== this.edgeCount || s.max_pop() !== this.maxPop) {
      throw new Error(`image is a ${s.node_count()}/${s.edge_count()}/${s.max_pop()} world, this engine is ${this.nodeCount}/${this.edgeCount}/${this.maxPop}`);
    }
    const g = this.graph;
    const same = (name: string, ptr: number, canon: ArrayBufferView) => {
      const mine = Buffer.from(this.memory, ptr, canon.byteLength);
      if (!mine.equals(Buffer.from(canon.buffer, canon.byteOffset, canon.byteLength))) throw new Error(`image's ${name} slab differs from the canonical graph`);
    };
    same("role", s.role_ptr(), g.roles);
    same("out_start", s.out_start_ptr(), g.outStart);
    same("out_post", s.out_post_ptr(), g.outPost);
    same("edge_weight", s.edge_weight_ptr(), g.weight);
    if (s.world_rederive() !== 1) throw new Error("image's graph slabs fail the engine's CSR checks");
    return true;
  }
}

/// A 32-byte hash field for the program: the engine's u64 FNV, left-padded.
/// The record is honest that it is a 64-bit digest; the extra bytes are zero.
export function hash32(h: bigint): number[] {
  const out = new Array<number>(32).fill(0);
  let v = h;
  for (let i = 31; i >= 24; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

export function hashHex(h: bigint): string {
  return h.toString(16).padStart(16, "0");
}
