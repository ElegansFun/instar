use super::*;

/// Upload a graph the way the host does: roles, CSR row starts derived from
/// the (sorted) pre column, posts, weights. `edges` must be sorted by (pre,
/// post) or the CSR is not the canonical order and `world_init` traps.
fn load(n: usize, edges: &[(u32, u32, i32)], roles: &[(usize, u8)], p: usize) {
    assert_eq!(world_alloc(n as u32, edges.len() as u32, p as u32), 1);
    let w = unsafe { &mut W };
    w.role.fill(ROLE_NONE);
    for &(i, r) in roles {
        w.role[i] = r;
    }
    w.out_start.fill(0);
    for (k, &(pre, post, wt)) in edges.iter().enumerate() {
        if k > 0 {
            assert!((edges[k - 1].0, edges[k - 1].1) <= (pre, post), "edges not sorted");
        }
        w.out_start[pre as usize + 1] += 1;
        w.out_post[k] = post;
        w.base_w[k] = wt;
    }
    for i in 0..n {
        w.out_start[i + 1] += w.out_start[i];
    }
}

/// 12 nodes: 0 ORN, 1 GRN_SWEET, 2 MN_LEG_L1, 3 MN_LEG_R1, 4 MN_PROBOSCIS,
/// 5 NEUROSECRETORY, 6..11 six more proboscis motor neurons so a meal can
/// be a full one; the two sensors drive every effector with a weight that
/// fires it on one spike.
fn tiny_graph(p: usize) {
    let roles = [
        (0, ROLE_ORN),
        (1, ROLE_GRN_SWEET),
        (2, ROLE_MN_LEG_L1),
        (3, ROLE_MN_LEG_R1),
        (4, ROLE_MN_PROBOSCIS),
        (5, ROLE_NEUROSECRETORY),
        (6, ROLE_MN_PROBOSCIS),
        (7, ROLE_MN_PROBOSCIS),
        (8, ROLE_MN_PROBOSCIS),
        (9, ROLE_MN_LEG_L2),
        (10, ROLE_MN_LEG_R2),
        (11, ROLE_MN_PROBOSCIS),
    ];
    let edges = [
        (0, 2, 30),
        (0, 3, 30),
        (0, 4, 30),
        (0, 9, 30),
        (1, 2, 30),
        (1, 4, 30),
        (1, 5, 30),
        (1, 6, 30),
        (1, 7, 30),
        (1, 8, 30),
        (1, 10, 30),
        (1, 11, 30),
    ];
    load(12, &edges, &roles, p);
}
const TINY_N: u32 = 12;
const TINY_E: u32 = 12;

/// 25 nodes: 0 ORN driving twenty-four wing-power motor neurons (the
/// MaleCNS count), so a loud
/// odour lifts the fly and silence lands it.
fn flight_graph(p: usize) {
    let mut roles = vec![(0usize, ROLE_ORN)];
    let mut edges = Vec::new();
    for k in 1..25u32 {
        roles.push((k as usize, if k % 2 == 1 { ROLE_MN_WING_POWER_L } else { ROLE_MN_WING_POWER_R }));
        edges.push((0, k, 30));
    }
    load(25, &edges, &roles, p);
}

/// A random graph with u32 indices, sorted by (pre, post), unit weights.
fn random_graph(n: u32, e: u32, seed: u64, p: usize) -> Vec<(u32, u32, i32)> {
    let mut r = Rng(seed);
    let mut edges: Vec<(u32, u32, i32)> = (0..e).map(|_| (r.below(n), r.below(n), 1)).collect();
    edges.sort();
    edges.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
    let roles: Vec<(usize, u8)> = (0..n as usize)
        .map(|i| (i, match i % 7 { 0 => ROLE_ORN, 1 => ROLE_BRISTLE, 2 => ROLE_MN_LEG_L1, 3 => ROLE_DN_L, _ => ROLE_NONE }))
        .collect();
    load(n as usize, &edges, &roles, p);
    edges
}

