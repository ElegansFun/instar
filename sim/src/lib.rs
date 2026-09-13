//! Instar world engine: deterministic life in a lab fly cage, each adult
//! male fly driven by the Janelia MaleCNS v1.0 connectome (every neuron of
//! the male central nervous system, every connection of five or more
//! synapses).
//!
//! Rules of the crate:
//! - Integer math only. No floats anywhere: same seed + same genome set
//!   produces a bit-identical world on every platform (WASM in the verifier,
//!   native in the world process).
//! - The genome IS the edge-weight vector of the registered canonical file,
//!   in canonical edge order (sorted by (pre, post), so the CSR built here is
//!   the canonical order and the edge index is the genome index). Generation
//!   zero runs the literal published synapse counts.
//! - The neuron model is threshold accumulate-and-fire over the real wiring
//!   (leak, refractory period). Everything the connectome does not give us
//!   (dynamics, neuromodulation, muscles, the physics of a body) is a stated
//!   simplification: motor-neuron roles are read as leg drive per side, wing
//!   power and steering, haltere, proboscis pump and abdomen; the
//!   neurosecretory cells gate reproduction.
//! - No compile-time capacities. `world_alloc` sizes every slab from the
//!   graph and the population cap; indices are u32.
//!
//! The host allocates, writes the graph (roles, CSR, weights) through the
//! exported pointers, calls `world_init`, then `step`. Everything observable
//! is a pointer into linear memory. `state_hash` is the replay-verification
//! anchor: the number the world process posts on-chain each epoch.

#![allow(static_mut_refs)]

mod body;
mod brain;
mod cage;
#[cfg(test)]
mod tests;

pub const GRID: usize = 128;
/// Flight layers: `z` runs `0 .. LAYERS << FP`.
pub const LAYERS: i32 = 16;
pub const FP: i32 = 16; // 16.16 fixed point, world coords in grid-cell units
pub const XMAX: i32 = (GRID as i32) << FP;
pub const ZTOP: i32 = LAYERS << FP;
pub const HALF: i32 = 1 << (FP - 1);
pub const POSE_LEN: usize = 12;
pub const FIRE_GROUPS: usize = 12;
pub const MAX_POP_LIMIT: usize = 64;
pub const ROLE_MAX: usize = 64;
pub const NLEGS: usize = 6;
pub const DISHES: usize = 4;

// roles (written by host from annotation fields; see scripts/roles.mjs)
pub const ROLE_NONE: u8 = 0;
pub const ROLE_ORN: u8 = 1;
pub const ROLE_GRN_SWEET: u8 = 2;
pub const ROLE_GRN_BITTER: u8 = 3;
pub const ROLE_JON: u8 = 4;
pub const ROLE_BRISTLE: u8 = 5;
pub const ROLE_CHORDOTONAL: u8 = 6;
pub const ROLE_THERMO_HOT: u8 = 7;
pub const ROLE_THERMO_COLD: u8 = 8;
pub const ROLE_HYGRO: u8 = 9;
pub const ROLE_PR_R1_6: u8 = 10; // left eye (or side unknown)
pub const ROLE_PR_R7_8: u8 = 11;
pub const ROLE_OCELLAR: u8 = 12;
pub const ROLE_HALTERE: u8 = 13;
pub const ROLE_TASTE_LEG: u8 = 14;
pub const ROLE_INTERO: u8 = 15;
pub const ROLE_PR_R1_6_R: u8 = 16;
pub const ROLE_PR_R7_8_R: u8 = 17;
pub const ROLE_MN_LEG_L1: u8 = 20;
pub const ROLE_MN_LEG_L2: u8 = 21;
pub const ROLE_MN_LEG_L3: u8 = 22;
pub const ROLE_MN_LEG_R1: u8 = 23;
pub const ROLE_MN_LEG_R2: u8 = 24;
pub const ROLE_MN_LEG_R3: u8 = 25;
pub const ROLE_MN_WING_POWER_L: u8 = 26;
pub const ROLE_MN_WING_POWER_R: u8 = 27;
pub const ROLE_MN_WING_STEER_L: u8 = 28;
pub const ROLE_MN_WING_STEER_R: u8 = 29;
pub const ROLE_MN_HALTERE_L: u8 = 30;
pub const ROLE_MN_HALTERE_R: u8 = 31;
pub const ROLE_MN_NECK: u8 = 32;
pub const ROLE_MN_PROBOSCIS: u8 = 33;
pub const ROLE_MN_ABDOMEN: u8 = 34;
pub const ROLE_DN_L: u8 = 40;
pub const ROLE_DN_R: u8 = 41;
pub const ROLE_DN_C: u8 = 42;
pub const ROLE_AN: u8 = 43;
pub const ROLE_NEUROSECRETORY: u8 = 50;

// fired-count groups (see sim/ABI.md)
pub const GROUP_ANY: usize = 0;
pub const GROUP_SENS: usize = 1;
pub const GROUP_DN: usize = 2;
pub const GROUP_LEG_L: usize = 3;
pub const GROUP_LEG_R: usize = 4;
pub const GROUP_WING_P: usize = 5;
pub const GROUP_WING_S: usize = 6;
pub const GROUP_HALTERE: usize = 7;
pub const GROUP_PROB: usize = 8;
pub const GROUP_NEURO: usize = 9;
pub const GROUP_AN: usize = 10;
pub const GROUP_OTHER: usize = 11;

