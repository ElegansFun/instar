//! Instar world engine: deterministic life on an agar dish, each larva driven
//! by the Winding et al. 2023 first-instar Drosophila brain connectome.
//!
//! Rules of the crate:
//! - Integer math only. No floats anywhere: same seed + same genome set
//!   produces a bit-identical world on every platform (WASM in the site,
//!   native in the world process, any verifier).
//! - The genome IS the edge-weight vector of the registered canonical file,
//!   in canonical edge order. Generation zero runs the literal published
//!   synapse counts.
//! - The neuron model is threshold accumulate-and-fire over the real wiring
//!   (leak, refractory period). Everything the connectome does not give us
//!   (dynamics, neuromodulation, the ventral nerve cord, muscles) is a stated
//!   simplification: descending neurons are read as a left/right drive, the
//!   SEZ descending neurons as pharyngeal pumping, the ring-gland neurons as
//!   an ecdysone signal.
//!
//! The host writes the graph + role arrays into the exported buffers, calls
//! `world_init`, then `step`. Everything observable is exported as pointers
//! into linear memory. `state_hash` is the replay-verification anchor: the
//! number the world process posts on-chain each epoch.

#![allow(static_mut_refs)]

pub const MAX_NODES: usize = 3072;
pub const MAX_EDGES: usize = 131_072;
pub const MAX_POP: usize = 48;
pub const GRID: usize = 128;
/// Larval body segments for the rendered peristaltic wave: 3 thoracic + 8
/// abdominal.
pub const NSEG: usize = 11;
pub const FP: i32 = 16; // 16.16 fixed point, world coords in grid-cell units
pub const DISH_RADIUS: i32 = 60;
const DISH_CX: i32 = 64;
const DISH_CY: i32 = 64;

// roles (written by host from census fields; see scripts/roles.mjs)
pub const ROLE_NONE: u8 = 0;
pub const ROLE_ORN: u8 = 1;
pub const ROLE_GUST_EXT: u8 = 2;
pub const ROLE_GUST_PHAR: u8 = 3;
pub const ROLE_MECH: u8 = 4;
pub const ROLE_NOCI: u8 = 5;
pub const ROLE_THERMO_COLD: u8 = 6;
pub const ROLE_THERMO_WARM: u8 = 7;
pub const ROLE_VISUAL: u8 = 8;
pub const ROLE_PROPRIO: u8 = 9;
pub const ROLE_GUT: u8 = 10;
pub const ROLE_RESP: u8 = 11;
pub const ROLE_DN_L: u8 = 20;
pub const ROLE_DN_R: u8 = 21;
pub const ROLE_DN_C: u8 = 22;
pub const ROLE_DN_SEZ: u8 = 23;
pub const ROLE_RGN: u8 = 24;

// ---------------------------------------------------------------- neurons
const THRESH: i32 = 16_384;
const REFRACTORY: u8 = 3;
/// A synapse count of 1 is worth this much potential per presynaptic spike;
/// with a 1/16 leak per tick, a steady input `I` settles at `16 * I`, so a
/// node fires when its recent input averages above `THRESH / 16 = 1,024`.
/// A power of two so the multiply is a shift.
const SYN_GAIN: i32 = 1024;
/// The dataset records no synapse polarity, so every published weight is
/// read as excitatory, and the spectral radius of the weight matrix is 297:
/// at 1,024 per synapse any activity above 0.3% self-amplifies to the
/// refractory ceiling (measured: 607 spikes per larva-tick, every DN at
/// 23%). This is the stated simplification that stands in for inhibition:
/// recurrent input is scaled by `NORM / (NORM + spikes last tick)`, so the
/// brain settles where its own gain is about one and stays sensitive to
/// what the senses add. Sensory afferents are not scaled: the stimulus sets
/// them. Uniform, it claims nothing about which neurons are inhibitory.
const NORM_SPIKES: i32 = 32;
/// Hard ceiling on an evolved weight. The *effective* ceiling is derived per
/// world in `world_init` from the real in-degree (`w_max`) so that the summed
/// drive into one node cannot overflow i32; it also has to fit the i16 genome.
const W_CAP: i32 = 8_192;
const POT_CLAMP: i32 = 1 << 24;
/// Membrane potential floor: inhibitory bursts cannot silence a neuron for
/// hundreds of ticks.
const POT_FLOOR: i32 = -65_536;

// ---------------------------------------------------------------- senses
/// Klinotaxis: a rising odour at the nose (food two cells ahead) drives the
/// olfactory neurons hard; the tonic term keeps them primed on a lawn. Food
/// runs 400 (crust) to 30,000 (fruit) per cell, and a steady input of 1,024
/// is the firing floor: plain agar is felt, yeast is loud.
const ORN_DELTA_GAIN: i32 = 8;
const ORN_TONIC_SHIFT: i32 = 1;
const GUST_EXT_GAIN: i32 = 2;
/// Pharyngeal taste reports what was actually swallowed last tick.
const GUST_PHAR_GAIN: i32 = 32;
/// Above THRESH on purpose: contact and pain fire on the tick they happen.
const CONTACT_DRIVE: i32 = 20_000;
/// Per centi-degree of deviation from the 24 C baseline.
const THERMO_GAIN: i32 = 8;
const TEMP_BASE: i32 = 2_400;
const TEMP_AMP: i32 = 600;
const VISUAL_GAIN: i32 = 16;
const PROPRIO_SHIFT: i32 = 1;
const SATIETY: i32 = 30_000;
const GUT_SHIFT: i32 = 1;
/// A larva within this distance ahead of the nose is a contact.
const CONTACT_RADIUS_FP: i64 = (3 << FP) as i64 / 2; // 1.5 cells

// ---------------------------------------------------------------- dish
pub const BIOME_WALL: u8 = 0;
pub const BIOME_AGAR: u8 = 1;
pub const BIOME_YEAST: u8 = 2;
pub const BIOME_FRUIT: u8 = 3;
pub const BIOME_DRY: u8 = 4;
pub const BIOME_POOL: u8 = 5;
pub const BIOME_LIT: u8 = 6;
pub const BIOME_RIM: u8 = 7;

/// What each substrate is worth, per 128-tick sweep and in total store.
///                         WALL AGAR YEAST  FRUIT DRY POOL LIT RIM
const REGROW: [i32; 8] = [0, 24, 96, 8, 2, 0, 24, 6];
const FOODCAP: [i32; 8] = [0, 1_500, 12_000, 30_000, 400, 0, 1_500, 800];
/// Deposits (corpses, provisions, blooms) may exceed the regrowth cap; this
/// is the absolute ceiling so a cell can never overflow.
const FOOD_MAX: i32 = 1 << 20;

/// (lattice dim, cell size, amplitude): `dim * cell == GRID` for every octave.
/// The lattice is clamped, not wrapped: the dish has an edge.
const OCT: [(usize, usize, u32); 4] = [(4, 32, 512), (8, 16, 256), (16, 8, 128), (32, 4, 64)];
/// Moisture is histogram-equalised over the dish so these thresholds carve
/// the same fraction of crust and pool on every seed: 15.6% DRY, 4.3% POOL.
const DRY_MOIST: u8 = 40;
const POOL_MOIST: u8 = 245;
const YEAST_COLONIES: usize = 6;
const FRUIT_PIECES: usize = 2;
const LIT_RADIUS: i32 = 7;
const FEATURE_REACH: u32 = 48;

/// Day/night: period 16,384 ticks (13.7 min at 20 t/s), a power of two so the
/// cycle stays exact across the u32 tick wrap. Temperature: period 131,072.
const DAY_SHIFT: u32 = 2;
const TEMP_SHIFT: u32 = 1;

/// How long a flood keeps the pools expanded, in ticks.
const FLOOD_TICKS: u32 = 1_200;
const DRY_SPELL_MOISTURE: u8 = 40;
const BLOOM_FOOD: i32 = 26_000;
const BLOOM_RADIUS: i32 = 6;
const PROVISION_FOOD: i32 = 30_000;

// ---------------------------------------------------------------- ecology
/// Starvation cannibalism (Vijendravarma et al. 2013): a clearly stronger
/// larva on a cell with no food bites a weaker neighbour.
const BITE: i32 = 3_000;
const BITE_KEEP_NUM: i32 = 3; // dominant larva keeps 3/4 of contested energy
const BITE_KEEP_DEN: i32 = 4;
const CONTEST_RADIUS_FP: i64 = (3 << FP) as i64 / 2; // 1.5 cells
const POWER_NUM: i32 = 3; // attack requires energy > 3/2 of the victim's
const POWER_DEN: i32 = 2;
const MATE_RADIUS: i32 = 4 << FP;
const MATE_MIN_ENERGY: i32 = 12_000;
const MATE_COST: i32 = 3_000;
/// Age past which metabolic upkeep starts climbing and death is old age.
const SENESCE_AT: u32 = 32_768;
/// Ring-gland spikes accumulate as ecdysone; reproduction needs this much.
const ECDYSONE_THRESHOLD: u32 = 2_048;