#[test]
fn deterministic_replay() {
    tiny_graph(8);
    world_init(42, TINY_N, TINY_E, 8, 8);
    step(5000);
    let h1 = state_hash();
    let t1 = get_tick();
    world_init(42, TINY_N, TINY_E, 8, 8);
    step(5000);
    assert_eq!(get_tick(), t1);
    assert_eq!(state_hash(), h1, "same seed must replay bit-identically");
}

#[test]
fn different_seed_diverges() {
    tiny_graph(8);
    world_init(42, TINY_N, TINY_E, 8, 8);
    step(2000);
    let h1 = state_hash();
    world_init(43, TINY_N, TINY_E, 8, 8);
    step(2000);
    assert_ne!(state_hash(), h1);
}

#[test]
fn population_lives_and_events_flow() {
    tiny_graph(16);
    world_init(7, TINY_N, TINY_E, 16, 12);
    step(20_000);
    assert!(births_total() + deaths_total() > 12, "no lifecycle events in 20k ticks");
    let w = unsafe { &W };
    for s in 0..16 {
        if w.alive[s] == 1 {
            assert!(w.x[s] >= 0 && w.x[s] < XMAX && w.y[s] >= 0 && w.y[s] < XMAX, "a fly is outside the cage");
            assert!(w.z[s] >= 0 && w.z[s] <= ZTOP, "a fly is outside the volume");
        }
    }
}