pub const fn group_of(role: u8) -> usize {
    match role {
        1..=17 => GROUP_SENS,
        ROLE_DN_L | ROLE_DN_R | ROLE_DN_C => GROUP_DN,
        ROLE_MN_LEG_L1 | ROLE_MN_LEG_L2 | ROLE_MN_LEG_L3 => GROUP_LEG_L,
        ROLE_MN_LEG_R1 | ROLE_MN_LEG_R2 | ROLE_MN_LEG_R3 => GROUP_LEG_R,
        ROLE_MN_WING_POWER_L | ROLE_MN_WING_POWER_R => GROUP_WING_P,
        ROLE_MN_WING_STEER_L | ROLE_MN_WING_STEER_R => GROUP_WING_S,
        ROLE_MN_HALTERE_L | ROLE_MN_HALTERE_R => GROUP_HALTERE,
        ROLE_MN_PROBOSCIS => GROUP_PROB,
        ROLE_NEUROSECRETORY => GROUP_NEURO,
        ROLE_AN => GROUP_AN,
        _ => GROUP_OTHER,
    }
}

// ---------------------------------------------------------------- neurons
pub(crate) const THRESH: i32 = 16_384;
pub(crate) const REFRACTORY: u8 = 3;
/// Leak: a quarter of the potential per tick (100 ms at the world's 10
/// ticks/s: a membrane time constant of ~3.5 ticks, 350 ms), so a steady
/// input `I` settles at `4 * I` and a node fires when its recent input
/// averages above `THRESH / 4 = 4,096`.
pub(crate) const LEAK_SHIFT: i32 = 2;
/// A potential this close to rest is rest: the node leaves the active set
/// instead of lingering for tens of ticks under the leak's rounding.
pub(crate) const POT_REST: i32 = THRESH >> 4;
/// A synapse count of 1 is worth this much potential per presynaptic spike
/// (a power of two so the multiply is a shift). Unnormalised, one spike
/// over sixteen synapses reaches `THRESH`; but recurrent input is scaled by
/// `norm / (norm + spikes last tick)` and anything under `POT_REST` snaps
/// to rest, so in the measured genesis regime (norm 40, ~1,750 spikes per
/// fly-tick) a synapse-spike is worth ~23: a single spike registers only
/// over 45 synapses and fires its target only over ~720; a sustained input
/// needs ~180 synapse-spikes per tick. The sixteen-synapse rule holds for
/// a silent brain. Sensory drive is not scaled.
pub(crate) const SYN_GAIN: i32 = 1024;
/// The dataset records no synapse polarity, so every published weight is
/// read as excitatory, and a fully excitatory recurrent graph of this size
/// self-amplifies to the refractory ceiling. This is the stated
/// simplification that stands in for inhibition: recurrent input is scaled
/// by `NORM / (NORM + spikes last tick)`, so the brain settles where its own
/// gain is about one and stays sensitive to what the senses add. Sensory
/// afferents are not scaled: the stimulus sets them. Uniform, it claims
/// nothing about which neurons are inhibitory. `NORM` grows with the graph
/// (`norm`): 1/4096 of the nodes, at least 32.
pub(crate) const NORM_MIN: i32 = 32;
pub(crate) const NORM_SHIFT: u32 = 12;
/// Ceiling on any weight, genesis or evolved: it fits the i16 genome, and the
/// largest published synapse count in the MaleCNS (2,591) is far under it,
/// so generation zero really is the published counts. The summed drive
/// into one node is `indeg * w * SYN_GAIN`, which can exceed i32 only for
/// an evolved genome near the cap on a node of extreme fan-in; the
/// accumulator saturates instead of wrapping (see `brain::propagate`).
pub(crate) const W_CAP: i32 = 8_192;
pub(crate) const POT_CLAMP: i32 = 1 << 24;
/// Membrane potential floor: inhibitory bursts cannot silence a neuron for
/// hundreds of ticks.
pub(crate) const POT_FLOOR: i32 = -65_536;

// ---------------------------------------------------------------- cage
pub const BIOME_FLOOR: u8 = 0;
pub const BIOME_YEAST: u8 = 1;
pub const BIOME_BANANA: u8 = 2;
pub const BIOME_WATER: u8 = 3;
pub const BIOME_SALT: u8 = 4;
pub const BIOME_COUNT: usize = 5;

/// What each substrate is worth, per 128-tick sweep and in total store.
/// The floor is the cage's cornmeal-agar medium: a thin, slowly renewing
/// meal everywhere; the dishes are the rich patches.
///                                   FLOOR YEAST  BANANA WATER SALT
pub(crate) const REGROW: [i32; BIOME_COUNT] = [24, 96, 8, 0, 2];
pub(crate) const FOODCAP: [i32; BIOME_COUNT] = [1_500, 12_000, 30_000, 0, 400];
/// Deposits (corpses, provisions, blooms) may exceed the regrowth cap; this
/// is the absolute ceiling so a cell can never overflow.
pub(crate) const FOOD_MAX: i32 = 1 << 20;
pub(crate) const DISH_HEIGHT: u8 = 1;
pub(crate) const DRY_MOIST: u8 = 40;
pub(crate) const DRY_SPELL_MOISTURE: u8 = 40;
pub(crate) const BLOOM_FOOD: i32 = 26_000;
pub(crate) const BLOOM_RADIUS: i32 = 6;
pub(crate) const PROVISION_FOOD: i32 = 30_000;
pub(crate) const CORPSE_FOOD: i32 = 3_000;
/// Odour: a multiplicative chamfer decay of 7/8 per cell on the floor,
/// refreshed every 8 ticks; thins linearly with height.
pub(crate) const ODOR_REFRESH_MASK: u32 = 7;

