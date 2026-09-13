//! The brain of one fly: threshold accumulate-and-fire over the connectome,
//! event-driven both ways. Propagation visits only the out-edges of nodes
//! that fired last tick; the update visits only the "touched" list (nodes
//! with nonzero potential, refractory time, a last-tick spike, or input this
//! tick), and the leak removes a node from the list when its state returns
//! to zero. The genome digest is maintained incrementally at every write.
//!
//! Layout is chosen for the cache, because every access here is a random
//! one into 166,700 nodes: potential and refractory count share one u32
//! per node (`ns`, see `pack`), the recurrent input is one i32 per node
//! (`inp`, a scratch slab shared by every fly and zeroed as it is consumed),
//! and sensory drive is never stored per node at all: it is looked up by
//! role at integration. `fired` (one byte per node) is written in the hot
//! path and read by `neural_digest` and the host.

use crate::*;

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

/// Order-independent per-edge contribution to a genome digest: FNV-1a over
/// (edge index, weight), so the digest of a genome is the XOR of its edges
/// and one mutation is two XORs.
#[inline]
pub(crate) fn edge_mix(e: u32, w: i16) -> u64 {
    let mut h = FNV_OFFSET;
    h ^= e as u64;
    h = h.wrapping_mul(FNV_PRIME);
    h ^= w as i32 as u32 as u64;
    h = h.wrapping_mul(FNV_PRIME);
    h
}

/// Per-node contribution to the neural digest, combined by wrapping
/// addition over the touched list (whose order is an artefact of removal).
#[inline]
fn node_mix(i: u32, state: u32, fired: u8) -> u64 {
    let mut h = FNV_OFFSET;
    h ^= i as u64;
    h = h.wrapping_mul(FNV_PRIME);
    h ^= state as u64;
    h = h.wrapping_mul(FNV_PRIME);
    h ^= fired as u64;
    h = h.wrapping_mul(FNV_PRIME);
    // finalizer: a plain FNV of small inputs adds too linearly
    h ^= h >> 32;
    h = h.wrapping_mul(0x9E3779B97F4A7C15);
    h ^ (h >> 29)
}

/// Node state in one u32: potential in bits 0..30 (signed, `POT_CLAMP`
/// and `POT_FLOOR` fit with room), refractory count in bits 30..32.
#[inline(always)]
pub(crate) fn pack(pot: i32, refr: u8) -> u32 {
    ((refr as u32) << 30) | (pot as u32 & 0x3FFF_FFFF)
}
#[inline(always)]
pub(crate) fn pot_of(state: u32) -> i32 {
    ((state << 2) as i32) >> 2
}
#[inline(always)]
pub(crate) fn refr_of(state: u32) -> u8 {
    (state >> 30) as u8
}

/// SAFETY contract: `node < n`, `active` holds `ceil(n / 64)` words and
/// `touched` holds `n` entries, so a node is pushed at most once and the
/// list cannot overflow.
#[inline(always)]
fn touch(active: &mut [u64], touched: &mut [u32], len: &mut usize, node: u32) {
    let wd = (node >> 6) as usize;
    let bit = 1u64 << (node & 63);
    let word = unsafe { active.get_unchecked_mut(wd) };
    if *word & bit == 0 {
        *word |= bit;
        unsafe { *touched.get_unchecked_mut(*len) = node };
        *len += 1;
    }
}

impl World {
    /// One tick of one brain. `drive[role]` is the sensory afferent per
    /// role, read by every node of that role at integration (nothing else
    /// ever adds sensory input). Returns the spike count per role.
    pub(crate) fn brain(&mut self, w: usize, drive: &[i32; ROLE_MAX]) -> [u32; ROLE_MAX] {
        self.sensory(w, drive);
        let spikes = self.propagate(w);
        self.integrate(w, spikes, drive)
    }