pub const CAUSE_STARVED: u8 = 1;
pub const CAUSE_SENESCENCE: u8 = 2;
pub const CAUSE_KILLED: u8 = 3;
pub const CAUSE_DESICCATED: u8 = 4;
pub const CAUSE_DROWNED: u8 = 5;
pub const CAUSE_CULLED: u8 = 6;
pub const NO_PARENT: u32 = 0xFF;
/// `uid` is host-assigned at birth; a fresh slot carries this until then so a
/// stale uid from the slot's previous occupant can never be matched.
pub const UID_UNASSIGNED: u32 = u32::MAX;

const START_ENERGY: i32 = 20_000;
const METABOLIC_COST: i32 = 8;
const MOVE_COST_SHIFT: i32 = 9;
const DRY_DRAIN: i32 = 30;
const POOL_DRAIN: i32 = 40;
/// Largest graze per tick, reached when 8 or more SEZ descending neurons
/// fire in the same tick.
const FEED_MAX: i32 = 700;
const REPRO_ENERGY: i32 = 45_000;
const ENERGY_CAP: i32 = 60_000;
const CORPSE_FOOD: i32 = 3_000;
/// Baseline crawl. A well-driven larva is several times faster than a quiet
/// one, so speed is a visible phenotype.
const BASE_THRUST: i32 = 900;
const THRUST_MAX: i32 = 20_000;
const DN_THRUST: i32 = 260;
const TURN_GAIN: i32 = 70;
const WANDER: i32 = 60;

const SIN: [i16; 256] = [
    0, 804, 1608, 2410, 3212, 4011, 4808, 5602, 6393, 7179, 7962, 8739, 9512, 10278, 11039, 11793,
    12539, 13279, 14010, 14732, 15446, 16151, 16846, 17530, 18204, 18868, 19519, 20159, 20787, 21403, 22005, 22594,
    23170, 23731, 24279, 24811, 25329, 25832, 26319, 26790, 27245, 27683, 28105, 28510, 28898, 29268, 29621, 29956,
    30273, 30571, 30852, 31113, 31356, 31580, 31785, 31971, 32137, 32285, 32412, 32521, 32609, 32678, 32728, 32757,
    32767, 32757, 32728, 32678, 32609, 32521, 32412, 32285, 32137, 31971, 31785, 31580, 31356, 31113, 30852, 30571,
    30273, 29956, 29621, 29268, 28898, 28510, 28105, 27683, 27245, 26790, 26319, 25832, 25329, 24811, 24279, 23731,
    23170, 22594, 22005, 21403, 20787, 20159, 19519, 18868, 18204, 17530, 16846, 16151, 15446, 14732, 14010, 13279,
    12539, 11793, 11039, 10278, 9512, 8739, 7962, 7179, 6393, 5602, 4808, 4011, 3212, 2410, 1608, 804,
    0, -804, -1608, -2410, -3212, -4011, -4808, -5602, -6393, -7179, -7962, -8739, -9512, -10278, -11039, -11793,
    -12539, -13279, -14010, -14732, -15446, -16151, -16846, -17530, -18204, -18868, -19519, -20159, -20787, -21403, -22005, -22594,
    -23170, -23731, -24279, -24811, -25329, -25832, -26319, -26790, -27245, -27683, -28105, -28510, -28898, -29268, -29621, -29956,
    -30273, -30571, -30852, -31113, -31356, -31580, -31785, -31971, -32137, -32285, -32412, -32521, -32609, -32678, -32728, -32757,
    -32767, -32757, -32728, -32678, -32609, -32521, -32412, -32285, -32137, -31971, -31785, -31580, -31356, -31113, -30852, -30571,
    -30273, -29956, -29621, -29268, -28898, -28510, -28105, -27683, -27245, -26790, -26319, -25832, -25329, -24811, -24279, -23731,
    -23170, -22594, -22005, -21403, -20787, -20159, -19519, -18868, -18204, -17530, -16846, -16151, -15446, -14732, -14010, -13279,
    -12539, -11793, -11039, -10278, -9512, -8739, -7962, -7179, -6393, -5602, -4808, -4011, -3212, -2410, -1608, -804,
];

#[inline]
fn isin(angle: u16) -> i32 {
    SIN[(angle >> 8) as usize] as i32
}
#[inline]
fn icos(angle: u16) -> i32 {
    SIN[(angle.wrapping_add(16_384) >> 8) as usize] as i32
}

struct Rng(u64);
impl Rng {
    #[inline]
    fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    #[inline]
    fn below(&mut self, n: u32) -> u32 {
        (self.next() >> 33) as u32 % n.max(1)
    }
}

struct World {
    // graph (shared by every creature; host-written before world_init)
    node_count: usize,
    edge_count: usize,
    role: [u8; MAX_NODES],
    e_pre: [u16; MAX_EDGES],
    e_post: [u16; MAX_EDGES],
    base_w: [i32; MAX_EDGES],
    /// CSR by presynaptic node, built in `world_init`: the out-edges of node
    /// `n` are `out_start[n]..out_start[n+1]` into `out_edge` (canonical edge
    /// index, which is the genome index) and `out_post` (its target).
    out_start: [u32; MAX_NODES + 1],
    out_edge: [u32; MAX_EDGES],
    out_post: [u16; MAX_EDGES],
    /// Effective weight ceiling for THIS graph, derived in `world_init` from
    /// its real fan-in so the summed drive into one node cannot overflow i32.
    w_max: i32,

    // dish
    food: [i32; GRID * GRID],
    moisture: [u8; GRID * GRID],
    /// Genesis moisture; a dry spell lowers `moisture`, which recovers toward
    /// this one point per sweep.
    moisture0: [u8; GRID * GRID],
    /// Fixed substrate class from genesis. AGAR and DRY are re-derived from
    /// moisture at every sweep (the crust spreads in a dry spell and recedes
    /// after); the other classes are permanent.
    biome0: [u8; GRID * GRID],
    biome: [u8; GRID * GRID],
    /// Cells turned into POOL by the current flood, one bit per cell.
    flood_mask: [u8; GRID * GRID / 8],
    flood_ticks: u32,
    rng: Rng,
    tick: u32,
    capacity: u32,

    // population (struct of arrays)
    alive: [u8; MAX_POP],
    x: [i32; MAX_POP], // 16.16 in grid-cell units
    y: [i32; MAX_POP],
    heading: [u16; MAX_POP],
    energy: [i32; MAX_POP],
    generation: [u32; MAX_POP],
    lineage: [u32; MAX_POP],
    age: [u32; MAX_POP],
    bend: [[i16; NSEG]; MAX_POP], // per-segment body bend, heading-angle units
    wave: [u16; MAX_POP],         // locomotor wave phase
    ecdysone: [u32; MAX_POP],
    /// Food at the nose last tick: the memory klinotaxis needs.
    last_odor: [i32; MAX_POP],
    /// Sensory memory of the previous tick: what was swallowed, whether the
    /// larva was bitten, how hard it pushed. All three feed `acc[]` next tick
    /// and are therefore hashed.
    ate_last: [i32; MAX_POP],
    bitten: [u8; MAX_POP],
    thrust_last: [i32; MAX_POP],
    /// lifetime energy consumed (grazing + contest wins). Observability
    /// counter for the economy; deliberately NOT part of the state hash: it
    /// derives deterministically from stepping.
    eaten: [u32; MAX_POP],
    /// lifetime food gained from keeper PROVISION actions, so paying to feed
    /// cannot count as work the world rewards.
    fed: [u32; MAX_POP],
    /// Host-assigned creature id; a pure label, not hashed, no behavioural
    /// effect. `int_provision`/`int_kill` target by it so slot reuse can never
    /// hit the wrong larva.
    uid: [u32; MAX_POP],
    genome: [[i16; MAX_EDGES]; MAX_POP],
    pot: [[i32; MAX_NODES]; MAX_POP],
    refr: [[u8; MAX_NODES]; MAX_POP],
    fired: [[u8; MAX_NODES]; MAX_POP],

    births: u32,
    deaths: u32,
    kills: u32,
    next_lineage: u32,
    max_gen: u32,

    // event ring: (tick, kind, a, b)
    ev: [[u32; 4]; 256],
    ev_head: u32,
}

/// Every initializer is zero on purpose: one nonzero byte moves the whole
/// 28 MB struct from bss into the wasm data segment (measured: a 15 MB
/// module). `world_init` sets every scalar before anything reads it.
static mut W: World = World {
    node_count: 0,
    edge_count: 0,
    role: [0; MAX_NODES],
    e_pre: [0; MAX_EDGES],
    e_post: [0; MAX_EDGES],
    base_w: [0; MAX_EDGES],
    out_start: [0; MAX_NODES + 1],
    out_edge: [0; MAX_EDGES],
    out_post: [0; MAX_EDGES],
    w_max: 0,
    food: [0; GRID * GRID],
    moisture: [0; GRID * GRID],
    moisture0: [0; GRID * GRID],
    biome0: [0; GRID * GRID],
    biome: [0; GRID * GRID],
    flood_mask: [0; GRID * GRID / 8],
    flood_ticks: 0,
    rng: Rng(0),
    tick: 0,
    capacity: 0,
    alive: [0; MAX_POP],
    x: [0; MAX_POP],
    y: [0; MAX_POP],
    heading: [0; MAX_POP],
    energy: [0; MAX_POP],
    generation: [0; MAX_POP],
    lineage: [0; MAX_POP],
    age: [0; MAX_POP],
    bend: [[0; NSEG]; MAX_POP],
    wave: [0; MAX_POP],
    ecdysone: [0; MAX_POP],
    last_odor: [0; MAX_POP],
    ate_last: [0; MAX_POP],
    bitten: [0; MAX_POP],
    thrust_last: [0; MAX_POP],
    eaten: [0; MAX_POP],
    fed: [0; MAX_POP],
    uid: [0; MAX_POP],
    genome: [[0; MAX_EDGES]; MAX_POP],
    pot: [[0; MAX_NODES]; MAX_POP],
    refr: [[0; MAX_NODES]; MAX_POP],
    fired: [[0; MAX_NODES]; MAX_POP],
    births: 0,
    deaths: 0,
    kills: 0,
    next_lineage: 0,
    max_gen: 0,
    ev: [[0; 4]; 256],
    ev_head: 0,
};