/// Day/night: period 16,384 ticks (27.3 min at the world's 10 t/s), a power
/// of two so the cycle stays exact across the u32 tick wrap. Temperature:
/// period 131,072.
pub(crate) const DAY_SHIFT: u32 = 2;
pub(crate) const TEMP_SHIFT: u32 = 1;
pub(crate) const TEMP_BASE: i32 = 2_400;
pub(crate) const TEMP_AMP: i32 = 600;
/// Linear gradient across the cage, hot on the lamp's side: +-300 cC.
pub(crate) const TEMP_GRAD: i32 = 300;
/// Lamp: 255 at the bulb, falling as K / (K + d^2) in cell units.
pub(crate) const LAMP_K: i32 = 64;

// ---------------------------------------------------------------- ecology
pub const CAUSE_STARVED: u8 = 1;
pub const CAUSE_SENESCENCE: u8 = 2;
pub const CAUSE_KILLED: u8 = 3;
pub const CAUSE_DESICCATED: u8 = 4;
pub const CAUSE_DROWNED: u8 = 5;
pub const CAUSE_CULLED: u8 = 6;
pub const CAUSE_EXHAUSTED: u8 = 7;
pub const NO_PARENT: u32 = 0xFF;
/// `uid` is host-assigned at birth; a fresh slot carries this until then so a
/// stale uid from the slot's previous occupant can never be matched.
pub const UID_UNASSIGNED: u32 = u32::MAX;

pub const EV_BIRTH: u32 = 1;
pub const EV_DEATH: u32 = 2;
pub const EV_LIGHTS_OFF: u32 = 3;
pub const EV_BLOOM: u32 = 4;
pub const EV_DRY_SPELL: u32 = 5;
pub const EV_MATURE: u32 = 6;
pub const EV_TAKEOFF: u32 = 7;
pub const EV_LANDING: u32 = 8;
/// Event ring length in records: 40 flies draining every 128 ticks peaked
/// at 53 records per chunk on the MaleCNS (takeoff/landing pairs); 4,096 is
/// 64 KB and ~75x that.
pub const EV_RING: usize = 4_096;

pub const MODE_WALK: u8 = 0;
pub const MODE_FLY: u8 = 1;
pub const SURF_FLOOR: u8 = 0;
pub const SURF_WALL_W: u8 = 1;
pub const SURF_WALL_E: u8 = 2;
pub const SURF_WALL_N: u8 = 3;
pub const SURF_WALL_S: u8 = 4;
pub const SURF_CEILING: u8 = 5;
pub const SURF_NONE: u8 = 0xFF;

pub(crate) const START_ENERGY: i32 = 20_000;
pub(crate) const ENERGY_CAP: i32 = 60_000;
pub(crate) const REPRO_ENERGY: i32 = 45_000;
pub(crate) const SATIETY: i32 = 30_000;

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
pub(crate) fn isin(angle: u16) -> i32 {
    SIN[(angle >> 8) as usize] as i32
}
#[inline]
pub(crate) fn icos(angle: u16) -> i32 {
    SIN[(angle.wrapping_add(16_384) >> 8) as usize] as i32
}

pub(crate) struct Rng(pub u64);
impl Rng {
    #[inline]
    pub fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        (self.next() >> 33) as u32 % n.max(1)
    }
}

/// Cell index of a 16.16 position. Positions never leave the cage, but the
/// clamp keeps an index in range under every input.
#[inline]
pub(crate) fn cell_of(x: i32, y: i32) -> usize {
    let cx = (x >> FP).clamp(0, GRID as i32 - 1) as usize;
    let cy = (y >> FP).clamp(0, GRID as i32 - 1) as usize;
    cy * GRID + cx
}

pub(crate) struct World {
    // graph (shared by every fly; host-written after world_alloc)
    pub n: usize,
    pub e: usize,
    pub p: usize,
    pub role: Vec<u8>,
    /// CSR by presynaptic node in canonical edge order: the out-edges of
    /// node `a` are `out_start[a]..out_start[a+1]`, edge index == genome
    /// index, `out_post` its target.
    pub out_start: Vec<u32>,
    pub out_post: Vec<u32>,
    pub base_w: Vec<i32>,
    /// Nodes grouped by role (counting sort in node order), built at init.
    pub role_start: [u32; ROLE_MAX + 1],
    pub role_nodes: Vec<u32>,
    pub norm: i32,
    /// Digest of the genesis genome (every founder starts here).
    pub base_digest: u64,