// Run under the `ci` profile (overflow-checks ON): any integer overflow in
// a long-running world panics here instead of silently wrapping the
// fossil record. 2M ticks with births/deaths/fights/flight/interrupts.
#[test]
fn long_run_no_overflow_no_panic() {
    tiny_graph(32);
    world_init(0xABCDEF, TINY_N, TINY_E, 32, 24);
    for round in 0..40u32 {
        step(50_000);
        unsafe { W.uid[0] = 7 };
        int_provision(7);
        match round % 4 {
            0 => int_lights_off(1_200),
            1 => int_bloom(64, 64),
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
    tiny_graph(8);
    world_init(123, TINY_N, TINY_E, 8, 8);
    step(30_000);
    let h = state_hash();
    world_init(123, TINY_N, TINY_E, 8, 8);
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
// random graph with u32 indices, random weights and a random firing
// pattern.
#[test]
fn csr_matches_naive() {
    const N: u32 = 1000;
    let edges = random_graph(N, 6000, 0x5EED, 2);
    let e = edges.len();
    world_init(9, N, e as u32, 2, 2);
    let w = unsafe { &mut W };
    let mut r = Rng(0xF00D);
    for k in 0..e {
        w.genome[k] = (r.below(2 * W_CAP as u32 + 1) as i32 - W_CAP) as i16;
    }
    // a fresh brain, then a random spike list
    w.clear_brain(0);
    let mut flen = 0;
    for i in 0..N as usize {
        if r.below(3) == 0 {
            w.fired[i] = 1;
            w.fired_list[flen] = i as u32;
            flen += 1;
            w.touched[flen - 1] = i as u32;
            w.active[i >> 6] |= 1 << (i & 63);
        }
    }
    w.touched_len[0] = flen as u32;
    w.fired_len[0] = flen as u32;
    let spikes = w.propagate(0);
    assert_eq!(spikes as usize, flen);
    let mut naive = vec![0i32; N as usize];
    for (k, &(pre, post, _)) in edges.iter().enumerate() {
        if w.fired[pre as usize] == 1 {
            naive[post as usize] = naive[post as usize].saturating_add(w.genome[k] as i32 * SYN_GAIN);
        }
    }
    let rec: Vec<i32> = w.inp[..N as usize].to_vec();
    assert!(rec.iter().any(|v| *v != 0), "nothing propagated");
    assert_eq!(rec, naive);
    // every node with recurrent input is in the touched set
    let tlen = w.touched_len[0] as usize;
    for i in 0..N as usize {
        if naive[i] != 0 {
            assert!(w.touched[..tlen].contains(&(i as u32)), "node {i} received input but was not touched");
        }
    }
}

/// The reference: a full sweep over every node and every edge with the
/// same arithmetic as `integrate`.
struct Reference {
    pot: Vec<i32>,
    refr: Vec<u8>,
    fired: Vec<u8>,
}

impl Reference {
    fn tick(&mut self, w: &World, edges: &[(u32, u32, i32)], drive: &[i32; ROLE_MAX]) {
        let n = w.n;
        let mut acc = vec![0i32; n];
        let mut rec = vec![0i32; n];
        for i in 0..n {
            acc[i] = drive[w.role[i] as usize];
        }
        let spikes = self.fired.iter().filter(|f| **f == 1).count() as i64;
        for (k, &(pre, post, _)) in edges.iter().enumerate() {
            if self.fired[pre as usize] == 1 {
                rec[post as usize] = rec[post as usize].saturating_add(w.genome[k] as i32 * SYN_GAIN);
            }
        }
        let norm = w.norm as i64;
        for i in 0..n {
            if self.refr[i] > 0 {
                self.refr[i] -= 1;
                self.fired[i] = 0;
                self.pot[i] = 0;
                continue;
            }
            let pot0 = self.pot[i];
            let leak = if pot0 >= 0 { pot0 >> LEAK_SHIFT } else { -((-pot0) >> LEAK_SHIFT) };
            let recurrent = ((rec[i] as i64 * norm) / (norm + spikes)) as i32;
            let p = pot0.saturating_add(acc[i]).saturating_add(recurrent).saturating_sub(leak).clamp(POT_FLOOR, POT_CLAMP);
            let p = if p.abs() < POT_REST { 0 } else { p };
            if p > THRESH {
                self.fired[i] = 1;
                self.refr[i] = REFRACTORY;
                self.pot[i] = 0;
            } else {
                self.fired[i] = 0;
                self.pot[i] = p;
            }
        }
    }
}

// The touched-list update must equal a full sweep over every node, tick
// after tick, under a changing sensory drive; and the touched set must be
// exactly the nodes with nonzero state.
#[test]
fn touched_list_matches_full_sweep() {
    const N: u32 = 300;
    let edges = random_graph(N, 2400, 0x7A11, 2);
    world_init(5, N, edges.len() as u32, 2, 1);
    let w = unsafe { &mut W };
    let mut r = Rng(0xBEEF);
    for k in 0..edges.len() {
        w.genome[k] = (r.below(2 * W_CAP as u32 + 1) as i32 - W_CAP) as i16;
    }
    w.clear_brain(0);
    let mut reference = Reference { pot: vec![0; N as usize], refr: vec![0; N as usize], fired: vec![0; N as usize] };
    let mut drive = [0i32; ROLE_MAX];
    let mut ever_fired = false;
    for t in 0..400u32 {
        drive[ROLE_ORN as usize] = ((t * 997) % 4000) as i32;
        drive[ROLE_BRISTLE as usize] = if t % 17 == 0 { 20_000 } else { 0 };
        reference.tick(w, &edges, &drive);
        let cnt = w.brain(0, &drive);
        ever_fired |= cnt.iter().any(|c| *c > 0);
        let n = N as usize;
        let pot: Vec<i32> = (0..n).map(|i| brain::pot_of(w.ns[i])).collect();
        let refr: Vec<u8> = (0..n).map(|i| brain::refr_of(w.ns[i])).collect();
        assert_eq!(pot, reference.pot, "pot diverged at tick {t}");
        assert_eq!(refr, reference.refr, "refr diverged at tick {t}");
        assert_eq!(w.fired[..n], reference.fired[..], "fired diverged at tick {t}");
        let tlen = w.touched_len[0] as usize;
        let touched = &w.touched[..tlen];
        for i in 0..n {
            let nonzero = w.ns[i] != 0 || w.fired[i] != 0;
            assert_eq!(touched.contains(&(i as u32)), nonzero, "touched set wrong for node {i} at tick {t}");
        }
        assert!(w.inp.iter().all(|v| *v == 0), "scratch not cleared at tick {t}");
    }
    assert!(ever_fired, "the random graph never fired: the test proved nothing");
}

// Takeoff when the wing-power rate rises, landing when it falls, and the
// whole flight replays bit for bit.
#[test]
fn takeoff_and_landing_replay() {
    fn run() -> (u64, Vec<u32>, bool, bool) {
        flight_graph(4);
        world_init(77, 25, 24, 4, 4);
        let w = unsafe { &mut W };
        w.food.fill(30_000);
        w.refresh_odor();
        w.energy[..4].fill(ENERGY_CAP);
        let mut flew = false;
        for _ in 0..20 {
            step(10);
            flew |= (0..4).any(|s| w.alive[s] == 1 && w.mode[s] == MODE_FLY);
        }
        w.food.fill(0);
        w.refresh_odor();
        step(600);
        let landed = (0..4).all(|s| w.alive[s] == 0 || w.mode[s] == MODE_WALK);
        let kinds: Vec<u32> = (0..(w.ev_head as usize).min(EV_RING)).map(|k| w.ev[k][1]).collect();
        (state_hash(), kinds, flew, landed)
    }
    let a = run();
    let b = run();
    assert_eq!(a.0, b.0, "flight does not replay");
    assert_eq!(a.1, b.1, "event sequence differs between replays");
    assert!(a.2, "no fly took off with every wing-power motor neuron driven");
    let hist: Vec<usize> = (0..9).map(|k| a.1.iter().filter(|v| **v == k).count()).collect();
    assert!(a.1.contains(&EV_TAKEOFF), "no takeoff event; kinds {hist:?}, head {}", a.1.len());
    assert!(a.1.contains(&EV_LANDING), "no landing event; kinds {hist:?}");
    assert!(a.3, "a fly is still airborne with silent wing-power motor neurons");
}

// The incremental genome digest must equal the full recomputation after
// crossover and mutation, and after direct weight writes.
#[test]
fn genome_digest_incremental_matches_full() {
    const N: u32 = 200;
    let edges = random_graph(N, 3000, 0xD16E57, 4);
    let e = edges.len() as u32;
    world_init(31, N, e, 4, 2);
    let w = unsafe { &mut W };
    assert_eq!(w.digest[0], w.genome_digest_full(0), "founder digest");
    assert_eq!(creature_genome_hash(0), creature_genome_hash_full(0));
    // two parents on one cell, ready to breed
    for s in 0..2 {
        w.x[s] = 64 << FP;
        w.y[s] = 64 << FP;
        w.z[s] = 0;
        w.energy[s] = REPRO_ENERGY;
        w.hormone[s] = 1 << 20;
    }
    let mut children = 0;
    for _ in 0..40 {
        let births = w.births;
        w.reproduce(0);
        if w.births == births {
            break;
        }
        children += 1;
        let child = (0..4).find(|&s| w.alive[s] == 1 && w.generation[s] == 1).expect("child slot");
        assert_eq!(w.digest[child], w.genome_digest_full(child), "child digest after crossover + mutation");
        assert_ne!(w.digest[child], w.digest[0], "child genome identical to parent 0");
        w.alive[child] = 0;
        w.energy[0] = REPRO_ENERGY;
        w.hormone[0] = 1 << 20;
    }
    assert!(children >= 2, "reproduction never happened");
    let mut r = Rng(0x1234);
    for _ in 0..500 {
        let k = r.below(e) as usize;
        let v = (r.below(2 * W_CAP as u32 + 1) as i32 - W_CAP) as i16;
        w.set_weight(1, k, v);
    }
    assert_eq!(w.digest[1], w.genome_digest_full(1), "digest after 500 direct writes");
}

#[test]
fn silent_proboscis_never_eats_and_zeroed_never_flies() {
    tiny_graph(4);
    world_init(5, TINY_N, TINY_E, 4, 4);
    unsafe { W.genome.fill(0) };
    step(2_000);
    let w = unsafe { &W };
    assert!(w.eaten[..4].iter().all(|e| *e == 0), "a fly ate with no proboscis output");
    assert!(w.mode[..4].iter().all(|m| *m == MODE_WALK), "a fly flew with no wing-power output");
    let kinds: Vec<u32> = (0..(w.ev_head as usize).min(EV_RING)).map(|k| w.ev[k][1]).collect();
    assert!(!kinds.contains(&EV_TAKEOFF), "takeoff without wing-power output");
}

// Two parents standing in water with one floor cell touching the centre:
// every child must be born on that cell, whichever way the jitter falls,
// never in the liquid.
#[test]
fn child_not_born_in_water_beside_open_floor() {
    tiny_graph(4);
    world_init(11, TINY_N, TINY_E, 4, 2);
    let w = unsafe { &mut W };
    let (cx, cy) = (64usize, 64usize);
    for dy in 0..5 {
        for dx in 0..5 {
            w.biome[(cy + dy - 2) * GRID + cx + dx - 2] = BIOME_WATER;
        }
    }
    let floor = cy * GRID + cx + 1;
    w.biome[floor] = BIOME_FLOOR;
    for round in 0..64 {
        for s in 0..2 {
            w.alive[s] = 1;
            w.mode[s] = MODE_WALK;
            w.surface[s] = SURF_FLOOR;
            w.x[s] = ((cx as i32) << FP) + HALF;
            w.y[s] = ((cy as i32) << FP) + HALF;
            w.z[s] = 0;
            w.energy[s] = REPRO_ENERGY;
        }
        w.alive[2..].fill(0);
        let births = w.births;
        w.reproduce(0);
        assert_eq!(w.births, births + 1, "round {round}: no child");
        let child = cell_of(w.x[2], w.y[2]);
        assert_eq!(child, floor, "round {round}: child born in the water");
    }
}

// The unassigned uid names nobody: a keeper action aimed at it must not
// land on the first unlabelled fly.
#[test]
fn unassigned_uid_matches_no_slot() {
    tiny_graph(4);
    world_init(3, TINY_N, TINY_E, 4, 4);
    assert_eq!(pop_count(), 4);
    int_kill(UID_UNASSIGNED);
    assert_eq!(pop_count(), 4, "int_kill(UID_UNASSIGNED) culled a fly");
    unsafe { W.uid[1] = 9 };
    int_kill(9);
    assert_eq!(pop_count(), 3);
}

// A walking fly that reaches the cage edge climbs the wall and can reach
// the ceiling and come back down; it never leaves the volume.
#[test]
fn walking_transitions_surfaces() {
    tiny_graph(2);
    world_init(19, TINY_N, TINY_E, 2, 1);
    let w = unsafe { &mut W };
    w.x[0] = 2 << FP;
    w.y[0] = 64 << FP;
    w.heading[0] = 32_768; // -x, straight at the west wall
    let mut seen = [false; 6];
    for _ in 0..4000 {
        // keep it walking straight up whatever surface it is on: no turns
        let s = w.surface[0];
        w.walk(0, 8_000, 0);
        assert!(w.x[0] >= 0 && w.x[0] < XMAX && w.y[0] >= 0 && w.y[0] < XMAX && w.z[0] >= 0 && w.z[0] <= ZTOP);
        seen[s as usize] = true;
        if s == SURF_CEILING && w.heading[0] == 0 {
            // on the ceiling, turn back toward the west wall to descend
            w.heading[0] = 32_768;
        }
    }
    assert!(seen[SURF_FLOOR as usize] && seen[SURF_WALL_W as usize] && seen[SURF_CEILING as usize], "surfaces seen: {seen:?}");
}

/// `fan` presynaptic nodes (1..=fan) each with one edge into node 0, so
/// the published weight `wt` summed over the fan-in is the whole drive.
fn fan_in_graph(fan: u32, wt: i32, p: usize) -> Vec<(u32, u32, i32)> {
    let edges: Vec<(u32, u32, i32)> = (1..=fan).map(|a| (a, 0, wt)).collect();
    let roles: Vec<(usize, u8)> = (1..=fan as usize).map(|a| (a, ROLE_ORN)).collect();
    load(fan as usize + 1, &edges, &roles, p);
    edges
}

// Generation zero is the published synapse counts: a fan-in that would have
// forced a fan-in-derived ceiling (8,000 x 2,591 x 1,024 is ten times i32)
// must leave every weight exactly as published, up to and including W_CAP.
#[test]
fn genesis_genome_is_the_published_counts() {
    const FAN: u32 = 8_000;
    let mut edges = fan_in_graph(FAN, 2_591, 1);
    // the largest MaleCNS count, and the ceiling itself, both survive
    edges[0].2 = W_CAP;
    let w = unsafe { &mut W };
    w.base_w[0] = W_CAP;
    world_init(3, FAN + 1, FAN, 1, 1);
    for (k, &(_, _, wt)) in edges.iter().enumerate() {
        assert_eq!(w.genome[k] as i32, wt, "genesis weight of edge {k} is not the published count");
    }
    assert_eq!(w.digest[0], w.genome_digest_full(0));
    assert_eq!(w.base_digest, w.genome_digest_full(0), "genesis digest is not the digest of the published counts");
}

// Under the ci profile any wrapping add panics. A worst-case fan-in at the
// ceiling (4,096 x 8,192 x 1,024 = 3.4e10, both signs) must saturate and
// still integrate: the excitatory target fires, the inhibitory one does not.
#[test]
fn saturating_accumulation_never_overflows() {
    const FAN: u32 = 4_096;
    let n = 2 * FAN as usize + 2;
    let mut edges = Vec::new();
    for a in 2..2 + FAN {
        edges.push((a, 0, W_CAP));
        edges.push((a, 1, -W_CAP));
    }
    let roles: Vec<(usize, u8)> = (2..n).map(|a| (a, ROLE_ORN)).collect();
    load(n, &edges, &roles, 1);
    world_init(3, n as u32, edges.len() as u32, 1, 1);
    let w = unsafe { &mut W };
    w.clear_brain(0);
    let mut flen = 0;
    for a in 2..n {
        w.fired[a] = 1;
        w.fired_list[flen] = a as u32;
        w.touched[flen] = a as u32;
        w.active[a >> 6] |= 1 << (a & 63);
        flen += 1;
    }
    w.touched_len[0] = flen as u32;
    w.fired_len[0] = flen as u32;
    let spikes = w.propagate(0);
    assert_eq!(spikes as usize, flen);
    assert_eq!(w.inp[0], i32::MAX, "excitatory fan-in did not saturate high");
    assert_eq!(w.inp[1], i32::MIN, "inhibitory fan-in did not saturate low");
    let drive = [0i32; ROLE_MAX];
    w.integrate(0, spikes, &drive);
    assert_eq!(w.fired[0], 1, "a saturated excitatory input did not fire its target");
    assert_eq!(w.fired[1], 0);
    assert_eq!(brain::pot_of(w.ns[1]), POT_FLOOR, "a saturated inhibitory input did not floor the potential");
    assert!(w.inp.iter().all(|v| *v == 0), "scratch not cleared");
}

// After a restore the host verifies the graph slabs and calls
// `world_rederive`: it must rebuild every derived table from them (so an
// image cannot smuggle its own), leave the state hash alone, and refuse a
// malformed CSR.
#[test]
fn rederive_rebuilds_derived_tables_and_keeps_the_hash() {
    tiny_graph(4);
    world_init(11, TINY_N, TINY_E, 4, 2);
    step(50);
    let w = unsafe { &mut W };
    let h0 = state_hash();
    let (role_start, role_nodes, norm, base_digest) = (w.role_start, w.role_nodes.clone(), w.norm, w.base_digest);
    w.role_start = [0; ROLE_MAX + 1];
    w.role_nodes.fill(u32::MAX);
    w.norm = 1;
    w.base_digest = 0xDEAD;
    assert_eq!(world_rederive(), 1);
    assert_eq!(w.role_start, role_start);
    assert_eq!(w.role_nodes, role_nodes);
    assert_eq!(w.norm, norm);
    assert_eq!(w.base_digest, base_digest);
    assert_eq!(state_hash(), h0, "rederive moved the state hash");
    // the rebuilt world steps exactly as the untouched one would
    let mut twin = || {
        tiny_graph(4);
        world_init(11, TINY_N, TINY_E, 4, 2);
        step(100);
        state_hash()
    };
    step(50);
    let h1 = state_hash();
    assert_eq!(h1, twin());
    // a malformed CSR is refused, not trapped on
    tiny_graph(4);
    world_init(11, TINY_N, TINY_E, 4, 2);
    let w = unsafe { &mut W };
    w.out_start[3] = w.out_start[2] + 1;
    w.out_start[2] = w.out_start[3] + 1;
    assert_eq!(world_rederive(), 0);
}