    /// Bring every node of a driven role into the active set; the drive
    /// itself is applied at integration by role lookup.
    pub(crate) fn sensory(&mut self, w: usize, drive: &[i32; ROLE_MAX]) {
        let n = self.n;
        let words = n.div_ceil(64);
        let active = &mut self.active[w * words..(w + 1) * words];
        let touched = &mut self.touched[w * n..(w + 1) * n];
        let mut tlen = self.touched_len[w] as usize;
        for r in 1..ROLE_MAX {
            if drive[r] == 0 {
                continue;
            }
            for &i in &self.role_nodes[self.role_start[r] as usize..self.role_start[r + 1] as usize] {
                touch(active, touched, &mut tlen, i);
            }
        }
        self.touched_len[w] = tlen as u32;
    }

    /// Recurrent drive from last tick's spikes over the CSR. Equal to the
    /// naive per-edge sweep (`csr_matches_naive`) whenever no partial sum
    /// saturates, which the genesis genome guarantees (the largest summed
    /// fan-in on the MaleCNS is 1.2e8 of 2.1e9); an evolved genome near
    /// `W_CAP` on a node of extreme fan-in saturates instead of wrapping,
    /// still in a fixed, replayable order. Returns the spike count.
    pub(crate) fn propagate(&mut self, w: usize) -> i32 {
        let n = self.n;
        let words = n.div_ceil(64);
        let wb = w * n;
        let wg = w * self.e;
        let active = &mut self.active[w * words..(w + 1) * words];
        let touched = &mut self.touched[wb..wb + n];
        let mut tlen = self.touched_len[w] as usize;
        let flen = self.fired_len[w] as usize;
        let genome = &self.genome[wg..wg + self.e];
        let inp = &mut self.inp[..];
        for &a in &self.fired_list[wb..wb + flen] {
            let (s, t) = (self.out_start[a as usize] as usize, self.out_start[a as usize + 1] as usize);
            let posts = &self.out_post[s..t];
            let weights = &genome[s..t];
            for (&b, &wt) in posts.iter().zip(weights) {
                // SAFETY: `world_init` rejects any `out_post >= n`, and `inp`
                // has exactly `n` entries; the bitmap and list are sized by
                // `n` too, so `touch` cannot index out of range either.
                // `wt * SYN_GAIN` is at most 2^23; the running sum saturates.
                let v = unsafe { inp.get_unchecked_mut(b as usize) };
                *v = v.saturating_add(wt as i32 * SYN_GAIN);
                touch(active, touched, &mut tlen, b);
            }
        }
        self.touched_len[w] = tlen as u32;
        flen as i32
    }

    /// Integrate and fire over the touched list; consumes and zeroes the
    /// inputs of every touched node. Sensory drive and recurrent drive are
    /// kept apart: only the latter is normalised by last tick's activity.
    /// Returns the spike count per role.
    pub(crate) fn integrate(&mut self, w: usize, spikes: i32, drive: &[i32; ROLE_MAX]) -> [u32; ROLE_MAX] {
        let n = self.n;
        let words = n.div_ceil(64);
        let wb = w * n;
        let active = &mut self.active[w * words..(w + 1) * words];
        let touched = &mut self.touched[wb..wb + n];
        let fired_list = &mut self.fired_list[wb..wb + n];
        let ns = &mut self.ns[wb..wb + n];
        let fired = &mut self.fired[wb..wb + n];
        let mut tlen = self.touched_len[w] as usize;
        let norm = self.norm as i64;
        let den = norm + spikes as i64;
        let mut counts = [0u32; ROLE_MAX];
        let mut new_flen = 0usize;
        let mut t = 0usize;
        let role = &self.role[..n];
        let inp = &mut self.inp[..n];
        while t < tlen {
            // SAFETY: every entry of the touched list is a node index < n
            // (pushed by `touch` from validated CSR targets and role lists),
            // and each per-node slab here is exactly n long.
            let i = unsafe { *touched.get_unchecked(t) } as usize;
            let role = unsafe { *role.get_unchecked(i) } as usize;
            let a = drive[role];
            let r = unsafe { std::mem::replace(inp.get_unchecked_mut(i), 0) };
            let state = unsafe { *ns.get_unchecked(i) };
            let refr = refr_of(state);
            let keep;
            if refr > 0 {
                // inputs during the refractory period are discarded
                if refr == REFRACTORY {
                    unsafe { *fired.get_unchecked_mut(i) = 0 };
                }
                unsafe { *ns.get_unchecked_mut(i) = pack(0, refr - 1) };
                keep = refr > 1;
            } else {
                let pot0 = pot_of(state);
                // symmetric leak of the old potential, rounding toward
                // zero; a result within POT_REST of rest is rest, so a
                // quiet node leaves the set
                let leak = if pot0 >= 0 { pot0 >> LEAK_SHIFT } else { -((-pot0) >> LEAK_SHIFT) };
                let recurrent = ((r as i64 * norm) / den) as i32;
                let p = pot0
                    .saturating_add(a)
                    .saturating_add(recurrent)
                    .saturating_sub(leak)
                    .clamp(POT_FLOOR, POT_CLAMP);
                let p = if p.abs() < POT_REST { 0 } else { p };
                if p > THRESH {
                    unsafe { *fired.get_unchecked_mut(i) = 1 };
                    unsafe { *ns.get_unchecked_mut(i) = pack(0, REFRACTORY) };
                    unsafe { *fired_list.get_unchecked_mut(new_flen) = i as u32 };
                    new_flen += 1;
                    counts[role] += 1;
                    keep = true;
                } else {
                    unsafe { *ns.get_unchecked_mut(i) = pack(p, 0) };
                    keep = p != 0;
                }
            }
            if keep {
                t += 1;
            } else {
                active[i >> 6] &= !(1u64 << (i & 63));
                tlen -= 1;
                touched[t] = touched[tlen];
            }
        }
        self.touched_len[w] = tlen as u32;
        self.fired_len[w] = new_flen as u32;
        counts
    }