    // cage
    pub food: Vec<i32>,
    pub biome: Vec<u8>,
    pub height: Vec<u8>,
    pub moisture: Vec<u8>,
    pub moisture0: Vec<u8>,
    pub odor: Vec<i32>,
    pub dish: [[u8; 4]; DISHES], // kind, x, y, r
    pub water: [u8; 3],          // x, y, r
    pub lamp: [u8; 2],
    pub salt_corner: u8,
    pub lights_off_ticks: u32,
    pub rng: Rng,
    pub tick: u32,
    pub capacity: u32,

    // population (struct of arrays, length p)
    pub alive: Vec<u8>,
    pub x: Vec<i32>,
    pub y: Vec<i32>,
    pub z: Vec<i32>,
    pub heading: Vec<u16>,
    pub pitch: Vec<i16>,
    pub roll: Vec<i16>,
    pub mode: Vec<u8>,
    pub surface: Vec<u8>,
    pub energy: Vec<i32>,
    pub generation: Vec<u32>,
    pub lineage: Vec<u32>,
    pub age: Vec<u32>,
    pub hormone: Vec<u32>,
    pub wingbeat: Vec<u16>,
    pub gait: Vec<u16>,
    pub proboscis: Vec<u8>,
    /// Smoothed wing-power motor rate (x4096 spikes/tick): the takeoff and
    /// landing decision.
    pub wing_rate: Vec<i32>,
    /// Sensory memory of the previous tick, all of it feeding the sensory
    /// input next tick and therefore hashed.
    pub last_odor: Vec<i32>,
    pub ate_last: Vec<i32>,
    pub bitten: Vec<u8>,
    pub thrust_last: Vec<i32>,
    pub turn_last: Vec<i32>,
    pub contact: Vec<u8>,
    /// lifetime energy consumed (grazing + contest wins). Observability
    /// counter for the economy; deliberately NOT part of the state hash: it
    /// derives deterministically from stepping.
    pub eaten: Vec<u32>,
    /// lifetime food gained from keeper PROVISION actions, so paying to feed
    /// cannot count as work the world rewards.
    pub fed: Vec<u32>,
    /// Host-assigned creature id; a pure label, not hashed, no behavioural
    /// effect. `int_provision`/`int_kill` target by it so slot reuse can never
    /// hit the wrong fly.
    pub uid: Vec<u32>,
    /// Incremental genome digest, maintained at every genome write.
    pub digest: Vec<u64>,
    pub pose: Vec<i16>,
    pub fired_count: Vec<u32>,
    pub genome: Vec<i16>,
    /// Per-fly node state: potential (30 bits) and refractory count (2 bits),
    /// packed so one word serves both (see brain::pack).
    pub ns: Vec<u32>,
    pub fired: Vec<u8>,
    /// Per-fly active set: bitmap + list of nodes with nonzero potential,
    /// refractory time or last-tick spike (invariant: any nonzero node state
    /// is in the list), and the list of nodes that fired last tick.
    pub active: Vec<u64>,
    pub touched: Vec<u32>,
    pub touched_len: Vec<u32>,
    pub fired_list: Vec<u32>,
    pub fired_len: Vec<u32>,
    /// Scratch, zero between ticks: recurrent input per node.
    pub inp: Vec<i32>,

    pub births: u32,
    pub deaths: u32,
    pub kills: u32,
    pub next_lineage: u32,
    pub max_gen: u32,

    // event ring: (tick, kind, a, b)
    pub ev: [[u32; 4]; EV_RING],
    pub ev_head: u32,
}

/// Every slab is empty until `world_alloc`; every scalar is set by
/// `world_init` before anything reads it.
static mut W: World = World {
    n: 0,
    e: 0,
    p: 0,
    role: Vec::new(),
    out_start: Vec::new(),
    out_post: Vec::new(),
    base_w: Vec::new(),
    role_start: [0; ROLE_MAX + 1],
    role_nodes: Vec::new(),
    norm: NORM_MIN,
    base_digest: 0,
    food: Vec::new(),
    biome: Vec::new(),
    height: Vec::new(),
    moisture: Vec::new(),
    moisture0: Vec::new(),
    odor: Vec::new(),
    dish: [[0; 4]; DISHES],
    water: [0; 3],
    lamp: [0; 2],
    salt_corner: 0,
    lights_off_ticks: 0,
    rng: Rng(0),
    tick: 0,
    capacity: 0,
    alive: Vec::new(),
    x: Vec::new(),
    y: Vec::new(),
    z: Vec::new(),
    heading: Vec::new(),
    pitch: Vec::new(),
    roll: Vec::new(),
    mode: Vec::new(),
    surface: Vec::new(),
    energy: Vec::new(),
    generation: Vec::new(),
    lineage: Vec::new(),
    age: Vec::new(),
    hormone: Vec::new(),
    wingbeat: Vec::new(),
    gait: Vec::new(),
    proboscis: Vec::new(),
    wing_rate: Vec::new(),
    last_odor: Vec::new(),
    ate_last: Vec::new(),
    bitten: Vec::new(),
    thrust_last: Vec::new(),
    turn_last: Vec::new(),
    contact: Vec::new(),
    eaten: Vec::new(),
    fed: Vec::new(),
    uid: Vec::new(),
    digest: Vec::new(),
    pose: Vec::new(),
    fired_count: Vec::new(),
    genome: Vec::new(),
    ns: Vec::new(),
    fired: Vec::new(),
    active: Vec::new(),
    touched: Vec::new(),
    touched_len: Vec::new(),
    fired_list: Vec::new(),
    fired_len: Vec::new(),
    inp: Vec::new(),
    births: 0,
    deaths: 0,
    kills: 0,
    next_lineage: 0,
    max_gen: 0,
    ev: [[0; 4]; EV_RING],
    ev_head: 0,
};

