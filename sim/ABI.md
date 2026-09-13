# Instar engine ABI (`site/instar_sim.wasm`, `sim/src/lib.rs`)

Every export is a plain C function. Pointers are byte offsets into the
module's linear memory (`memory` export). Sizes are host-set at
`world_alloc`; there are no compile-time capacities. Integer math only: same
seed + same graph + same interrupts = bit-identical world in WASM and native.

## Lifecycle

```
world_alloc(n_nodes: u32, n_edges: u32, max_pop: u32) -> u32
```
Allocates every slab (graph, genomes, node state, population) inside linear
memory (engine-owned; Rust's allocator over `memory.grow`). Returns 1 on
success, 0 if `max_pop` is 0 or > 64 or a size is 0. Call once per
instance, before writing the graph. `heap_bytes()` reports the total.

After `world_alloc` the host writes the graph:

| pointer | type | len | contents |
|---|---|---|---|
| `role_ptr()` | u8 | N | role byte per node (scripts/roles.mjs) |
| `out_start_ptr()` | u32 | N+1 | CSR row starts by presynaptic node |
| `out_post_ptr()` | u32 | E | postsynaptic node of edge `e` (canonical edge order) |
| `edge_weight_ptr()` | i32 | E | published synapse count of edge `e` |

Canonical edge order is sorted by `(pre, post)`, so CSR order == canonical
order and the edge index is the genome index: `out_start[pre[e]] <= e <
out_start[pre[e]+1]`. The host derives `out_start` by counting the CBG0
`pre` column (a prefix sum); the engine checks `out_start[0] == 0`,
monotone, `out_start[N] == E`, every `out_post < N`, and traps otherwise.
Weights are stored as published; a weight beyond `+-8,192` (`W_CAP`, the
i16 genome's ceiling) would be clamped at genesis. None is: the largest
synapse count in the MaleCNS is 2,591.

```
world_init(seed: u64, n_nodes: u32, n_edges: u32, max_pop: u32, start_pop: u32)
```
Sizes must equal the `world_alloc` sizes (trap otherwise). Builds the role
lists and the genesis genome, generates the cage, spawns `start_pop` founders
(<= max_pop) together. Capacity defaults to 40 (`set_capacity`).

```
world_rederive() -> u32
```
Rebuilds every table derived from the four graph slabs (role lists, the
normalisation `norm`, the genesis-genome digest) and re-runs the CSR checks;
returns 1, or 0 without touching anything when the CSR is malformed. Writes
nothing `state_hash` covers, so it is harmless on a fresh world. A restore
calls it after verifying the slabs (see Snapshot / restore).

```
step(ticks: u32)
```

## Constants and scalars

| export | meaning |
|---|---|
| `node_count() -> u32`, `edge_count() -> u32`, `max_pop() -> u32` | the `world_alloc` sizes |
| `grid() -> u32` | 128: floor cells per side |
| `layers() -> u32` | 16: flight layers; `z` runs `0 .. layers << 16` |
| `pose_len() -> u32` | 12: i16 fields per animal at `pose_ptr` |
| `fire_groups() -> u32` | 12: u32 counters per animal at `fired_count_ptr` |
| `event_ring() -> u32` | 4,096: records in the event ring at `event_ptr` |
| `heap_bytes() -> u64` | bytes allocated by `world_alloc` |
| `get_tick() -> u32` | wraps |
| `pop_count()`, `births_total()`, `deaths_total()`, `kills_total()`, `max_generation()` | u32 |
| `light_now() -> u32` | ambient light 0..255 (day cycle x lamp state) |
| `temp_now() -> i32` | cage-centre temperature, centi-degrees C |
| `lamp_on() -> u32` | 1 unless `int_lights_off` is in force |
| `biome_foodcap(b: u32) -> i32` | food ceiling of substrate class `b` |
| `state_hash() -> u64` | replay anchor (see below) |
| `creature_genome_hash(slot) -> u64` | incremental genome digest of the slot |
| `creature_genome_hash_full(slot) -> u64` | same digest recomputed over all E weights (verification) |
| `set_capacity(c: u32)` | reproduction cap, clamped to max_pop |

## Population arrays (length `max_pop`, indexed by slot)

| pointer | type | meaning |
|---|---|---|
| `alive_ptr()` | u8 | 1 = occupied |
| `uid_ptr()` | u32 | host-assigned id (writable); `0xFFFFFFFF` = unassigned; not hashed |
| `age_ptr()` | u32 | ticks since birth |
| `energy_ptr()` | i32 | |
| `generation_ptr()`, `lineage_ptr()` | u32 | |
| `eaten_ptr()`, `fed_ptr()` | u32 | lifetime intake; keeper provisions (not hashed) |
| `ate_last_ptr()` | i32 | intake on the last tick |
| `hormone_ptr()` | u32 | neurosecretory spike accumulator (reproduction gate) |
| `x_ptr()`, `y_ptr()`, `z_ptr()` | i32 | 16.16 fixed point, grid-cell units; `x,y` in `[0, 128)`, `z` in `[0, 16]` |
| `heading_ptr()` | u16 | heading, 65,536 units per turn (0 = +x) |
| `genome_ptr()` | i16 | `max_pop x E` row-major; writable (probes zero it); host writes are not digested, `creature_genome_hash_full` recomputes |
| `active_count_ptr()` | u32 | nodes with nonzero neural state per slot (the engine's working set) |
| `pose_ptr()` | i16 | `max_pop x pose_len()` row-major, see below |
| `fired_ptr()` | u8 | `max_pop x N`, 1 = node fired on the last tick |
| `fired_count_ptr()` | u32 | `max_pop x fire_groups()`, firings on the last tick by group |

### Pose (`pose_ptr`, i16 x 12 per slot)

| index | field |
|---|---|
| 0 | mode: 0 walking, 1 flying |
| 1 | surface while walking: 0 floor, 1 wall x=0 (W), 2 wall x=128 (E), 3 wall y=0 (N), 4 wall y=128 (S), 5 ceiling; -1 when flying |
| 2 | pitch, heading units (i16: -16384 = nose down 90 deg) |
| 3 | roll/bank, heading units |
| 4 | wingbeat phase 0..65535 (u16 stored as i16; advances only in flight) |
| 5..10 | leg phases L1 L2 L3 R1 R2 R3, 0..255 (stride cycle) |
| 11 | proboscis extension 0..255 |

### Fired-count groups (`fired_count_ptr`, u32 x 12 per slot)

| index | group | roles |
|---|---|---|
| 0 | any | all |
| 1 | sens | 1..17 |
| 2 | dn | 40,41,42 |
| 3 | legL | 20,21,22 |
| 4 | legR | 23,24,25 |
| 5 | wingP | 26,27 |
| 6 | wingS | 28,29 |
| 7 | haltere | 30,31 |
| 8 | prob | 33 |
| 9 | neuro | 50 |
| 10 | an | 43 |
| 11 | other | everything else (incl. 32 neck, 34 abdomen, role 0) |

## Cage arrays

| pointer | type | len | meaning |
|---|---|---|---|
| `food_ptr()` | i32 | 128x128 | food per floor cell |
| `biome_ptr()` | u8 | 128x128 | substrate class: 0 FLOOR (the cage's cornmeal-agar medium: a thin, renewing meal), 1 YEAST (dish), 2 BANANA (dish), 3 WATER, 4 SALT (dry crust, bitter) |
| `height_ptr()` | u8 | 128x128 | surface height in layers (dishes are 1, else 0) |
| `moisture_ptr()` | u8 | 128x128 | humidity 0..255 |
| `odor_ptr()` | i32 | 128x128 | odour field on the floor (refreshed every 8 ticks); at height `z` the engine reads `odor * (16 - z) / 16` |

## Arena geometry (fixed at `world_init` from the seed)

| export | meaning |
|---|---|
| `dish_count() -> u32` | 4: two yeast, two banana |
| `dish_x(i)`, `dish_y(i)`, `dish_r(i)` -> u32 | centre cell and radius (cells) of dish `i`; every dish is 1 layer high |
| `dish_kind(i) -> u32` | substrate class (1 YEAST, 2 BANANA) |
| `water_x()`, `water_y()`, `water_r()` -> u32 | the water pool (floor level) |
| `lamp_x()`, `lamp_y()` -> u32 | lamp cell, mounted at the ceiling (z = 16) |
| `salt_corner() -> u32` | 0..3 = (x0,y0) (x1,y0) (x0,y1) (x1,y1): the dry salt-crust corner |

Temperature: `temp_now()` at the centre plus a linear gradient of +-300
centi-degrees across x, hot on the lamp's side. Humidity: 255 at the water
pool falling to 0 in the salt corner.

## Events (`event_ptr()` u32 x 4 x `event_ring()` ring, `event_head()` count)

`event_ring()` returns the ring length in records (4,096); record `k` is at
index `k % event_ring()`. A host that drains every 128 ticks has ~75x the
headroom of the peak measured at 40 flies (53 records per chunk).

Record `[tick, kind, a, b]`:

| kind | a | b |
|---|---|---|
| 1 birth | slot | parent slot or 255 (founder) |
| 2 death | slot | cause: 1 starved 2 senescence 3 killed 4 desiccated 5 drowned 6 culled 7 exhausted |
| 3 lights_off | 0 | ticks |
| 4 bloom | cx | cy |
| 5 dry_spell | 0 | 0 |
| 6 mature | slot | 0 (hormone gate reached) |
| 7 takeoff | slot | 0 |
| 8 landing | slot | surface |

## Interrupts (journaled host inputs)

```
spawn_founders(n)            int_provision(uid)   int_kill(uid)
int_bloom(cx, cy)            int_dry_spell()      int_lights_off(ticks)
```

## state_hash

FNV-1a over: tick, births, deaths, kills, next_lineage, capacity, rng,
lights-off timer, per live slot (position, heading, pitch, roll, mode,
surface, energy, age, generation, lineage, hormone, wingbeat, gait,
proboscis, wing rate, sensory memory, genome digest, and the neural state of
every node in the slot's touched list, combined order-independently), the
whole food grid, and every 7th cell of moisture, biome and the odour field
(the odour field is state between its 8-tick refreshes: the ORNs read it).
`uid`, `eaten`, `fed`, `pose` and `fired_count` are excluded (labels or
derived).

## Snapshot / restore

A snapshot is the raw linear memory. Restore into a fresh instance of the
same build after `world_alloc` with the same sizes and the canonical graph
upload (the image contains the allocator state and every slab pointer, so it
only fits a memory of the same byte length); no `world_init` is needed after
a restore. The image also carries the graph slabs and the tables derived
from them, so a verifier MUST NOT trust it for those: after the copy, check
`node_count()`, `edge_count()` and `max_pop()` against the alloc sizes,
compare the four slab views (`role_ptr`, `out_start_ptr`, `out_post_ptr`,
`edge_weight_ptr`) byte-for-byte with the canonical upload, and call
`world_rederive()` (refuse the image on 0) before stepping or hashing.

## Model constants measured on the MaleCNS (genesis genome, seed INSTA)

Threshold units: fire above 16,384; leak a quarter per tick; refractory 3
ticks; a potential under 1,024 snaps to rest. One synapse-spike is worth
1,024 before normalisation, so in a silent brain a single spike over
sixteen synapses fires its target. Recurrent input is scaled by
`norm / (norm + spikes last tick)` with `norm = max(32, N / 4096) = 40`
(the stated stand-in for inhibition; sensory afferents are not scaled), so
in the measured genesis regime (~1,750 spikes per fly-tick) a synapse-spike
is worth ~23: a single spike registers only over 45 synapses, fires its
target only over ~720, and a sustained input needs ~180 synapse-spikes per
tick. Genesis weights are the published counts (largest 2,591; the i16
ceiling `W_CAP` = 8,192 clamps nothing) and the input accumulator saturates
rather than wraps.

Measured by `scripts/sim-gates.mjs` (the numbers on the site come from the
same run, `site/measurements.json`): 8 founders over 8,000 ticks
(`sim-probe`): 1,754 spikes per fly-tick (787 sensory), leg MNs 26.4, wing
MNs 8.5 (power 1.76), proboscis 0.68, neurosecretory 0.04; feeding 9.0% of
fly-ticks, flying 9.6%, 97 takeoffs per fly-hour at the world's 10 ticks/s;
the zeroed line never feeds or flies and is extinct at tick 4,000. Takeoff
needs the smoothed wing-power rate to reach 4 spikes per tick (0.4% of
fly-ticks at genesis; at or above 3 for 6.1%), landing happens on contact
under 3. Over 12,000 ticks (`forage-probe`) the real line ends at 7 flies
(zeroed: 0) and leg MNs fire on 88.6% of its walking ticks (zeroed: 0%).
Working set per fly ~38k nodes; measured 2.8 ms per fly-tick on Node
(i7-14700K, 400 ticks at 40 flies, `sim-bench`), so 40 flies cost ~113 ms
per tick and the world caps its capacity by `floor(80 ms / ms-per-fly-tick)`
= 28 on that host. Engine memory 641 MB at 40 flies.