    /// Order-independent digest of the slot's nonzero neural state.
    pub(crate) fn neural_digest(&self, w: usize) -> u64 {
        let n = self.n;
        let wb = w * n;
        let tlen = self.touched_len[w] as usize;
        let mut h = 0u64;
        for &i in &self.touched[wb..wb + tlen] {
            let idx = wb + i as usize;
            h = h.wrapping_add(node_mix(i, self.ns[idx], self.fired[idx]));
        }
        h ^ (tlen as u64)
    }

    /// Reset a slot's brain to rest: only touched nodes carry state.
    pub(crate) fn clear_brain(&mut self, w: usize) {
        let n = self.n;
        let wb = w * n;
        let tlen = self.touched_len[w] as usize;
        for t in 0..tlen {
            let idx = wb + self.touched[wb + t] as usize;
            self.ns[idx] = 0;
            self.fired[idx] = 0;
        }
        let words = n.div_ceil(64);
        self.active[w * words..(w + 1) * words].fill(0);
        self.touched_len[w] = 0;
        self.fired_len[w] = 0;
        self.fired_count[w * FIRE_GROUPS..(w + 1) * FIRE_GROUPS].fill(0);
    }

    /// The genome a founder is born with: the literal published synapse
    /// counts (every one of them under `W_CAP`; the clamp is the i16 guard,
    /// not a tuning).
    pub(crate) fn write_genesis_genome(&mut self, slot: usize) {
        let wg = slot * self.e;
        for e in 0..self.e {
            self.genome[wg + e] = self.base_w[e].clamp(-W_CAP, W_CAP) as i16;
        }
        self.digest[slot] = self.base_digest;
    }

    pub(crate) fn genesis_digest(&self) -> u64 {
        let mut h = 0u64;
        for e in 0..self.e {
            h ^= edge_mix(e as u32, self.base_w[e].clamp(-W_CAP, W_CAP) as i16);
        }
        h
    }

    pub(crate) fn genome_digest_full(&self, slot: usize) -> u64 {
        let wg = slot * self.e;
        let mut h = 0u64;
        for e in 0..self.e {
            h ^= edge_mix(e as u32, self.genome[wg + e]);
        }
        h
    }

    /// The one way a weight changes after birth: the digest follows.
    #[inline]
    pub(crate) fn set_weight(&mut self, slot: usize, e: usize, w: i16) {
        let idx = slot * self.e + e;
        let old = self.genome[idx];
        if old == w {
            return;
        }
        self.genome[idx] = w;
        self.digest[slot] ^= edge_mix(e as u32, old) ^ edge_mix(e as u32, w);
    }
}