fn zeroed<T: Copy>(v: T, len: usize) -> Vec<T> {
    let mut out = Vec::with_capacity(len);
    out.resize(len, v);
    out
}

impl World {
    /// Size every slab. Returns false for an unusable request.
    fn alloc(&mut self, n: usize, e: usize, p: usize) -> bool {
        if n == 0 || e == 0 || p == 0 || p > MAX_POP_LIMIT || n >= u32::MAX as usize - 1 {
            return false;
        }
        self.n = n;
        self.e = e;
        self.p = p;
        self.role = zeroed(0u8, n);
        self.out_start = zeroed(0u32, n + 1);
        self.out_post = zeroed(0u32, e);
        self.base_w = zeroed(0i32, e);
        self.role_nodes = zeroed(0u32, n);
        let g = GRID * GRID;
        self.food = zeroed(0i32, g);
        self.biome = zeroed(0u8, g);
        self.height = zeroed(0u8, g);
        self.moisture = zeroed(0u8, g);
        self.moisture0 = zeroed(0u8, g);
        self.odor = zeroed(0i32, g);
        self.alive = zeroed(0u8, p);
        self.x = zeroed(0i32, p);
        self.y = zeroed(0i32, p);
        self.z = zeroed(0i32, p);
        self.heading = zeroed(0u16, p);
        self.pitch = zeroed(0i16, p);
        self.roll = zeroed(0i16, p);
        self.mode = zeroed(0u8, p);
        self.surface = zeroed(0u8, p);
        self.energy = zeroed(0i32, p);
        self.generation = zeroed(0u32, p);
        self.lineage = zeroed(0u32, p);
        self.age = zeroed(0u32, p);
        self.hormone = zeroed(0u32, p);
        self.wingbeat = zeroed(0u16, p);
        self.gait = zeroed(0u16, p);
        self.proboscis = zeroed(0u8, p);
        self.wing_rate = zeroed(0i32, p);
        self.last_odor = zeroed(0i32, p);
        self.ate_last = zeroed(0i32, p);
        self.bitten = zeroed(0u8, p);
        self.thrust_last = zeroed(0i32, p);
        self.turn_last = zeroed(0i32, p);
        self.contact = zeroed(0u8, p);
        self.eaten = zeroed(0u32, p);
        self.fed = zeroed(0u32, p);
        self.uid = zeroed(UID_UNASSIGNED, p);
        self.digest = zeroed(0u64, p);
        self.pose = zeroed(0i16, p * POSE_LEN);
        self.fired_count = zeroed(0u32, p * FIRE_GROUPS);
        self.genome = zeroed(0i16, p * e);
        self.ns = zeroed(0u32, p * n);
        self.fired = zeroed(0u8, p * n);
        self.active = zeroed(0u64, p * n.div_ceil(64));
        self.touched = zeroed(0u32, p * n);
        self.touched_len = zeroed(0u32, p);
        self.fired_list = zeroed(0u32, p * n);
        self.fired_len = zeroed(0u32, p);
        self.inp = zeroed(0i32, n);
        true
    }

    pub fn heap_bytes(&self) -> u64 {
        let (n, e, p, g) = (self.n as u64, self.e as u64, self.p as u64, (GRID * GRID) as u64);
        n * (1 + 4 + 4)
            + e * (4 + 4)
            + g * (4 + 1 + 1 + 1 + 1 + 4)
            + p * (1 + 4 * 3 + 2 * 3 + 1 * 2 + 4 * 5 + 2 * 2 + 1 + 4 * 5 + 1 * 2 + 4 * 3 + 8 + 2 * POSE_LEN as u64 + 4 * FIRE_GROUPS as u64)
            + p * e * 2
            + p * n * (4 + 1 + 4 + 4)
            + p * n.div_ceil(64) * 8
            + n * 4
    }

    pub fn push_event(&mut self, kind: u32, a: u32, b: u32) {
        let i = (self.ev_head as usize) % EV_RING;
        self.ev[i] = [self.tick, kind, a, b];
        self.ev_head = self.ev_head.wrapping_add(1);
    }

    fn pop(&self) -> u32 {
        self.alive.iter().filter(|a| **a == 1).count() as u32
    }

    fn free_slot(&self) -> Option<usize> {
        self.alive.iter().position(|a| *a == 0)
    }

    /// The CSR the host wrote is well formed: row starts span the edge
    /// table, are monotone, and every endpoint names a node.
    fn csr_ok(&self) -> bool {
        let (n, e) = (self.n, self.e);
        self.out_start[0] == 0
            && self.out_start[n] as usize == e
            && (0..n).all(|a| self.out_start[a] <= self.out_start[a + 1])
            && (0..e).all(|k| (self.out_post[k] as usize) < n)
    }