#[inline]
fn in_dish(cx: i32, cy: i32) -> bool {
    let (dx, dy) = (cx - DISH_CX, cy - DISH_CY);
    dx * dx + dy * dy < DISH_RADIUS * DISH_RADIUS
}

/// Cell index of a 16.16 position. Positions never leave the grid (the wall
/// is impassable), but the clamp keeps an index in range under every input.
#[inline]
fn cell_of(x: i32, y: i32) -> usize {
    let cx = (x >> FP).clamp(0, GRID as i32 - 1) as usize;
    let cy = (y >> FP).clamp(0, GRID as i32 - 1) as usize;
    cy * GRID + cx
}

/// Bilinear sample of a clamped lattice `(dim+1)^2` with an integer smoothstep
/// on the interpolant. Worst term is 511 * 32 * 32 = 523,264 and four of them
/// fit u32 1,024x over.
fn bilerp(lat: &[u32], dim: usize, x: usize, y: usize, cell: usize, ease: &[u32]) -> u32 {
    let (cx, cy) = (x / cell, y / cell);
    let (fx, fy) = (ease[x % cell], ease[y % cell]);
    let c = cell as u32;
    let stride = dim + 1;
    let a = lat[cy * stride + cx];
    let b = lat[cy * stride + cx + 1];
    let d = lat[(cy + 1) * stride + cx];
    let e = lat[(cy + 1) * stride + cx + 1];
    (a * (c - fx) * (c - fy) + b * fx * (c - fy) + d * (c - fx) * fy + e * fx * fy) / (c * c)
}

/// Integer smoothstep table for one cell size: `ease[f] = 3f^2*cell - 2f^3`
/// over `cell^2`, the classic 3t^2-2t^3 in fixed point.
fn ease_table(cell: usize, out: &mut [u32]) {
    for f in 0..cell {
        let (f1, c1) = (f as u32, cell as u32);
        out[f] = (3 * f1 * f1 * c1 - 2 * f1 * f1 * f1) / (c1 * c1);
    }
}

impl World {
    /// Build the dish. Runs once, at genesis, and costs nothing per tick.
    ///
    /// Four clamped octaves of value noise, histogram-equalised over the dish
    /// so crust and pool cover the same fraction on every seed, then the
    /// features: yeast colonies, fruit, one lit patch, the rim.
    fn gen_dish(&mut self) {
        let mut lat = [[0u32; 33 * 33]; 4];
        for (o, &(dim, _, amp)) in OCT.iter().enumerate() {
            for i in 0..(dim + 1) * (dim + 1) {
                lat[o][i] = self.rng.below(amp);
            }
        }
        let mut ease = [[0u32; 32]; 4];
        for (o, &(_, cell, _)) in OCT.iter().enumerate() {
            let (t, _) = ease[o].split_at_mut(cell);
            ease_table(cell, t);
        }
        let mut raw = [0u32; GRID * GRID];
        for y in 0..GRID {
            for x in 0..GRID {
                let mut s = 0u32;
                for (o, &(dim, cell, _)) in OCT.iter().enumerate() {
                    s += bilerp(&lat[o][..(dim + 1) * (dim + 1)], dim, x, y, cell, &ease[o][..cell]);
                }
                raw[y * GRID + x] = s;
            }
        }

        // equalise over dish cells only: outside is wall and has no moisture
        let mut hist = [0u32; 1024];
        let mut dish_cells = 0u32;
        for c in 0..GRID * GRID {
            if in_dish((c % GRID) as i32, (c / GRID) as i32) {
                hist[(raw[c] as usize).min(1023)] += 1;
                dish_cells += 1;
            }
        }
        let mut cum = [0u32; 1024];
        {
            let mut acc = 0u32;
            for r in 0..1024 {
                cum[r] = acc;
                acc += hist[r];
            }
        }
        for c in 0..GRID * GRID {
            let (cx, cy) = ((c % GRID) as i32, (c / GRID) as i32);
            if !in_dish(cx, cy) {
                self.moisture0[c] = 0;
                self.biome0[c] = BIOME_WALL;
                continue;
            }
            let r = (raw[c] as usize).min(1023);
            let rank = cum[r] + (hist[r] >> 1); // mid-rank: no tie-break needed
            let m = ((rank * 256) / dish_cells).min(255) as u8;
            self.moisture0[c] = m;
            let (dx, dy) = (cx - DISH_CX, cy - DISH_CY);
            self.biome0[c] = if dx * dx + dy * dy >= (DISH_RADIUS - 1) * (DISH_RADIUS - 1) {
                BIOME_RIM
            } else if m >= POOL_MOIST {
                BIOME_POOL
            } else if m < DRY_MOIST {
                BIOME_DRY
            } else {
                BIOME_AGAR
            };
        }

        // features paint only over plain agar or crust, so earlier ones and
        // pools are preserved
        for _ in 0..YEAST_COLONIES {
            let r = 3 + self.rng.below(3) as i32;
            self.paint_feature(BIOME_YEAST, r);
        }
        for _ in 0..FRUIT_PIECES {
            self.paint_feature(BIOME_FRUIT, 4);
        }
        self.paint_feature(BIOME_LIT, LIT_RADIUS);

        self.moisture = self.moisture0;
        self.flood_mask = [0; GRID * GRID / 8];
        for c in 0..GRID * GRID {
            self.biome[c] = self.classify(c);
        }
    }

    fn paint_feature(&mut self, b: u8, r: i32) {
        let cx = DISH_CX - FEATURE_REACH as i32 + self.rng.below(2 * FEATURE_REACH + 1) as i32;
        let cy = DISH_CY - FEATURE_REACH as i32 + self.rng.below(2 * FEATURE_REACH + 1) as i32;
        for dy in -r..=r {
            for dx in -r..=r {
                if dx * dx + dy * dy > r * r {
                    continue;
                }
                let (x, y) = (cx + dx, cy + dy);
                if x < 0 || y < 0 || x >= GRID as i32 || y >= GRID as i32 {
                    continue;
                }
                let c = y as usize * GRID + x as usize;
                if self.biome0[c] == BIOME_AGAR || self.biome0[c] == BIOME_DRY {
                    self.biome0[c] = b;
                }
            }
        }
    }

    /// What a cell is right now: the flood overrides, the crust follows the
    /// moisture, everything else is fixed at genesis.
    #[inline]
    fn classify(&self, c: usize) -> u8 {
        if self.flood_mask[c >> 3] & (1 << (c & 7)) != 0 {
            return BIOME_POOL;
        }
        match self.biome0[c] {
            BIOME_AGAR | BIOME_DRY => {
                if self.moisture[c] < DRY_MOIST {
                    BIOME_DRY
                } else {
                    BIOME_AGAR
                }
            }
            b => b,
        }
    }

    /// Ambient light 0..255: a pure function of the tick, which is already
    /// hashed, so the cycle costs no state and cannot desync.
    #[inline]
    fn ambient(&self) -> i32 {
        128 + ((isin((self.tick << DAY_SHIFT) as u16) * 127) >> 15)
    }

    #[inline]
    fn light_at(&self, c: usize) -> i32 {
        if self.biome[c] == BIOME_LIT {
            255
        } else {
            self.ambient()
        }
    }

    /// Temperature in centi-degrees Celsius, 18 to 30 around a 24 baseline.
    #[inline]
    fn temperature(&self) -> i32 {
        TEMP_BASE + ((isin((self.tick >> TEMP_SHIFT) as u16) * TEMP_AMP) >> 15)
    }

    /// The genome a founder is born with: the literal published synapse
    /// counts, clamped to this world's ceiling. Writes IN PLACE: returning a
    /// row by value costs 256 KB of stack, which is a wasm stack overflow.
    fn write_genesis_genome(&mut self, slot: usize) {
        for e in 0..self.edge_count {
            self.genome[slot][e] = self.base_w[e].clamp(-self.w_max, self.w_max) as i16;
        }
    }

    #[inline]
    fn spawnable(&self, c: usize) -> bool {
        matches!(self.biome[c], BIOME_AGAR | BIOME_YEAST | BIOME_FRUIT | BIOME_LIT)
    }

