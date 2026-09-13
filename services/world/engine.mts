// The engine host. Loads instar_sim.wasm, uploads the census (roles, edges,
// weights) and exposes typed views over the engine's exported pointers.
//
// Views are re-created on demand because WASM memory can grow, and a growth
// detaches every ArrayBuffer view taken before it.

import * as fs from "fs";
import { rolesFor, type CensusNode } from "./roles.mts";

export type Census = {
  nodes: CensusNode[];
  edges: { pre: string; post: string; weight: number }[];
};

export const EVENT = { BIRTH: 1, DEATH: 2, FLOOD: 3, BLOOM: 4, DRY_SPELL: 5, MOLT: 6 } as const;
/// Death causes as the engine reports them in `b` of a death event.
export const CAUSE_NAME: Record<number, string> = {
  1: "starved", 2: "senescence", 3: "killed", 4: "desiccated", 5: "drowned", 6: "culled",
};
export const NO_PARENT = 0xff;
export const EVENT_RING = 256;

type Exports = {
  memory: WebAssembly.Memory;
  role_ptr(): number; edge_pre_ptr(): number; edge_post_ptr(): number; edge_weight_ptr(): number;
  food_ptr(): number; moisture_ptr(): number; biome_ptr(): number; genome_ptr(): number;
  age_ptr(): number; alive_ptr(): number; x_ptr(): number; y_ptr(): number; heading_ptr(): number;
  energy_ptr(): number; generation_ptr(): number; lineage_ptr(): number; bend_ptr(): number;
  fired_ptr(): number; eaten_ptr(): number; fed_ptr(): number; ecdysone_ptr(): number;
  event_ptr(): number; event_head(): number; uid_ptr(): number;
  nseg(): number; max_nodes(): number; max_edges(): number; max_pop(): number; grid(): number;
  dish_radius(): number; light_now(): number; temp_now(): number; biome_foodcap(b: number): number;
  get_tick(): number; pop_count(): number; births_total(): number; deaths_total(): number;
  kills_total(): number; max_generation(): number; state_hash(): bigint; creature_genome_hash(slot: number): bigint;
  world_init(seed: bigint, nodes: number, edges: number, startPop: number): void;
  step(ticks: number): void; set_capacity(c: number): void; spawn_founders(n: number): void;
  int_provision(uid: number): void; int_kill(uid: number): void;
  int_yeast_bloom(cx: number, cy: number): void; int_dry_spell(): void; int_flood(): void;
};

export type SimEvent = { tick: number; kind: number; a: number; b: number };

export class Engine {
  readonly sim: Exports;
  readonly maxPop: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly nseg: number;
  readonly grid: number;
  readonly nodeCount: number;
  readonly edgeCount: number;

  private constructor(sim: Exports, census: Census) {
    this.sim = sim;
    this.maxPop = sim.max_pop();
    this.maxNodes = sim.max_nodes();
    this.maxEdges = sim.max_edges();
    this.nseg = sim.nseg();
    this.grid = sim.grid();
    this.nodeCount = census.nodes.length;
    this.edgeCount = census.edges.length;
    if (this.nodeCount > this.maxNodes || this.edgeCount > this.maxEdges) {
      throw new Error(`census (${this.nodeCount} nodes, ${this.edgeCount} edges) exceeds engine capacity (${this.maxNodes}/${this.maxEdges})`);
    }
    this.upload(census);
  }

  static async load(wasmPath: string, census: Census): Promise<Engine> {
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    return new Engine(instance.exports as unknown as Exports, census);
  }