    /// Everything derived from the graph slabs and nothing else: the role
    /// lists, the normalisation and the genesis digest. Consumes no RNG and
    /// writes nothing `hash` covers, so it is idempotent on an intact world
    /// and is what a restore re-runs after checking the slabs against the
    /// canonical upload (`world_rederive`).
    fn rederive(&mut self) {
        let n = self.n;
        // role lists: counting sort of the nodes by role, node order within a role
        self.role_start = [0; ROLE_MAX + 1];
        for i in 0..n {
            let r = (self.role[i] as usize).min(ROLE_MAX - 1);
            self.role[i] = r as u8;
            self.role_start[r + 1] += 1;
        }
        for r in 0..ROLE_MAX {
            self.role_start[r + 1] += self.role_start[r];
        }
        let mut fill = self.role_start;
        for i in 0..n {
            let r = self.role[i] as usize;
            self.role_nodes[fill[r] as usize] = i as u32;
            fill[r] += 1;
        }
        self.norm = ((n >> NORM_SHIFT) as i32).max(NORM_MIN);
        self.base_digest = self.genesis_digest();
    }

    fn init(&mut self, seed: u64, start_pop: u32) {
        // reject a malformed CSR here instead of simulating a phantom node
        assert!(self.csr_ok(), "malformed CSR: row starts must be 0..E monotone and every out_post < N");
        self.rederive();
        self.rng = Rng(if seed == 0 { 0x9E3779B97F4A7C15 } else { seed });
        self.tick = 0;
        self.births = 0;
        self.deaths = 0;
        self.kills = 0;
        self.capacity = 40; // genesis default
        self.ev = [[0; 4]; EV_RING];
        self.max_gen = 0;
        self.ev_head = 0;
        self.lights_off_ticks = 0;
        self.alive.fill(0);
        self.eaten.fill(0);
        self.fed.fill(0);
        self.uid.fill(UID_UNASSIGNED);
        self.ns.fill(0);
        self.fired.fill(0);
        self.active.fill(0);
        self.touched_len.fill(0);
        self.fired_len.fill(0);
        self.fired_count.fill(0);
        self.pose.fill(0);
        self.inp.fill(0);
        self.gen_cage();
        // A modest starting larder, sized to each substrate and costing zero
        // RNG draws: the first generations eat the cage down toward its
        // equilibrium.
        for c in 0..GRID * GRID {
            self.food[c] = FOODCAP[self.biome[c] as usize] / 2;
        }
        self.refresh_odor();
        self.next_lineage = 0;
        let sp = (start_pop as usize).min(self.p);
        // founders spawn together (they must find each other to breed)
        let (fx, fy) = self.floor_spot();
        for i in 0..sp {
            let (mut px, mut py) = (fx, fy);
            if i > 0 {
                px = fx + (self.rng.below((8 << FP) + 1) as i32) - (4 << FP);
                py = fy + (self.rng.below((8 << FP) + 1) as i32) - (4 << FP);
                if !self.spawnable(px, py) {
                    px = fx;
                    py = fy;
                }
            }
            self.write_genesis_genome(i);
            let lin = self.next_lineage;
            self.next_lineage += 1;
            self.spawn(i, px, py, 0, lin, START_ENERGY);
            self.births += 1;
            self.push_event(EV_BIRTH, i as u32, NO_PARENT);
        }
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
        mix(self.lights_off_ticks as u64);
        for w in 0..self.p {
            if self.alive[w] == 0 {
                continue;
            }
            mix(w as u64);
            mix(self.x[w] as u32 as u64);
            mix(self.y[w] as u32 as u64);
            mix(self.z[w] as u32 as u64);
            mix(self.heading[w] as u64);
            mix(self.pitch[w] as u16 as u64);
            mix(self.roll[w] as u16 as u64);
            mix(((self.mode[w] as u64) << 8) | self.surface[w] as u64);
            mix(self.energy[w] as u32 as u64);
            mix(self.age[w] as u64);
            mix(self.generation[w] as u64);
            mix(self.lineage[w] as u64);
            mix(self.hormone[w] as u64);
            mix(((self.wingbeat[w] as u64) << 16) | self.gait[w] as u64);
            mix(self.proboscis[w] as u64);
            mix(self.wing_rate[w] as u32 as u64);
            mix(self.last_odor[w] as u32 as u64);
            mix(self.ate_last[w] as u32 as u64);
            mix(((self.bitten[w] as u64) << 8) | self.contact[w] as u64);
            mix(self.thrust_last[w] as u32 as u64);
            mix(self.turn_last[w] as u32 as u64);
            mix(self.digest[w]);
            // neural state: the anchor must see the brain, not only the body.
            // Only touched nodes carry state (invariant of the active set);
            // they are combined order-independently, so the list order
            // (an artefact of removal) cannot move the hash.
            mix(self.neural_digest(w));
        }
        // the whole food grid: it is highly dynamic, so the anchor is a true
        // one-step fingerprint; moisture and biome move slowly, sparse is
        // fine. The odour field is state of its own between its 8-tick
        // refreshes (the ORNs read it), so it is fingerprinted the same way.
        for c in 0..GRID * GRID {
            mix(self.food[c] as u32 as u64);
        }
        for c in (0..GRID * GRID).step_by(7) {
            mix(self.moisture[c] as u64);
            mix(self.biome[c] as u64);
            mix(self.odor[c] as u32 as u64);
        }
        h
    }
}