    fn dish_spot(&mut self) -> (i32, i32) {
        for _ in 0..64 {
            let x = self.rng.below((GRID as u32) << FP) as i32;
            let y = self.rng.below((GRID as u32) << FP) as i32;
            if self.spawnable(cell_of(x, y)) {
                return (x, y);
            }
        }
        let half = 1 << (FP - 1);
        for c in 0..GRID * GRID {
            if self.spawnable(c) {
                return ((((c % GRID) as i32) << FP) + half, (((c / GRID) as i32) << FP) + half);
            }
        }
        ((DISH_CX << FP) + half, (DISH_CY << FP) + half)
    }

    fn push_event(&mut self, kind: u32, a: u32, b: u32) {
        let i = (self.ev_head % 256) as usize;
        self.ev[i] = [self.tick, kind, a, b];
        self.ev_head = self.ev_head.wrapping_add(1);
    }

    /// The cell `radius` cells ahead of the head along the heading.
    fn probe(&self, w: usize, radius: i32) -> usize {
        let a = self.heading[w];
        let sx = (self.x[w] >> FP) + ((icos(a) * radius + 16_384) >> 15);
        let sy = (self.y[w] >> FP) + ((isin(a) * radius + 16_384) >> 15);
        cell_of(sx << FP, sy << FP)
    }

    /// Another larva within 1.5 cells of the point 1.5 cells ahead of the head.
    fn larva_ahead(&self, w: usize) -> bool {
        let a = self.heading[w];
        let px = self.x[w] + ((icos(a) * 3) >> 1);
        let py = self.y[w] + ((isin(a) * 3) >> 1);
        for m in 0..MAX_POP {
            if m == w || self.alive[m] == 0 {
                continue;
            }
            let dx = (self.x[m] - px) as i64;
            let dy = (self.y[m] - py) as i64;
            if dx * dx + dy * dy <= CONTACT_RADIUS_FP * CONTACT_RADIUS_FP {
                return true;
            }
        }
        false
    }

    fn spawn(&mut self, slot: usize, px: i32, py: i32, gen: u32, lin: u32, energy: i32) {
        self.alive[slot] = 1;
        self.x[slot] = px;
        self.y[slot] = py;
        self.heading[slot] = (self.rng.next() & 0xFFFF) as u16;
        self.energy[slot] = energy;
        self.generation[slot] = gen;
        self.lineage[slot] = lin;
        self.age[slot] = 0;
        self.bend[slot] = [0; NSEG];
        self.wave[slot] = (self.rng.next() & 0xFFFF) as u16;
        self.ecdysone[slot] = 0;
        self.last_odor[slot] = 0;
        self.ate_last[slot] = 0;
        self.bitten[slot] = 0;
        self.thrust_last[slot] = 0;
        self.eaten[slot] = 0;
        self.fed[slot] = 0;
        self.uid[slot] = UID_UNASSIGNED;
        self.pot[slot] = [0; MAX_NODES];
        self.refr[slot] = [0; MAX_NODES];
        self.fired[slot] = [0; MAX_NODES];
        if gen > self.max_gen {
            self.max_gen = gen;
        }
    }

    fn deposit(&mut self, c: usize, amount: i32) {
        if self.biome[c] == BIOME_WALL || self.biome[c] == BIOME_POOL {
            return; // nothing settles on the wall or in liquid
        }
        self.food[c] = (self.food[c] + amount).min(FOOD_MAX);
    }

    fn kill(&mut self, w: usize, cause: u8) {
        self.alive[w] = 0;
        self.deaths += 1;
        if cause == CAUSE_KILLED {
            self.kills += 1;
        }
        let c = cell_of(self.x[w], self.y[w]);
        self.deposit(c, CORPSE_FOOD);
        self.push_event(2, w as u32, cause as u32);
    }

    /// An eligible partner already within touching distance. A proximity
    /// test at the moment of reproduction, not steering: getting near a mate
    /// is the connectome's job.
    fn partner_within(&self, parent: usize, radius: i32) -> Option<usize> {
        let r = radius as i64;
        let mut best: Option<(i64, usize)> = None;
        for m in 0..MAX_POP {
            if m == parent || self.alive[m] == 0 || self.energy[m] < MATE_MIN_ENERGY {
                continue;
            }
            let dx = (self.x[m] - self.x[parent]) as i64;
            let dy = (self.y[m] - self.y[parent]) as i64;
            let d2 = dx * dx + dy * dy;
            if d2 <= r * r && best.map_or(true, |(bd, _)| d2 < bd) {
                best = Some((d2, m));
            }
        }
        best.map(|(_, m)| m)
    }