  /// Roles, edges and weights go into the engine's static arrays before
  /// world_init, which builds the CSR from them.
  private upload(census: Census) {
    const index = new Map<string, number>();
    census.nodes.forEach((n, i) => index.set(n.id, i));
    this.u8(this.sim.role_ptr(), this.maxNodes).set(rolesFor(census.nodes));
    const pre = this.u16(this.sim.edge_pre_ptr(), this.maxEdges);
    const post = this.u16(this.sim.edge_post_ptr(), this.maxEdges);
    const wts = this.i32(this.sim.edge_weight_ptr(), this.maxEdges);
    census.edges.forEach((e, i) => {
      const a = index.get(e.pre), b = index.get(e.post);
      if (a === undefined || b === undefined) throw new Error(`edge ${i} references an unknown node`);
      pre[i] = a; post[i] = b; wts[i] = e.weight;
    });
  }

  init(seed: bigint, startPop: number) {
    this.sim.world_init(seed, this.nodeCount, this.edgeCount, startPop);
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
  get ecdysone() { return this.u32(this.sim.ecdysone_ptr(), this.maxPop); }
  get x() { return this.i32(this.sim.x_ptr(), this.maxPop); }
  get y() { return this.i32(this.sim.y_ptr(), this.maxPop); }
  get heading() { return this.u16(this.sim.heading_ptr(), this.maxPop); }
  get bend() { return this.i16(this.sim.bend_ptr(), this.maxPop * this.nseg); }
  get fired() { return this.u8(this.sim.fired_ptr(), this.maxPop * this.maxNodes); }
  get genome() { return this.i16(this.sim.genome_ptr(), this.maxPop * this.maxEdges); }
  get food() { return this.i32(this.sim.food_ptr(), this.grid * this.grid); }
  get moisture() { return this.u8(this.sim.moisture_ptr(), this.grid * this.grid); }
  get biome() { return this.u8(this.sim.biome_ptr(), this.grid * this.grid); }
  get events() { return this.u32(this.sim.event_ptr(), EVENT_RING * 4); }

  // ---- scalars --------------------------------------------------------------

  get tick() { return this.sim.get_tick() >>> 0; }
  get eventHead() { return this.sim.event_head() >>> 0; }
  get popCount() { return this.sim.pop_count(); }
  get maxGeneration() { return this.sim.max_generation(); }
  get births() { return this.sim.births_total(); }
  get deaths() { return this.sim.deaths_total(); }
  get kills() { return this.sim.kills_total(); }
  stateHash(): bigint { return BigInt.asUintN(64, this.sim.state_hash()); }
  genomeHash(slot: number): bigint { return BigInt.asUintN(64, this.sim.creature_genome_hash(slot)); }

  step(n: number) { this.sim.step(n); }
  setCapacity(c: number) { this.sim.set_capacity(c); }
  spawnFounders(n: number) { this.sim.spawn_founders(n); }
  provision(uid: number) { this.sim.int_provision(uid); }
  kill(uid: number) { this.sim.int_kill(uid); }

  /// Events since `from` (an event_head value). Throws on ring overflow: a
  /// host that missed events cannot keep identity in step with the engine.
  eventsSince(from: number): SimEvent[] {
    const head = this.eventHead;
    if (head === from) return [];
    if (head - from > EVENT_RING) throw new Error(`event ring overflow (${head - from} unread)`);
    const ring = this.events;
    const out: SimEvent[] = [];
    for (let k = from; k < head; k++) {
      const o = (k % EVENT_RING) * 4;
      out.push({ tick: ring[o], kind: ring[o + 1], a: ring[o + 2], b: ring[o + 3] });
    }
    return out;
  }

  slotOf(uid: number): number {
    const alive = this.alive, uids = this.uid;
    for (let s = 0; s < this.maxPop; s++) if (alive[s] && uids[s] === uid) return s;
    return -1;
  }

  /// The whole memory image, for snapshots and the mirror.
  snapshot(): Buffer {
    return Buffer.from(new Uint8Array(this.memory));
  }

  /// Restore a memory image taken from the same build. Sizes must match; a
  /// different build (or a grown memory) is refused rather than aliased.
  restore(image: Uint8Array): boolean {
    if (image.byteLength !== this.memory.byteLength) return false;
    new Uint8Array(this.memory).set(image);
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