// ---------------- exports ----------------

#[no_mangle]
pub extern "C" fn world_alloc(n_nodes: u32, n_edges: u32, max_pop: u32) -> u32 {
    let w = unsafe { &mut W };
    w.alloc(n_nodes as usize, n_edges as usize, max_pop as usize) as u32
}
#[no_mangle]
pub extern "C" fn heap_bytes() -> u64 {
    unsafe { W.heap_bytes() }
}

#[no_mangle]
pub extern "C" fn role_ptr() -> *mut u8 {
    unsafe { W.role.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn out_start_ptr() -> *mut u32 {
    unsafe { W.out_start.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn out_post_ptr() -> *mut u32 {
    unsafe { W.out_post.as_mut_ptr() }
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
pub extern "C" fn height_ptr() -> *const u8 {
    unsafe { W.height.as_ptr() }
}
#[no_mangle]
pub extern "C" fn odor_ptr() -> *const i32 {
    unsafe { W.odor.as_ptr() }
}
#[no_mangle]
pub extern "C" fn genome_ptr() -> *mut i16 {
    unsafe { W.genome.as_mut_ptr() } // max_pop * E, row-major
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
pub extern "C" fn z_ptr() -> *const i32 {
    unsafe { W.z.as_ptr() }
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
pub extern "C" fn pose_ptr() -> *const i16 {
    unsafe { W.pose.as_ptr() } // max_pop * POSE_LEN, row-major
}
#[no_mangle]
pub extern "C" fn fired_ptr() -> *const u8 {
    unsafe { W.fired.as_ptr() } // max_pop * N, row-major
}
#[no_mangle]
pub extern "C" fn fired_count_ptr() -> *const u32 {
    unsafe { W.fired_count.as_ptr() } // max_pop * FIRE_GROUPS, row-major
}
#[no_mangle]
pub extern "C" fn eaten_ptr() -> *const u32 {
    unsafe { W.eaten.as_ptr() }
}
#[no_mangle]
pub extern "C" fn fed_ptr() -> *const u32 {
    unsafe { W.fed.as_ptr() }
}
/// What each fly swallowed on the last tick: the engine's own notion of a
/// feeding tick, for probes that must not confuse a bite with a meal.
#[no_mangle]
pub extern "C" fn ate_last_ptr() -> *const i32 {
    unsafe { W.ate_last.as_ptr() }
}
#[no_mangle]
pub extern "C" fn hormone_ptr() -> *const u32 {
    unsafe { W.hormone.as_ptr() }
}
/// Nodes with nonzero neural state per slot (the touched list length):
/// the size of the brain's working set right now.
#[no_mangle]
pub extern "C" fn active_count_ptr() -> *const u32 {
    unsafe { W.touched_len.as_ptr() }
}
#[no_mangle]
pub extern "C" fn event_ptr() -> *const u32 {
    unsafe { W.ev.as_ptr() as *const u32 }
}
#[no_mangle]
pub extern "C" fn event_head() -> u32 {
    unsafe { W.ev_head }
}
/// Ring length in records; a record is `u32 x 4` at `event_ptr`, record
/// `k` lives at `k % event_ring()`.
#[no_mangle]
pub extern "C" fn event_ring() -> u32 {
    EV_RING as u32
}
/// Host-written creature ids, one per slot. Not hashed.
#[no_mangle]
pub extern "C" fn uid_ptr() -> *mut u32 {
    unsafe { W.uid.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn node_count() -> u32 {
    unsafe { W.n as u32 }
}
#[no_mangle]
pub extern "C" fn edge_count() -> u32 {
    unsafe { W.e as u32 }
}
#[no_mangle]
pub extern "C" fn max_pop() -> u32 {
    unsafe { W.p as u32 }
}
#[no_mangle]
pub extern "C" fn grid() -> u32 {
    GRID as u32
}
#[no_mangle]
pub extern "C" fn layers() -> u32 {
    LAYERS as u32
}
#[no_mangle]
pub extern "C" fn pose_len() -> u32 {
    POSE_LEN as u32
}
#[no_mangle]
pub extern "C" fn fire_groups() -> u32 {
    FIRE_GROUPS as u32
}
/// Ambient light right now, 0..255 (day cycle; night-dark when the lights
/// are off).
#[no_mangle]
pub extern "C" fn light_now() -> u32 {
    unsafe { W.ambient() as u32 }
}
/// Temperature at the cage centre right now in centi-degrees Celsius.
#[no_mangle]
pub extern "C" fn temp_now() -> i32 {
    unsafe { W.temperature_centre() }
}
#[no_mangle]
pub extern "C" fn lamp_on() -> u32 {
    unsafe { (W.lights_off_ticks == 0) as u32 }
}
/// Food ceiling for a substrate class, so the renderer can shade a cell by
/// how full it is rather than against one global maximum.
#[no_mangle]
pub extern "C" fn biome_foodcap(b: u32) -> i32 {
    FOODCAP[(b as usize).min(BIOME_COUNT - 1)]
}
#[no_mangle]
pub extern "C" fn dish_count() -> u32 {
    DISHES as u32
}
#[no_mangle]
pub extern "C" fn dish_kind(i: u32) -> u32 {
    unsafe { W.dish[(i as usize) % DISHES][0] as u32 }
}
#[no_mangle]
pub extern "C" fn dish_x(i: u32) -> u32 {
    unsafe { W.dish[(i as usize) % DISHES][1] as u32 }
}
#[no_mangle]
pub extern "C" fn dish_y(i: u32) -> u32 {
    unsafe { W.dish[(i as usize) % DISHES][2] as u32 }
}
#[no_mangle]
pub extern "C" fn dish_r(i: u32) -> u32 {
    unsafe { W.dish[(i as usize) % DISHES][3] as u32 }
}
#[no_mangle]
pub extern "C" fn water_x() -> u32 {
    unsafe { W.water[0] as u32 }
}
#[no_mangle]
pub extern "C" fn water_y() -> u32 {
    unsafe { W.water[1] as u32 }
}
#[no_mangle]
pub extern "C" fn water_r() -> u32 {
    unsafe { W.water[2] as u32 }
}
#[no_mangle]
pub extern "C" fn lamp_x() -> u32 {
    unsafe { W.lamp[0] as u32 }
}
#[no_mangle]
pub extern "C" fn lamp_y() -> u32 {
    unsafe { W.lamp[1] as u32 }
}
#[no_mangle]
pub extern "C" fn salt_corner() -> u32 {
    unsafe { W.salt_corner as u32 }
}

#[no_mangle]
pub extern "C" fn world_init(seed: u64, n_nodes: u32, n_edges: u32, max_pop: u32, start_pop: u32) {
    let w = unsafe { &mut W };
    assert!(
        w.n == n_nodes as usize && w.e == n_edges as usize && w.p == max_pop as usize && w.n > 0,
        "world_init sizes differ from world_alloc"
    );
    w.init(seed, start_pop);
}

/// After a restore: rebuild every table derived from the graph slabs (role
/// lists, `norm`, genesis digest) and re-check the CSR, so an image cannot
/// smuggle derived state past a host that has verified the slabs
/// themselves against the canonical upload. Returns 1, or 0 (without
/// touching anything) when the CSR is malformed. Writes nothing
/// `state_hash` covers; harmless on a fresh world.
#[no_mangle]
pub extern "C" fn world_rederive() -> u32 {
    let w = unsafe { &mut W };
    if w.n == 0 || !w.csr_ok() {
        return 0;
    }
    w.rederive();
    1
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
    unsafe { W.pop() }
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
    unsafe { W.capacity = c.min(W.p as u32) }
}
#[no_mangle]
pub extern "C" fn state_hash() -> u64 {
    unsafe { W.hash() }
}

/// The slot's genome digest (canonical edge order, order-independent FNV
/// mix per edge), maintained incrementally at every write: the identity
/// hash minted into its on-chain Creature account at birth.
#[no_mangle]
pub extern "C" fn creature_genome_hash(slot: u32) -> u64 {
    let w = unsafe { &W };
    w.digest[slot as usize % w.p]
}
/// The same digest recomputed over every weight, for verification tooling.
#[no_mangle]
pub extern "C" fn creature_genome_hash_full(slot: u32) -> u64 {
    let w = unsafe { &W };
    w.genome_digest_full(slot as usize % w.p)
}

/// resolve a live creature by its host-assigned uid; the unassigned sentinel
/// names nobody, even though unlabelled slots carry it
fn slot_of_uid(w: &World, target: u32) -> Option<usize> {
    if target == UID_UNASSIGNED {
        return None;
    }
    (0..w.p).find(|&s| w.alive[s] == 1 && w.uid[s] == target)
}

/// Keeper care: drop food on the fly's own floor cell (paid, journaled,
/// deterministic). Tallied in `fed` so it never counts as the world's reward.
#[no_mangle]
pub extern "C" fn int_provision(uid: u32) {
    let w = unsafe { &mut W };
    let Some(s) = slot_of_uid(w, uid) else { return };
    let c = cell_of(w.x[s], w.y[s]);
    if w.biome[c] == BIOME_WATER {
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
        let Some(slot) = w.free_slot() else { return };
        let (px, py) = w.floor_spot();
        w.write_genesis_genome(slot);
        let lin = w.next_lineage;
        w.next_lineage += 1;
        w.spawn(slot, px, py, 0, lin, START_ENERGY);
        w.births += 1;
        w.push_event(EV_BIRTH, slot as u32, NO_PARENT);
    }
}

/// Lights off for `ticks`: the lamp is dark and the ambient falls to night.
/// A fly that reads its photoreceptors feels it; the odour field does not
/// care. Replaces the larval flood as the keeper's environmental lever.
#[no_mangle]
pub extern "C" fn int_lights_off(ticks: u32) {
    let w = unsafe { &mut W };
    w.lights_off_ticks = ticks.max(1);
    w.push_event(EV_LIGHTS_OFF, 0, ticks);
}

/// A yeast bloom: food lands in a radius-6 disc around the cell.
#[no_mangle]
pub extern "C" fn int_bloom(cx: u32, cy: u32) {
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
    w.refresh_odor();
    w.push_event(EV_BLOOM, cx, cy);
}

/// A dry spell: food quartered and humidity down everywhere. The salt crust
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
    w.refresh_odor();
    w.push_event(EV_DRY_SPELL, 0, 0);
}