    /// Where a child is born: the jittered point when that cell is
    /// spawnable, else the first spawnable of the parent's eight neighbours
    /// in a fixed order (so the choice replays), else the parent's own cell.
    /// A parent can be standing on crust or in a pool; the child should not
    /// start life there when open agar is one cell away.
    fn child_spot(&self, parent: usize, jitter_x: i32, jitter_y: i32) -> (i32, i32) {
        let (jx, jy) = (self.x[parent] + jitter_x, self.y[parent] + jitter_y);
        if self.spawnable(cell_of(jx, jy)) {
            return (jx, jy);
        }
        const NEIGHBOURS: [(i32, i32); 8] = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (-1, -1), (1, -1)];
        let c = cell_of(self.x[parent], self.y[parent]);
        let (cx, cy) = ((c % GRID) as i32, (c / GRID) as i32);
        let half = 1 << (FP - 1);
        for (dx, dy) in NEIGHBOURS {
            let (nx, ny) = (cx + dx, cy + dy);
            if nx < 0 || ny < 0 || nx >= GRID as i32 || ny >= GRID as i32 {
                continue;
            }
            if self.spawnable(ny as usize * GRID + nx as usize) {
                return ((nx << FP) + half, (ny << FP) + half);
            }
        }
        (self.x[parent], self.y[parent])
    }

    fn reproduce(&mut self, parent: usize) {
        let pop = self.alive.iter().filter(|a| **a == 1).count() as u32;
        if pop >= self.capacity {
            return;
        }
        let Some(partner) = self.partner_within(parent, MATE_RADIUS) else { return };
        let Some(slot) = self.alive.iter().position(|a| *a == 0) else { return };

        let half = self.energy[parent] / 2;
        self.energy[parent] = half;
        self.energy[partner] -= MATE_COST;
        self.ecdysone[parent] = 0;
        // symmetric: [-1, +1] cells, so lineages do not drift across the dish
        let jitter_x = (self.rng.below((2 << FP) + 1) as i32) - (1 << FP);
        let jitter_y = (self.rng.below((2 << FP) + 1) as i32) - (1 << FP);
        let gen = self.generation[parent].max(self.generation[partner]) + 1;
        let lin = self.lineage[parent];
        let (px, py) = self.child_spot(parent, jitter_x, jitter_y);

        // crossover: each canonical edge weight from either parent (64 edges
        // per rng draw), then 1..6 signed mutations
        for chunk in 0..(self.edge_count + 63) / 64 {
            let bits = self.rng.next();
            for k in 0..64 {
                let e = chunk * 64 + k;
                if e >= self.edge_count {
                    break;
                }
                self.genome[slot][e] = if (bits >> k) & 1 == 1 {
                    self.genome[parent][e]
                } else {
                    self.genome[partner][e]
                };
            }
        }
        let muts = 1 + self.rng.below(6) as usize;
        for _ in 0..muts {
            let e = self.rng.below(self.edge_count as u32) as usize;
            let w0 = self.genome[slot][e] as i32;
            // a floor of 64 lets a silenced synapse be rediscovered
            let span = (w0.abs() / 3).clamp(64, self.w_max) as u32;
            let delta = self.rng.below(span * 2 + 1) as i32 - span as i32;
            // Signed: the census records polarity as null on every edge, so
            // excitatory-only was never a fact about the animal. Any negative
            // weight in this world was found by selection HERE and is a claim
            // about this simulation, not about the larva.
            self.genome[slot][e] = (w0 + delta).clamp(-self.w_max, self.w_max) as i16;
        }
        self.spawn(slot, px, py, gen, lin, half);
        self.births += 1;
        self.push_event(1, slot as u32, parent as u32);
    }

    /// Contests, bucketed and lethal. Pair order is fixed and explicit:
    /// buckets in index order, list order within a bucket, offsets in the
    /// order given, `i` always tested as predator before `j`, because "who
    /// bit whom" has to be reproducible.
    fn contests(&mut self) {
        const BG: usize = 16; // 16x16 buckets of 8x8 cells
        let mut head = [-1i16; BG * BG];
        let mut next = [-1i16; MAX_POP];
        for w in 0..MAX_POP {
            if self.alive[w] == 0 {
                continue;
            }
            let c = cell_of(self.x[w], self.y[w]);
            let b = (c / GRID / 8) * BG + (c % GRID) / 8;
            next[w] = head[b];
            head[b] = w as i16;
        }
        // {self, E, SE, S, SW} visits every unordered pair of adjacent
        // buckets exactly once; the dish has an edge, so no wrap.
        const OFF: [(i32, i32); 5] = [(0, 0), (1, 0), (1, 1), (0, 1), (-1, 1)];
        for by in 0..BG {
            for bx in 0..BG {
                let b = by * BG + bx;
                for (k, &(ox, oy)) in OFF.iter().enumerate() {
                    let (nx, ny) = (bx as i32 + ox, by as i32 + oy);
                    if nx < 0 || ny < 0 || nx >= BG as i32 || ny >= BG as i32 {
                        continue;
                    }
                    let nb = ny as usize * BG + nx as usize;
                    let mut ii = head[b];
                    while ii >= 0 {
                        let i = ii as usize;
                        ii = next[i];
                        if self.alive[i] == 0 {
                            continue;
                        }
                        // within a bucket, only look forward down the list
                        let mut jj = if k == 0 { next[i] } else { head[nb] };
                        while jj >= 0 {
                            let j = jj as usize;
                            jj = next[j];
                            if self.alive[j] == 0 || i == j {
                                continue;
                            }
                            self.contest_pair(i, j);
                        }
                    }
                }
            }
        }
    }

    /// Starvation cannibalism: the clearly stronger larva bites, but only
    /// when it is hungry and standing on a cell with nothing else to eat.
    /// The empty-cell test alone was not enough: a grazed cell reads zero
    /// within a few ticks, so sated parents ate their newborns (measured:
    /// 672 of 710 deaths over 200,000 ticks were bites at mean energy 50k).
    fn contest_pair(&mut self, i: usize, j: usize) {
        let dx = (self.x[i] - self.x[j]) as i64;
        let dy = (self.y[i] - self.y[j]) as i64;
        if dx * dx + dy * dy > CONTEST_RADIUS_FP * CONTEST_RADIUS_FP {
            return;
        }
        let (pred, prey) = if self.energy[i] * POWER_DEN > self.energy[j] * POWER_NUM {
            (i, j)
        } else if self.energy[j] * POWER_DEN > self.energy[i] * POWER_NUM {
            (j, i)
        } else {
            return; // evenly matched: nothing happens
        };
        if self.energy[pred] >= SATIETY || self.food[cell_of(self.x[pred], self.y[pred])] > 0 {
            return;
        }
        let bite = BITE.min(self.energy[prey]);
        if bite <= 0 {
            return;
        }
        self.energy[prey] -= bite;
        self.bitten[prey] = 1;
        let gained = bite * BITE_KEEP_NUM / BITE_KEEP_DEN;
        self.energy[pred] = (self.energy[pred] + gained).min(ENERGY_CAP);
        self.eaten[pred] = self.eaten[pred].saturating_add(gained as u32);
        if self.energy[prey] <= 0 {
            self.kill(prey, CAUSE_KILLED);
        }
    }

    /// Event-driven synaptic propagation: only the out-edges of nodes that
    /// fired last tick are visited. Equivalent to the naive per-edge sweep
    /// (proven by `csr_matches_naive`) because `w_max` keeps every sum inside
    /// i32, so addition order cannot matter. Returns the spike count.
    #[inline]
    fn propagate(&self, w: usize, acc: &mut [i32; MAX_NODES]) -> i32 {
        let fired = &self.fired[w];
        let genome = &self.genome[w];
        let mut spikes = 0;
        for a in 0..self.node_count {
            if fired[a] == 0 {
                continue;
            }
            spikes += 1;
            let (s, t) = (self.out_start[a] as usize, self.out_start[a + 1] as usize);
            for k in s..t {
                let e = self.out_edge[k] as usize;
                let b = self.out_post[k] as usize;
                acc[b] = acc[b].saturating_add(genome[e] as i32 * SYN_GAIN);
            }
        }
        spikes
    }

    /// One row of the dish per tick, so every cell refreshes every 128 ticks:
    /// food regrows to its substrate ceiling, moisture recovers toward genesis,
    /// and the crust boundary follows the moisture.
    fn sweep(&mut self) {
        let row = (self.tick & (GRID as u32 - 1)) as usize;
        for c in row * GRID..(row + 1) * GRID {
            if self.moisture[c] < self.moisture0[c] {
                self.moisture[c] += 1;
            }
            self.biome[c] = self.classify(c);
            let b = self.biome[c] as usize;
            let cap = FOODCAP[b];
            if self.food[c] < cap {
                self.food[c] = (self.food[c] + REGROW[b]).min(cap);
            }
        }
    }

    fn end_flood(&mut self) {
        self.flood_mask = [0; GRID * GRID / 8];
        for c in 0..GRID * GRID {
            self.biome[c] = self.classify(c);
        }
    }

    fn tick_one(&mut self) {
        self.tick = self.tick.wrapping_add(1);

        if self.flood_ticks > 0 {
            self.flood_ticks -= 1;
            if self.flood_ticks == 0 {
                self.end_flood();
            }
        }
        self.sweep();

        let temp_dev = self.temperature() - TEMP_BASE;
        let n = self.node_count;
        // sensory drive and recurrent drive are kept apart: only the latter
        // is normalised by last tick's activity
        let mut acc = [0i32; MAX_NODES];
        let mut rec = [0i32; MAX_NODES];

        for w in 0..MAX_POP {
            if self.alive[w] == 0 {
                continue;
            }
            self.age[w] = self.age[w].wrapping_add(1);

            // -------- senses --------
            //
            // Everything here writes into `acc[]` and nothing writes `turn` or
            // `thrust` directly. Whatever the larva does about what it senses
            // has to come out of the connectome, or the connectome is decoration.
            let here = cell_of(self.x[w], self.y[w]);
            let nose = self.probe(w, 2);
            let biome_here = self.biome[here];

            let odor = self.food[nose];
            let d_odor = odor - self.last_odor[w];
            self.last_odor[w] = odor;
            let orn = (d_odor.max(0) * ORN_DELTA_GAIN) + (odor >> ORN_TONIC_SHIFT);
            let gust_ext = self.food[here] * GUST_EXT_GAIN;
            let gust_phar = self.ate_last[w] * GUST_PHAR_GAIN;
            let blocked = matches!(self.biome[nose], BIOME_WALL | BIOME_RIM) || self.larva_ahead(w);
            let draining = biome_here == BIOME_DRY || biome_here == BIOME_POOL;
            let noci = self.bitten[w] == 1 || draining;
            self.bitten[w] = 0;
            let cold = (-temp_dev).max(0) * THERMO_GAIN;
            let warm = temp_dev.max(0) * THERMO_GAIN;
            let visual = self.light_at(here) * VISUAL_GAIN;
            let proprio = self.thrust_last[w].abs() >> PROPRIO_SHIFT;
            let gut = (self.energy[w] - SATIETY).max(0) >> GUT_SHIFT;
            let in_pool = biome_here == BIOME_POOL;

            acc[..n].fill(0);
            for i in 0..n {
                let drive = match self.role[i] {
                    ROLE_ORN => orn,
                    ROLE_GUST_EXT => gust_ext,
                    ROLE_GUST_PHAR => gust_phar,
                    ROLE_MECH => if blocked { CONTACT_DRIVE } else { 0 },
                    ROLE_NOCI => if noci { CONTACT_DRIVE } else { 0 },
                    ROLE_THERMO_COLD => cold,
                    ROLE_THERMO_WARM => warm,
                    ROLE_VISUAL => visual,
                    ROLE_PROPRIO => proprio,
                    ROLE_GUT => gut,
                    ROLE_RESP => if in_pool { CONTACT_DRIVE } else { 0 },
                    _ => 0,
                };
                acc[i] = drive;
            }

            rec[..n].fill(0);
            let spikes = self.propagate(w, &mut rec);
            let norm = NORM_SPIKES as i64;
            let scale_den = norm + spikes as i64;

            // -------- integrate and fire --------
            let mut dn_l = 0i32;
            let mut dn_r = 0i32;
            let mut dn_c = 0i32;
            let mut sez = 0i32;
            let mut rgn = 0u32;
            for i in 0..n {
                if self.refr[w][i] > 0 {
                    self.refr[w][i] -= 1;
                    self.fired[w][i] = 0;
                    self.pot[w][i] = 0;
                    continue;
                }
                let pot0 = self.pot[w][i];
                // symmetric leak: round toward zero rather than toward -inf
                let leak = (pot0 + ((pot0 >> 31) & 15)) >> 4;
                let recurrent = ((rec[i] as i64 * norm) / scale_den) as i32;
                let p = pot0
                    .saturating_add(acc[i])
                    .saturating_add(recurrent)
                    .saturating_sub(leak)
                    .clamp(POT_FLOOR, POT_CLAMP);
                if p > THRESH {
                    self.fired[w][i] = 1;
                    self.refr[w][i] = REFRACTORY;
                    self.pot[w][i] = 0;
                    match self.role[i] {
                        ROLE_DN_L => dn_l += 1,
                        ROLE_DN_R => dn_r += 1,
                        ROLE_DN_C => dn_c += 1,
                        ROLE_DN_SEZ => sez += 1,
                        ROLE_RGN => rgn += 1,
                        _ => {}
                    }
                } else {
                    self.fired[w][i] = 0;
                    self.pot[w][i] = p;
                }
            }

            // -------- motor --------
            let left = dn_l + dn_c;
            let right = dn_r + dn_c;
            let drive = left + right;
            let wander = self.rng.below((WANDER * 2) as u32) as i32 - WANDER;
            let turn = (left - right) * TURN_GAIN + wander;
            self.heading[w] = (self.heading[w] as i32 + turn) as u16;
            // `drive` is a count of descending spikes, never negative: these
            // larvae only crawl forward, and nothing here claims reversal.
            let thrust = (BASE_THRUST + drive * DN_THRUST).min(THRUST_MAX);
            self.thrust_last[w] = thrust;

            // peristaltic wave for the renderer: a contraction travels
            // head-to-tail, faster and larger with more descending drive
            self.wave[w] = self.wave[w].wrapping_add((1200 + drive * 44).min(6000) as u16);
            let amp = 2400 + (drive * 95).min(3400);
            for s in 0..NSEG {
                let phase = self.wave[w].wrapping_sub((s as u16).wrapping_mul(5400));
                let target = (((isin(phase) * amp) >> 15) + (left - right) * 750).clamp(-8500, 8500);
                let cur = self.bend[w][s] as i32;
                self.bend[w][s] = (cur + ((target - cur) >> 2)) as i16;
            }

            // the wall is impassable: slide along it, or stay put
            let nx = self.x[w] + ((icos(self.heading[w]) * thrust) >> 15);
            let ny = self.y[w] + ((isin(self.heading[w]) * thrust) >> 15);
            let open = |c: usize| self.biome[c] != BIOME_WALL;
            if open(cell_of(nx, ny)) {
                self.x[w] = nx;
                self.y[w] = ny;
            } else if open(cell_of(nx, self.y[w])) {
                self.x[w] = nx;
            } else if open(cell_of(self.x[w], ny)) {
                self.y[w] = ny;
            }

            // -------- feeding: pharyngeal pumping is SEZ output --------
            let c = cell_of(self.x[w], self.y[w]);
            let b = self.biome[c];
            let mut ate = 0;
            if b != BIOME_POOL && self.food[c] > 0 && sez > 0 {
                ate = self.food[c].min(FEED_MAX * sez.min(8) / 8);
                self.food[c] -= ate;
                self.energy[w] = (self.energy[w] + ate).min(ENERGY_CAP);
                self.eaten[w] = self.eaten[w].saturating_add(ate as u32);
            }
            self.ate_last[w] = ate;

            // -------- upkeep --------
            // Upkeep climbs with age, so an old larva dies when its habitat
            // can no longer carry it: death as a consequence, not a timer.
            let senesce = (self.age[w].saturating_sub(SENESCE_AT) >> 8) as i32;
            self.energy[w] -= METABOLIC_COST
                + senesce
                + (thrust >> MOVE_COST_SHIFT)
                + if b == BIOME_DRY { DRY_DRAIN } else { 0 }
                + if b == BIOME_POOL { POOL_DRAIN } else { 0 };

            if self.energy[w] <= 0 {
                let cause = if b == BIOME_POOL {
                    CAUSE_DROWNED
                } else if b == BIOME_DRY {
                    CAUSE_DESICCATED
                } else if self.age[w] > SENESCE_AT {
                    CAUSE_SENESCENCE
                } else {
                    CAUSE_STARVED
                };
                self.kill(w, cause);
                continue;
            }

            // -------- ring gland --------
            if rgn > 0 {
                let before = self.ecdysone[w];
                self.ecdysone[w] = before.saturating_add(rgn);
                if before < ECDYSONE_THRESHOLD && self.ecdysone[w] >= ECDYSONE_THRESHOLD {
                    self.push_event(6, w as u32, 0);
                }
            }
            if self.energy[w] >= REPRO_ENERGY && self.ecdysone[w] >= ECDYSONE_THRESHOLD {
                self.reproduce(w);
            }
        }

        self.contests();
    }

    fn hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut mix = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x100000001b3);
        };
        mix(self.tick as u64);
        mix(self.births as u64);
        mix(self.deaths as u64);
        mix(self.kills as u64);
        mix(self.next_lineage as u64);
        mix(self.capacity as u64);
        mix(self.rng.0); // RNG state drives all future evolution
        mix(self.flood_ticks as u64);
        for w in 0..MAX_POP {
            if self.alive[w] == 0 {
                continue;
            }
            mix(w as u64);
            mix(self.x[w] as u32 as u64);
            mix(self.y[w] as u32 as u64);
            mix(self.heading[w] as u64);
            mix(self.energy[w] as u32 as u64);
            mix(self.age[w] as u64);
            mix(self.generation[w] as u64);
            mix(self.lineage[w] as u64);
            mix(self.wave[w] as u64);
            mix(self.ecdysone[w] as u64);
            mix(self.last_odor[w] as u32 as u64);
            mix(self.ate_last[w] as u32 as u64);
            mix(self.bitten[w] as u64);
            mix(self.thrust_last[w] as u32 as u64);
            for s in 0..NSEG {
                mix(self.bend[w][s] as u16 as u64);
            }
            let mut g: u64 = 0;
            for e in 0..self.edge_count {
                g = g.rotate_left(5).wrapping_add(self.genome[w][e] as i32 as u32 as u64);
            }
            mix(g);
            // neural state: the anchor must see the brain, not only the body
            for i in 0..self.node_count {
                mix(self.pot[w][i] as u32 as u64);
                mix(((self.refr[w][i] as u64) << 8) | self.fired[w][i] as u64);
            }
        }
        // the whole food grid: it is highly dynamic, so the anchor is a true
        // one-step fingerprint; moisture and biome move slowly, sparse is fine
        for c in 0..GRID * GRID {
            mix(self.food[c] as u32 as u64);
        }
        for c in (0..GRID * GRID).step_by(7) {
            mix(self.moisture[c] as u64);
            mix(self.biome[c] as u64);
        }
        h
    }
}

// ---------------- exports ----------------

#[no_mangle]
pub extern "C" fn role_ptr() -> *mut u8 {
    unsafe { W.role.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn edge_pre_ptr() -> *mut u16 {
    unsafe { W.e_pre.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn edge_post_ptr() -> *mut u16 {
    unsafe { W.e_post.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn edge_weight_ptr() -> *mut i32 {
    unsafe { W.base_w.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn food_ptr() -> *const i32 {
    unsafe { W.food.as_ptr() }
}
#[no_mangle]
pub extern "C" fn moisture_ptr() -> *const u8 {
    unsafe { W.moisture.as_ptr() }
}
#[no_mangle]
pub extern "C" fn biome_ptr() -> *const u8 {
    unsafe { W.biome.as_ptr() }
}
#[no_mangle]
pub extern "C" fn genome_ptr() -> *const i16 {
    unsafe { W.genome.as_ptr() as *const i16 } // MAX_POP * MAX_EDGES, row-major
}
#[no_mangle]
pub extern "C" fn age_ptr() -> *const u32 {
    unsafe { W.age.as_ptr() }
}
#[no_mangle]
pub extern "C" fn alive_ptr() -> *const u8 {
    unsafe { W.alive.as_ptr() }
}
#[no_mangle]
pub extern "C" fn x_ptr() -> *const i32 {
    unsafe { W.x.as_ptr() }
}
#[no_mangle]
pub extern "C" fn y_ptr() -> *const i32 {
    unsafe { W.y.as_ptr() }
}
#[no_mangle]
pub extern "C" fn heading_ptr() -> *const u16 {
    unsafe { W.heading.as_ptr() }
}
#[no_mangle]
pub extern "C" fn energy_ptr() -> *const i32 {
    unsafe { W.energy.as_ptr() }
}
#[no_mangle]
pub extern "C" fn generation_ptr() -> *const u32 {
    unsafe { W.generation.as_ptr() }
}
#[no_mangle]
pub extern "C" fn lineage_ptr() -> *const u32 {
    unsafe { W.lineage.as_ptr() }
}
#[no_mangle]
pub extern "C" fn bend_ptr() -> *const i16 {
    unsafe { W.bend.as_ptr() as *const i16 } // MAX_POP * NSEG, row-major
}
#[no_mangle]
pub extern "C" fn fired_ptr() -> *const u8 {
    unsafe { W.fired.as_ptr() as *const u8 } // MAX_POP * MAX_NODES, row-major
}
#[no_mangle]
pub extern "C" fn eaten_ptr() -> *const u32 {
    unsafe { W.eaten.as_ptr() }
}
#[no_mangle]
pub extern "C" fn fed_ptr() -> *const u32 {
    unsafe { W.fed.as_ptr() }
}
/// What each larva swallowed on the last tick: the engine's own notion of a
/// feeding tick, for probes that must not confuse a bite with a graze.
#[no_mangle]
pub extern "C" fn ate_last_ptr() -> *const i32 {
    unsafe { W.ate_last.as_ptr() }
}
#[no_mangle]
pub extern "C" fn ecdysone_ptr() -> *const u32 {
    unsafe { W.ecdysone.as_ptr() }
}
#[no_mangle]
pub extern "C" fn event_ptr() -> *const u32 {
    unsafe { W.ev.as_ptr() as *const u32 }
}
#[no_mangle]
pub extern "C" fn event_head() -> u32 {
    unsafe { W.ev_head }
}
/// Host-written creature ids, one per slot. Not hashed.
#[no_mangle]
pub extern "C" fn uid_ptr() -> *mut u32 {
    unsafe { W.uid.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn nseg() -> u32 {
    NSEG as u32
}
#[no_mangle]
pub extern "C" fn max_nodes() -> u32 {
    MAX_NODES as u32
}
#[no_mangle]
pub extern "C" fn max_edges() -> u32 {
    MAX_EDGES as u32
}
#[no_mangle]
pub extern "C" fn max_pop() -> u32 {
    MAX_POP as u32
}
#[no_mangle]
pub extern "C" fn grid() -> u32 {
    GRID as u32
}
#[no_mangle]
pub extern "C" fn dish_radius() -> u32 {
    DISH_RADIUS as u32
}
/// Ambient light right now, 0..255. Lit patches are always 255.
#[no_mangle]
pub extern "C" fn light_now() -> u32 {
    unsafe { W.ambient() as u32 }
}
/// Temperature right now in centi-degrees Celsius (2400 = 24 C).
#[no_mangle]
pub extern "C" fn temp_now() -> i32 {
    unsafe { W.temperature() }
}
/// Food ceiling for a substrate class, so the renderer can shade a cell by
/// how full it is rather than against one global maximum.
#[no_mangle]
pub extern "C" fn biome_foodcap(b: u32) -> i32 {
    FOODCAP[(b as usize).min(7)]
}

#[no_mangle]
pub extern "C" fn world_init(seed: u64, node_count: u32, edge_count: u32, start_pop: u32) {
    let w = unsafe { &mut W };
    assert!(node_count as usize <= MAX_NODES && edge_count as usize <= MAX_EDGES);
    w.node_count = node_count as usize;
    w.edge_count = edge_count as usize;
    // reject any edge endpoint that is out of range, so a malformed graph
    // fails loudly here instead of panicking mid-step or simulating a
    // phantom node
    for e in 0..w.edge_count {
        assert!(
            (w.e_pre[e] as usize) < w.node_count && (w.e_post[e] as usize) < w.node_count,
            "edge endpoint out of range"
        );
    }
    // CSR by presynaptic node: counting sort of the canonical edge list, so
    // out-edges of one node keep canonical order
    {
        let n = w.node_count;
        w.out_start[..=n].fill(0);
        for e in 0..w.edge_count {
            w.out_start[w.e_pre[e] as usize + 1] += 1;
        }
        for i in 0..n {
            w.out_start[i + 1] += w.out_start[i];
        }
        let mut fill = [0u32; MAX_NODES];
        fill[..n].copy_from_slice(&w.out_start[..n]);
        for e in 0..w.edge_count {
            let a = w.e_pre[e] as usize;
            let k = fill[a] as usize;
            fill[a] += 1;
            w.out_edge[k] = e as u32;
            w.out_post[k] = w.e_post[e];
        }
    }
    // The effective weight ceiling is DERIVED from this graph's real fan-in,
    // because the bound that matters is the summed drive into one node:
    // dmax * w_max * SYN_GAIN must stay well inside i32. The larval brain has
    // a max in-degree of 210. Consumes no RNG.
    {
        let mut indeg = [0u16; MAX_NODES];
        for e in 0..w.edge_count {
            indeg[w.e_post[e] as usize] += 1;
        }
        let dmax = indeg.iter().copied().max().unwrap_or(1).max(1) as i32;
        w.w_max = ((i32::MAX / 2) / (SYN_GAIN * dmax)).min(W_CAP).max(1);
    }
    w.rng = Rng(if seed == 0 { 0x9E3779B97F4A7C15 } else { seed });
    w.tick = 0;
    w.births = 0;
    w.deaths = 0;
    w.kills = 0;
    w.capacity = 40; // genesis default
    w.ev = [[0; 4]; 256];
    w.max_gen = 0;
    w.ev_head = 0;
    w.alive = [0; MAX_POP];
    w.eaten = [0; MAX_POP];
    w.fed = [0; MAX_POP];
    w.uid = [UID_UNASSIGNED; MAX_POP];
    w.flood_ticks = 0;
    w.food = [0; GRID * GRID];
    w.gen_dish();
    // A modest starting larder, sized to each substrate and costing zero RNG
    // draws: the first generations eat the dish down toward its equilibrium.
    for c in 0..GRID * GRID {
        w.food[c] = FOODCAP[w.biome[c] as usize] / 2;
    }
    w.next_lineage = 0;
    let sp = (start_pop as usize).min(MAX_POP);
    // founders spawn together (they must find each other to breed)
    let (fx, fy) = w.dish_spot();
    for i in 0..sp {
        let (mut px, mut py) = (fx, fy);
        if i > 0 {
            px = fx + (w.rng.below((8 << FP) + 1) as i32) - (4 << FP);
            py = fy + (w.rng.below((8 << FP) + 1) as i32) - (4 << FP);
            if !w.spawnable(cell_of(px, py)) {
                px = fx;
                py = fy;
            }
        }
        w.write_genesis_genome(i);
        let lin = w.next_lineage;
        w.next_lineage += 1;
        w.spawn(i, px, py, 0, lin, START_ENERGY);
        w.births += 1;
        w.push_event(1, i as u32, NO_PARENT);
    }
}

#[no_mangle]
pub extern "C" fn step(ticks: u32) {
    let w = unsafe { &mut W };
    for _ in 0..ticks {
        w.tick_one();
    }
}

#[no_mangle]
pub extern "C" fn get_tick() -> u32 {
    unsafe { W.tick }
}
#[no_mangle]
pub extern "C" fn pop_count() -> u32 {
    unsafe { W.alive.iter().filter(|a| **a == 1).count() as u32 }
}
#[no_mangle]
pub extern "C" fn births_total() -> u32 {
    unsafe { W.births }
}
#[no_mangle]
pub extern "C" fn deaths_total() -> u32 {
    unsafe { W.deaths }
}
#[no_mangle]
pub extern "C" fn kills_total() -> u32 {
    unsafe { W.kills }
}
#[no_mangle]
pub extern "C" fn max_generation() -> u32 {
    unsafe { W.max_gen }
}
#[no_mangle]
pub extern "C" fn set_capacity(c: u32) {
    unsafe { W.capacity = c.min(MAX_POP as u32) }
}
#[no_mangle]
pub extern "C" fn state_hash() -> u64 {
    unsafe { W.hash() }
}

/// FNV-1a over one creature's genome (canonical edge order): the identity
/// hash minted into its on-chain Creature account at birth.
#[no_mangle]
pub extern "C" fn creature_genome_hash(slot: u32) -> u64 {
    let w = unsafe { &W };
    let slot = slot as usize % MAX_POP;
    let mut h: u64 = 0xcbf29ce484222325;
    for e in 0..w.edge_count {
        h ^= w.genome[slot][e] as i32 as u32 as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// resolve a live creature by its host-assigned uid; the unassigned sentinel
/// names nobody, even though unlabelled slots carry it
fn slot_of_uid(w: &World, target: u32) -> Option<usize> {
    if target == UID_UNASSIGNED {
        return None;
    }
    (0..MAX_POP).find(|&s| w.alive[s] == 1 && w.uid[s] == target)
}

/// Keeper care: drop food on the larva's own cell (paid, journaled,
/// deterministic). Tallied in `fed` so it never counts as the world's reward.
#[no_mangle]
pub extern "C" fn int_provision(uid: u32) {
    let w = unsafe { &mut W };
    let Some(s) = slot_of_uid(w, uid) else { return };
    let c = cell_of(w.x[s], w.y[s]);
    if w.biome[c] == BIOME_WALL || w.biome[c] == BIOME_POOL {
        return;
    }
    w.deposit(c, PROVISION_FOOD);
    w.fed[s] = w.fed[s].saturating_add(PROVISION_FOOD as u32);
}

/// Keeper liquidation: cull by uid.
#[no_mangle]
pub extern "C" fn int_kill(uid: u32) {
    let w = unsafe { &mut W };
    if let Some(s) = slot_of_uid(w, uid) {
        w.kill(s, CAUSE_CULLED);
    }
}

/// Re-genesis: if the world ever empties, fresh founders from the registered
/// genesis genome, new lineage ids, journaled like any other input.
#[no_mangle]
pub extern "C" fn spawn_founders(n: u32) {
    let w = unsafe { &mut W };
    for _ in 0..n {
        let Some(slot) = w.alive.iter().position(|a| *a == 0) else { return };
        let (px, py) = w.dish_spot();
        w.write_genesis_genome(slot);
        let lin = w.next_lineage;
        w.next_lineage += 1;
        w.spawn(slot, px, py, 0, lin, START_ENERGY);
        w.births += 1;
        w.push_event(1, slot as u32, NO_PARENT);
    }
}

/// Every pool grows by one cell for FLOOD_TICKS. Food on the newly liquid
/// cells is washed out. A larva that reads its respiratory and pain neurons
/// and leaves can survive it; that is the difference between a hazard and a
/// coin toss.
#[no_mangle]
pub extern "C" fn int_flood() {
    let w = unsafe { &mut W };
    let mut grow = [0u8; GRID * GRID / 8];
    for c in 0..GRID * GRID {
        if !matches!(w.biome[c], BIOME_AGAR | BIOME_YEAST | BIOME_FRUIT | BIOME_DRY | BIOME_LIT) {
            continue;
        }
        let (cx, cy) = ((c % GRID) as i32, (c / GRID) as i32);
        let mut near_pool = false;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (x, y) = (cx + dx, cy + dy);
                if x >= 0 && y >= 0 && x < GRID as i32 && y < GRID as i32 {
                    near_pool |= w.biome[y as usize * GRID + x as usize] == BIOME_POOL;
                }
            }
        }
        if near_pool {
            grow[c >> 3] |= 1 << (c & 7);
        }
    }
    for c in 0..GRID * GRID {
        if grow[c >> 3] & (1 << (c & 7)) != 0 {
            w.flood_mask[c >> 3] |= 1 << (c & 7);
            w.biome[c] = BIOME_POOL;
            w.food[c] = 0;
        }
    }
    w.flood_ticks = FLOOD_TICKS;
    w.push_event(3, 0, 0);
}

/// A yeast bloom: food lands in a radius-6 disc around the cell.
#[no_mangle]
pub extern "C" fn int_yeast_bloom(cx: u32, cy: u32) {
    let w = unsafe { &mut W };
    for dy in -BLOOM_RADIUS..=BLOOM_RADIUS {
        for dx in -BLOOM_RADIUS..=BLOOM_RADIUS {
            if dx * dx + dy * dy > BLOOM_RADIUS * BLOOM_RADIUS {
                continue;
            }
            let (x, y) = (cx as i32 + dx, cy as i32 + dy);
            if x < 0 || y < 0 || x >= GRID as i32 || y >= GRID as i32 {
                continue;
            }
            w.deposit(y as usize * GRID + x as usize, BLOOM_FOOD);
        }
    }
    w.push_event(4, cx, cy);
}

/// A dry spell: food quartered and moisture down everywhere. The crust
/// spreads wherever the moisture falls under the threshold and recedes as
/// the sweep restores it.
#[no_mangle]
pub extern "C" fn int_dry_spell() {
    let w = unsafe { &mut W };
    for c in 0..GRID * GRID {
        w.food[c] >>= 2;
        w.moisture[c] = w.moisture[c].saturating_sub(DRY_SPELL_MOISTURE);
        w.biome[c] = w.classify(c);
    }
    w.push_event(5, 0, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 6 nodes: 0 ORN, 1 GUST_EXT, 2 DN_L, 3 DN_R, 4 DN_SEZ, 5 RGN; the two
    /// sensors drive every effector with a weight that fires it on one spike.
    fn tiny_graph() {
        unsafe {
            W.role[..8].fill(ROLE_NONE);
            W.role[0] = ROLE_ORN;
            W.role[1] = ROLE_GUST_EXT;
            W.role[2] = ROLE_DN_L;
            W.role[3] = ROLE_DN_R;
            W.role[4] = ROLE_DN_SEZ;
            W.role[5] = ROLE_RGN;
            let pre = [0u16, 0, 1, 1, 0, 1];
            let post = [2u16, 3, 4, 5, 4, 2];
            for e in 0..6 {
                W.e_pre[e] = pre[e];
                W.e_post[e] = post[e];
                W.base_w[e] = 30;
            }
        }
    }

    #[test]
    fn deterministic_replay() {
        tiny_graph();
        world_init(42, 6, 6, 8);
        step(5000);
        let h1 = state_hash();
        let t1 = get_tick();
        world_init(42, 6, 6, 8);
        step(5000);
        assert_eq!(get_tick(), t1);
        assert_eq!(state_hash(), h1, "same seed must replay bit-identically");
    }

    #[test]
    fn different_seed_diverges() {
        tiny_graph();
        world_init(42, 6, 6, 8);
        step(2000);
        let h1 = state_hash();
        world_init(43, 6, 6, 8);
        step(2000);
        assert_ne!(state_hash(), h1);
    }

    #[test]
    fn population_lives_and_events_flow() {
        tiny_graph();
        world_init(7, 6, 6, 12);
        step(20_000);
        assert!(births_total() + deaths_total() > 12, "no lifecycle events in 20k ticks");
        let alive = unsafe { &W.alive };
        let biome = unsafe { &W.biome };
        for s in 0..MAX_POP {
            if alive[s] == 1 {
                let c = cell_of(unsafe { W.x[s] }, unsafe { W.y[s] });
                assert_ne!(biome[c], BIOME_WALL, "a larva is inside the wall");
            }
        }
    }

    // Run under the `ci` profile (overflow-checks ON): any integer overflow in
    // a long-running world panics here instead of silently wrapping the
    // fossil record. 2M ticks with births/deaths/contests/interrupts.
    #[test]
    fn long_run_no_overflow_no_panic() {
        tiny_graph();
        world_init(0xABCDEF, 6, 6, 24);
        for round in 0..40u32 {
            step(50_000);
            unsafe { W.uid[0] = 7 };
            int_provision(7);
            match round % 4 {
                0 => int_flood(),
                1 => int_yeast_bloom(64, 64),
                2 => int_dry_spell(),
                _ => {}
            }
            if pop_count() == 0 {
                spawn_founders(4);
            }
        }
        assert!(get_tick() >= 2_000_000);
        let _ = state_hash(); // must not panic
    }

    // eaten/fed/uid must not perturb the state hash (derived or host labels)
    #[test]
    fn eaten_excluded_from_hash() {
        tiny_graph();
        world_init(123, 6, 6, 8);
        step(30_000);
        let h = state_hash();
        world_init(123, 6, 6, 8);
        step(30_000);
        assert_eq!(state_hash(), h);
        unsafe {
            W.eaten[0] = W.eaten[0].wrapping_add(12_345);
            W.fed[0] = W.fed[0].wrapping_add(999);
            W.uid[0] = 4242;
        }
        assert_eq!(state_hash(), h, "eaten/fed/uid leaked into the hash");
    }

    // The event-driven CSR walk must equal the naive per-edge sweep on a
    // random graph with random weights and a random firing pattern.
    #[test]
    fn csr_matches_naive() {
        const N: u32 = 64;
        const E: u32 = 400;
        let mut r = Rng(0x5EED);
        unsafe {
            W.role[..N as usize].fill(ROLE_NONE);
            for e in 0..E as usize {
                W.e_pre[e] = r.below(N) as u16;
                W.e_post[e] = r.below(N) as u16;
                W.base_w[e] = 1;
            }
        }
        world_init(9, N, E, 2);
        let w = unsafe { &mut W };
        for e in 0..E as usize {
            w.genome[0][e] = (r.below(2 * w.w_max as u32 + 1) as i32 - w.w_max) as i16;
        }
        for i in 0..N as usize {
            w.fired[0][i] = (r.below(3) == 0) as u8;
        }
        let mut fast = [0i32; MAX_NODES];
        w.propagate(0, &mut fast);
        let mut naive = [0i32; MAX_NODES];
        for e in 0..E as usize {
            if w.fired[0][w.e_pre[e] as usize] == 1 {
                let b = w.e_post[e] as usize;
                naive[b] = naive[b].saturating_add(w.genome[0][e] as i32 * SYN_GAIN);
            }
        }
        assert!(fast[..N as usize].iter().any(|v| *v != 0), "nothing propagated");
        assert_eq!(fast[..N as usize], naive[..N as usize]);
    }

    #[test]
    fn silent_sez_never_eats() {
        tiny_graph();
        world_init(5, 6, 6, 4);
        unsafe {
            for s in 0..4 {
                W.genome[s][..6].fill(0);
            }
        }
        step(2_000);
        let eaten = unsafe { &W.eaten };
        assert!(eaten[..4].iter().all(|e| *e == 0), "a larva ate with no SEZ output");
    }

    // Two parents standing in a 5x5 pool with one agar cell touching the
    // centre: every child must be born on that cell, whichever way the
    // jitter falls, never in the liquid.
    #[test]
    fn child_not_born_in_pool_beside_open_agar() {
        tiny_graph();
        world_init(11, 6, 6, 2);
        let w = unsafe { &mut W };
        let (cx, cy) = (64usize, 64usize);
        for dy in 0..5 {
            for dx in 0..5 {
                w.biome[(cy + dy - 2) * GRID + cx + dx - 2] = BIOME_POOL;
            }
        }
        let agar = cy * GRID + cx + 1;
        w.biome[agar] = BIOME_AGAR;
        let half = 1 << (FP - 1);
        for round in 0..64 {
            for s in 0..2 {
                w.alive[s] = 1;
                w.x[s] = ((cx as i32) << FP) + half;
                w.y[s] = ((cy as i32) << FP) + half;
                w.energy[s] = REPRO_ENERGY;
            }
            w.alive[2..].fill(0);
            let births = w.births;
            w.reproduce(0);
            assert_eq!(w.births, births + 1, "round {round}: no child");
            let child = cell_of(w.x[2], w.y[2]);
            assert_eq!(child, agar, "round {round}: child born in the pool");
        }
    }

    // The unassigned uid names nobody: a keeper action aimed at it must not
    // land on the first unlabelled larva.
    #[test]
    fn unassigned_uid_matches_no_slot() {
        tiny_graph();
        world_init(3, 6, 6, 4);
        assert_eq!(pop_count(), 4);
        int_kill(UID_UNASSIGNED);
        assert_eq!(pop_count(), 4, "int_kill(UID_UNASSIGNED) culled a larva");
        unsafe { W.uid[1] = 9 };
        int_kill(9);
        assert_eq!(pop_count(), 3);
    }
}
