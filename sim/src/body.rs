//! The body of one fly and the ecology of the cage: senses (written only
//! into `acc[]` via the role lists), motor-neuron readout into walking or
//! flight, feeding, upkeep, death, reproduction and fights.
//!
//! Everything the fly does about what it senses has to come out of the
//! connectome, or the connectome is decoration: no sense writes `turn`,
//! `thrust`, or `intake` directly.

use crate::*;

// ---------------------------------------------------------------- senses
/// Klinotaxis: a rising odour at the antennae (one cell ahead) drives the
/// olfactory neurons hard; the tonic term keeps them primed near food. The
/// floor residue reads a few hundred, a banana dish 30,000 falling by 7/8
/// per cell, and a steady input of 4,096 (`STEADY_FLOOR`) is the firing
/// floor: the plume of a dish is felt from ~15 cells out, the bare floor
/// is not.
const ORN_DELTA_GAIN: i32 = 8;
const ORN_TONIC_SHIFT: i32 = 0;
/// Sugar under the proboscis on a dish; the leg tarsi taste every substrate
/// (the floor residue, 800 at most, stays under the floor).
const SWEET_GAIN: i32 = 4;
const LEG_TASTE_GAIN: i32 = 2;
/// Above THRESH on purpose: contact, salt on the tarsi and a bite fire on
/// the tick they happen.
const CONTACT_DRIVE: i32 = 20_000;
/// Per centi-degree of deviation from the 24 C baseline: fires past 2.5 C.
const THERMO_GAIN: i32 = 16;
/// Per point of dryness (0..255): fires where humidity is under 128, the
/// dry half of the gradient.
const HYGRO_GAIN: i32 = 32;
/// Per light unit (0..510, ambient plus lamp) averaged over an eye's 16
/// samples: fires from mid-day ambient (128) up; the lamp channel alone for
/// R7/R8 and the overhead for ocelli.
const VISUAL_GAIN: i32 = 32;
const UV_GAIN: i32 = 48;
const OCELLAR_GAIN: i32 = 24;
/// Eye sampling: 8 azimuths over the eye's front quadrant, 2 elevations,
/// at this many cells from the head.
const EYE_REACH: i32 = 3;
/// Johnston's organ: own airflow in flight plus each flying neighbour's
/// wingbeats within the radius.
const JON_SELF_SHIFT: i32 = 2;
const JON_NEIGHBOUR: i32 = 8_000;
const JON_RADIUS_FP: i64 = (8 << FP) as i64;
/// Own leg motion: a brisk walk (thrust above 4,096) is felt.
const CHORDOTONAL_SHIFT: i32 = 0;
/// Per heading unit of angular velocity, flight only.
const HALTERE_GAIN: i32 = 8;
/// Crop stretch: energy above satiety, plus what was just swallowed.
const INTERO_SHIFT: i32 = 0;
const INTERO_ATE_GAIN: i32 = 64;
/// A fly within this distance of the point 1.5 cells ahead is a contact.
const CONTACT_RADIUS_FP: i64 = (3 << FP) as i64 / 2;

// ---------------------------------------------------------------- walking
/// Baseline shuffle; leg motor neurons add per spike. A well-driven fly is
/// several times faster than a quiet one, so speed is a visible phenotype.
const BASE_THRUST: i32 = 2_000;
const LEG_THRUST: i32 = 400;
const THRUST_MAX: i32 = 24_000;
const TURN_GAIN: i32 = 60;
const WANDER: i32 = 60;
const MOVE_COST_SHIFT: i32 = 10;
const GAIT_STEP: i32 = 1_200;
const GAIT_PER_SPIKE: i32 = 30;
const GAIT_STEP_MAX: i32 = 8_000;

// ---------------------------------------------------------------- flight
/// `wing_rate` is a smoothed (1/8 per tick) count of wing-power spikes per
/// tick x 4096. Measured at genesis on the MaleCNS (8 founders, 8,000
/// ticks, seed INSTA): the 24 power motor neurons average 1.8 spikes per
/// tick, the smoothed rate sits at or above 3 for 6.1% of fly-ticks and at
/// or above 4 for 0.4%. Takeoff needs a burst to 4; an airborne fly lands
/// on contact once the rate has fallen under 3, so a flight is a bout of
/// sustained power and a fly that lets it drop comes down. Above 3 it
/// bumps the glass and keeps flying.
const RATE_ONE: i32 = 4_096;
const RATE_SHIFT: i32 = 3;
const TAKEOFF_RATE: i32 = 4 * RATE_ONE;
const LAND_RATE: i32 = 3 * RATE_ONE;
/// Vertical: under the landing rate the wings give no lift and the fly
/// sinks a quarter layer per tick (floor from the ceiling in three
/// seconds); at the landing rate the lift is already above gravity, so a
/// powered fly climbs and a fly that lets the power drop comes down.
const GRAVITY: i32 = 16_384;
const LIFT_MUL: i32 = 2;
/// Forward thrust: two units per unit of wing rate, so two spikes per tick
/// is a quarter cell per tick, about a brisk walk; four spikes per tick is
/// twice that.
const FLIGHT_THRUST_MUL: i32 = 2;
const FLIGHT_THRUST_MAX: i32 = 40_000;
/// Flight upkeep, on top of the metabolic base every fly pays: a fixed 48
/// per airborne tick (twelve times `METABOLIC_COST`) plus twice the
/// per-thrust cost of walking: 80-112 per tick at a wing rate of 2-4, so a
/// forty-tick bout costs about a fifth of a founder's starting energy.
const FLIGHT_BASE_COST: i32 = 48;
const FLIGHT_COST_MUL: i32 = 2;
const YAW_GAIN: i32 = 400;
const ROLL_GAIN: i32 = 1_500;
const ROLL_MAX: i32 = 16_000;
/// Abdomen motor neurons pitch the body up, at most 22 degrees.
const PITCH_GAIN: i32 = 200;
const PITCH_MAX: i32 = 4_096;
const HALTERE_DAMP: i32 = 2;
const TAKEOFF_KICK: i32 = 1 << FP;
const TAKEOFF_PITCH: i16 = 2_048;
const WINGBEAT_STEP: u16 = 8_192;

// ---------------------------------------------------------------- ecology
const METABOLIC_COST: i32 = 4;
const SALT_DRAIN: i32 = 30;
const WATER_DRAIN: i32 = 40;
/// The proboscis extends toward `PROBOSCIS_PER_SPIKE` per proboscis motor
/// spike this tick (smoothed by a quarter per tick) and pumps while it is
/// out: intake per tick is `FEED_MAX` scaled by the extension, so the meal
/// follows the motor rate and nothing feeds a fly whose pump is silent.
const FEED_MAX: i32 = 700;
const PROBOSCIS_PER_SPIKE: i32 = 96;
const PROBOSCIS_OUT: u8 = 64;
/// Male fights over food (Chen et al. 2002): a clearly stronger fly on a
/// cell with nothing to eat lunges at a weaker neighbour.
const BITE: i32 = 3_000;
const BITE_KEEP_NUM: i32 = 3;
const BITE_KEEP_DEN: i32 = 4;
const CONTEST_RADIUS_FP: i64 = (3 << FP) as i64 / 2;
const POWER_NUM: i32 = 3;
const POWER_DEN: i32 = 2;
const MATE_RADIUS: i32 = 8 << FP;
const MATE_MIN_ENERGY: i32 = 12_000;
const MATE_COST: i32 = 3_000;
/// Age past which metabolic upkeep starts climbing and death is old age.
const SENESCE_AT: u32 = 32_768;
/// Neurosecretory spikes accumulate; reproduction needs this much.
const HORMONE_THRESHOLD: u32 = 128;

impl World {
    pub(crate) fn spawn(&mut self, slot: usize, px: i32, py: i32, gen: u32, lin: u32, energy: i32) {
        self.alive[slot] = 1;
        self.x[slot] = px.clamp(0, XMAX - 1);
        self.y[slot] = py.clamp(0, XMAX - 1);
        self.z[slot] = self.floor_z(self.x[slot], self.y[slot]);
        self.heading[slot] = (self.rng.next() & 0xFFFF) as u16;
        self.pitch[slot] = 0;
        self.roll[slot] = 0;
        self.mode[slot] = MODE_WALK;
        self.surface[slot] = SURF_FLOOR;
        self.energy[slot] = energy;
        self.generation[slot] = gen;
        self.lineage[slot] = lin;
        self.age[slot] = 0;
        self.hormone[slot] = 0;
        self.wingbeat[slot] = 0;
        self.gait[slot] = (self.rng.next() & 0xFFFF) as u16;
        self.proboscis[slot] = 0;
        self.wing_rate[slot] = 0;
        self.last_odor[slot] = 0;
        self.ate_last[slot] = 0;
        self.bitten[slot] = 0;
        self.thrust_last[slot] = 0;
        self.turn_last[slot] = 0;
        self.contact[slot] = 0;
        self.eaten[slot] = 0;
        self.fed[slot] = 0;
        self.uid[slot] = UID_UNASSIGNED;
        self.clear_brain(slot);
        self.write_pose(slot);
        if gen > self.max_gen {
            self.max_gen = gen;
        }
    }

    pub(crate) fn kill(&mut self, w: usize, cause: u8) {
        self.alive[w] = 0;
        self.deaths += 1;
        if cause == CAUSE_KILLED {
            self.kills += 1;
        }
        let c = cell_of(self.x[w], self.y[w]);
        self.deposit(c, CORPSE_FOOD);
        self.push_event(EV_DEATH, w as u32, cause as u32);
    }

    fn write_pose(&mut self, w: usize) {
        let o = w * POSE_LEN;
        self.pose[o] = self.mode[w] as i16;
        self.pose[o + 1] = if self.mode[w] == MODE_FLY { -1 } else { self.surface[w] as i16 };
        self.pose[o + 2] = self.pitch[w];
        self.pose[o + 3] = self.roll[w];
        self.pose[o + 4] = self.wingbeat[w] as i16;
        let gait = (self.gait[w] >> 8) as i32;
        for k in 0..NLEGS {
            // tripod gait: L1 R2 L3 swing together, R1 L2 R3 half a cycle later
            let tripod = if matches!(k, 0 | 2 | 4) { 0 } else { 128 };
            self.pose[o + 5 + k] = ((gait + tripod) & 255) as i16;
        }
        self.pose[o + 11] = self.proboscis[w] as i16;
    }

    /// The point `dist` cells ahead along the heading in the plane of the
    /// current surface (x-y for floor, ceiling and flight; the wall's own
    /// plane on a wall), as a floor cell and a height.
    fn ahead(&self, w: usize, dist: i32) -> (i32, i32, i32) {
        let a = self.heading[w];
        // Q15 x cells -> 16.16 is a doubling
        let (du, dv) = (icos(a) * dist * 2, isin(a) * dist * 2);
        let (x, y, z) = (self.x[w], self.y[w], self.z[w]);
        let (nx, ny, nz) = match (self.mode[w], self.surface[w]) {
            (MODE_WALK, SURF_WALL_W | SURF_WALL_E) => (x, y + du, z + dv),
            (MODE_WALK, SURF_WALL_N | SURF_WALL_S) => (x + du, y, z + dv),
            _ => (x + du, y + dv, z),
        };
        (nx.clamp(0, XMAX - 1), ny.clamp(0, XMAX - 1), nz.clamp(0, ZTOP))
    }

    /// Another fly within 1.5 cells of the point 1.5 cells ahead of the head.
    fn fly_ahead(&self, w: usize) -> bool {
        let (px, py, pz) = self.ahead(w, 1);
        for m in 0..self.p {
            if m == w || self.alive[m] == 0 {
                continue;
            }
            let dx = (self.x[m] - px) as i64;
            let dy = (self.y[m] - py) as i64;
            let dz = (self.z[m] - pz) as i64;
            if dx * dx + dy * dy + dz * dz <= CONTACT_RADIUS_FP * CONTACT_RADIUS_FP {
                return true;
            }
        }
        false
    }

    fn flying_neighbours(&self, w: usize) -> i32 {
        let mut n = 0;
        for m in 0..self.p {
            if m == w || self.alive[m] == 0 || self.mode[m] != MODE_FLY {
                continue;
            }
            let dx = (self.x[m] - self.x[w]) as i64;
            let dy = (self.y[m] - self.y[w]) as i64;
            let dz = (self.z[m] - self.z[w]) as i64;
            if dx * dx + dy * dy + dz * dz <= JON_RADIUS_FP * JON_RADIUS_FP {
                n += 1;
            }
        }
        n
    }

    /// One compound eye: 8 azimuths over its front quadrant x 2 elevations
    /// of the light field, `EYE_REACH` cells out. `side` is +1 left, -1
    /// right (left turns are positive heading).
    fn eye(&self, w: usize, side: i32) -> i32 {
        let mut sum = 0;
        for k in 0..8 {
            let a = (self.heading[w] as i32 + side * (k * 2048 + 1024)) as u16;
            let sx = self.x[w] + icos(a) * EYE_REACH * 2;
            let sy = self.y[w] + isin(a) * EYE_REACH * 2;
            for lvl in 0..2 {
                let sz = (self.z[w] + (lvl << FP)).min(ZTOP);
                sum += self.light_at(sx.clamp(0, XMAX - 1), sy.clamp(0, XMAX - 1), sz);
            }
        }
        sum >> 4
    }

    /// Everything the fly senses this tick, per role. Reads world state and
    /// last tick's sensory memory; writes only that memory.
    fn sense(&mut self, w: usize, drive: &mut [i32; ROLE_MAX]) {
        drive.fill(0);
        let (x, y, z) = (self.x[w], self.y[w], self.z[w]);
        let here = cell_of(x, y);
        let walking = self.mode[w] == MODE_WALK;
        let on_floor = walking && self.surface[w] == SURF_FLOOR;
        let biome_here = self.biome[here];

        let (ax, ay, az) = self.ahead(w, 1);
        let odor = self.odor_at(ax, ay, az);
        let d_odor = odor - self.last_odor[w];
        self.last_odor[w] = odor;
        drive[ROLE_ORN as usize] = (d_odor.max(0) * ORN_DELTA_GAIN) + (odor >> ORN_TONIC_SHIFT);

        if on_floor {
            let food = self.food[here];
            if matches!(biome_here, BIOME_YEAST | BIOME_BANANA) {
                drive[ROLE_GRN_SWEET as usize] = food * SWEET_GAIN;
            }
            if biome_here == BIOME_SALT {
                drive[ROLE_GRN_BITTER as usize] = CONTACT_DRIVE;
            }
            drive[ROLE_TASTE_LEG as usize] = food * LEG_TASTE_GAIN;
        }

        let contact = self.contact[w] == 1 || self.bitten[w] == 1 || self.fly_ahead(w);
        self.contact[w] = 0;
        self.bitten[w] = 0;
        if contact {
            drive[ROLE_BRISTLE as usize] = CONTACT_DRIVE;
        }

        let neighbours = self.flying_neighbours(w);
        let own_air = if walking { 0 } else { self.thrust_last[w] >> JON_SELF_SHIFT };
        drive[ROLE_JON as usize] = own_air + neighbours * JON_NEIGHBOUR;
        drive[ROLE_CHORDOTONAL as usize] = if walking { self.thrust_last[w] >> CHORDOTONAL_SHIFT } else { 0 };
        drive[ROLE_HALTERE as usize] = if walking { 0 } else { self.turn_last[w].abs() * HALTERE_GAIN };

        let temp_dev = self.temperature_at(x) - TEMP_BASE;
        drive[ROLE_THERMO_HOT as usize] = temp_dev.max(0) * THERMO_GAIN;
        drive[ROLE_THERMO_COLD as usize] = (-temp_dev).max(0) * THERMO_GAIN;
        drive[ROLE_HYGRO as usize] = (255 - self.moisture[here] as i32) * HYGRO_GAIN;

        drive[ROLE_PR_R1_6 as usize] = self.eye(w, 1) * VISUAL_GAIN;
        drive[ROLE_PR_R1_6_R as usize] = self.eye(w, -1) * VISUAL_GAIN;
        let uv = self.lamp_light(x, y, z) * UV_GAIN;
        drive[ROLE_PR_R7_8 as usize] = uv;
        drive[ROLE_PR_R7_8_R as usize] = uv;
        drive[ROLE_OCELLAR as usize] = self.light_at(x, y, ZTOP) * OCELLAR_GAIN;

        drive[ROLE_INTERO as usize] = ((self.energy[w] - SATIETY).max(0) >> INTERO_SHIFT) + self.ate_last[w] * INTERO_ATE_GAIN;
    }

    /// Climb from the floor or the ceiling onto a wall.
    fn mount_wall(&mut self, w: usize, wall: u8, from_ceiling: bool) {
        self.surface[w] = wall;
        match wall {
            SURF_WALL_W => self.x[w] = 0,
            SURF_WALL_E => self.x[w] = XMAX - 1,
            SURF_WALL_N => self.y[w] = 0,
            _ => self.y[w] = XMAX - 1,
        }
        self.z[w] = if from_ceiling { ZTOP } else { 0 };
        self.heading[w] = if from_ceiling { 49_152 } else { 16_384 };
        self.contact[w] = 1;
    }

    /// Step off a wall onto the floor or the ceiling, heading away from it.
    fn dismount_wall(&mut self, w: usize, to_ceiling: bool) {
        let wall = self.surface[w];
        match wall {
            SURF_WALL_W => self.x[w] = HALF,
            SURF_WALL_E => self.x[w] = XMAX - 1 - HALF,
            SURF_WALL_N => self.y[w] = HALF,
            _ => self.y[w] = XMAX - 1 - HALF,
        }
        self.heading[w] = match wall {
            SURF_WALL_W => 0,
            SURF_WALL_E => 32_768,
            SURF_WALL_N => 16_384,
            _ => 49_152,
        };
        if to_ceiling {
            self.surface[w] = SURF_CEILING;
            self.z[w] = ZTOP;
        } else {
            self.surface[w] = SURF_FLOOR;
            self.z[w] = self.floor_z(self.x[w], self.y[w]);
        }
    }

    pub(crate) fn walk(&mut self, w: usize, thrust: i32, turn: i32) {
        self.heading[w] = (self.heading[w] as i32 + turn) as u16;
        let a = self.heading[w];
        let du = (icos(a) * thrust) >> 15;
        let dv = (isin(a) * thrust) >> 15;
        match self.surface[w] {
            SURF_FLOOR | SURF_CEILING => {
                let ceiling = self.surface[w] == SURF_CEILING;
                let (nx, ny) = (self.x[w] + du, self.y[w] + dv);
                if nx < 0 {
                    self.mount_wall(w, SURF_WALL_W, ceiling);
                } else if nx >= XMAX {
                    self.mount_wall(w, SURF_WALL_E, ceiling);
                } else if ny < 0 {
                    self.mount_wall(w, SURF_WALL_N, ceiling);
                } else if ny >= XMAX {
                    self.mount_wall(w, SURF_WALL_S, ceiling);
                } else {
                    self.x[w] = nx;
                    self.y[w] = ny;
                    self.z[w] = if ceiling { ZTOP } else { self.floor_z(nx, ny) };
                }
            }
            wall => {
                let nz = self.z[w] + dv;
                if nz < 0 {
                    self.dismount_wall(w, false);
                } else if nz > ZTOP {
                    self.dismount_wall(w, true);
                } else {
                    self.z[w] = nz;
                    let along = if matches!(wall, SURF_WALL_W | SURF_WALL_E) { &mut self.y[w] } else { &mut self.x[w] };
                    let nu = *along + du;
                    if nu < 0 || nu >= XMAX {
                        self.contact[w] = 1; // a corner: slide, do not leave
                    }
                    *along = nu.clamp(0, XMAX - 1);
                }
            }
        }
    }

    fn land(&mut self, w: usize, surface: u8) {
        self.mode[w] = MODE_WALK;
        self.surface[w] = surface;
        match surface {
            SURF_FLOOR => self.z[w] = self.floor_z(self.x[w], self.y[w]),
            SURF_CEILING => self.z[w] = ZTOP,
            SURF_WALL_W => self.x[w] = 0,
            SURF_WALL_E => self.x[w] = XMAX - 1,
            SURF_WALL_N => self.y[w] = 0,
            _ => self.y[w] = XMAX - 1,
        }
        if !matches!(surface, SURF_FLOOR | SURF_CEILING) {
            self.heading[w] = 16_384;
        }
        self.contact[w] = 1;
        self.push_event(EV_LANDING, w as u32, surface as u32);
    }

    /// Free flight: thrust along the heading, lift against gravity, walls
    /// and floor and ceiling as contacts. Returns the horizontal thrust for
    /// the energy bill.
    fn fly(&mut self, w: usize, yaw: i32, abdomen: i32, steer: i32) -> i32 {
        self.heading[w] = (self.heading[w] as i32 + yaw) as u16;
        let roll_target = (steer * ROLL_GAIN).clamp(-ROLL_MAX, ROLL_MAX);
        let roll = self.roll[w] as i32;
        self.roll[w] = (roll + ((roll_target - roll) >> 2)) as i16;
        let pitch_target = (abdomen * PITCH_GAIN).clamp(-PITCH_MAX, PITCH_MAX);
        let pitch = self.pitch[w] as i32;
        self.pitch[w] = (pitch + ((pitch_target - pitch) >> 3)) as i16;

        let thrust = (self.wing_rate[w] * FLIGHT_THRUST_MUL).min(FLIGHT_THRUST_MAX);
        // under the landing rate the wings do not sustain flight: the fly sinks
        let lift = if self.wing_rate[w] >= LAND_RATE { (self.wing_rate[w] * LIFT_MUL).min(2 * GRAVITY) } else { 0 };
        let p = self.pitch[w] as u16;
        let horiz = (thrust * icos(p)) >> 15;
        let vz = ((thrust * isin(p)) >> 15) + lift - GRAVITY;
        let a = self.heading[w];
        let nx = self.x[w] + ((icos(a) * horiz) >> 15);
        let ny = self.y[w] + ((isin(a) * horiz) >> 15);
        let nz = self.z[w] + vz;
        let powered = self.wing_rate[w] >= LAND_RATE;

        // walls first: a wall contact keeps x/y inside; then floor/ceiling
        let mut touched: Option<u8> = None;
        if nx < 0 {
            touched = Some(SURF_WALL_W);
        } else if nx >= XMAX {
            touched = Some(SURF_WALL_E);
        } else if ny < 0 {
            touched = Some(SURF_WALL_N);
        } else if ny >= XMAX {
            touched = Some(SURF_WALL_S);
        }
        self.x[w] = nx.clamp(0, XMAX - 1);
        self.y[w] = ny.clamp(0, XMAX - 1);
        let floor = self.floor_z(self.x[w], self.y[w]);
        if nz <= floor {
            self.z[w] = floor;
            touched = Some(SURF_FLOOR);
        } else if nz >= ZTOP {
            self.z[w] = ZTOP;
            touched = Some(SURF_CEILING);
        } else {
            self.z[w] = nz;
        }
        if let Some(s) = touched {
            if powered {
                self.contact[w] = 1; // bumped the glass, still flying
            } else {
                self.land(w, s);
            }
        }
        thrust
    }

    fn takeoff(&mut self, w: usize) {
        let from = self.surface[w];
        self.mode[w] = MODE_FLY;
        self.surface[w] = SURF_NONE;
        // leave the surface: a kick away from it; on a wall the heading
        // stays a yaw, so the fly departs across the cage
        match from {
            SURF_CEILING => self.z[w] -= TAKEOFF_KICK,
            SURF_FLOOR => self.z[w] += TAKEOFF_KICK,
            SURF_WALL_W => self.x[w] += TAKEOFF_KICK,
            SURF_WALL_E => self.x[w] -= TAKEOFF_KICK,
            SURF_WALL_N => self.y[w] += TAKEOFF_KICK,
            _ => self.y[w] -= TAKEOFF_KICK,
        }
        self.x[w] = self.x[w].clamp(0, XMAX - 1);
        self.y[w] = self.y[w].clamp(0, XMAX - 1);
        self.z[w] = self.z[w].clamp(0, ZTOP);
        self.pitch[w] = TAKEOFF_PITCH;
        self.push_event(EV_TAKEOFF, w as u32, 0);
    }

    /// Motor-neuron readout into the body, then feeding, upkeep, death,
    /// the reproduction gate.
    fn act(&mut self, w: usize, cnt: &[u32; ROLE_MAX]) {
        let c = |r: u8| cnt[r as usize] as i32;
        let leg_l = c(ROLE_MN_LEG_L1) + c(ROLE_MN_LEG_L2) + c(ROLE_MN_LEG_L3);
        let leg_r = c(ROLE_MN_LEG_R1) + c(ROLE_MN_LEG_R2) + c(ROLE_MN_LEG_R3);
        let power = c(ROLE_MN_WING_POWER_L) + c(ROLE_MN_WING_POWER_R);
        let steer = c(ROLE_MN_WING_STEER_L) - c(ROLE_MN_WING_STEER_R);
        let haltere = c(ROLE_MN_HALTERE_L) + c(ROLE_MN_HALTERE_R);
        let prob = c(ROLE_MN_PROBOSCIS);
        let abdomen = c(ROLE_MN_ABDOMEN);
        let neuro = cnt[ROLE_NEUROSECRETORY as usize];

        // wing power rate: smoothed, the takeoff/landing decision
        let rate = self.wing_rate[w];
        self.wing_rate[w] = rate + ((power * RATE_ONE - rate) >> RATE_SHIFT);
        let wander = self.rng.below((WANDER * 2) as u32) as i32 - WANDER;

        if self.mode[w] == MODE_WALK && self.wing_rate[w] >= TAKEOFF_RATE {
            self.takeoff(w);
        }

        let (thrust, turn, cost);
        if self.mode[w] == MODE_WALK {
            let drive = leg_l + leg_r;
            turn = (leg_l - leg_r) * TURN_GAIN + wander;
            thrust = (BASE_THRUST + drive * LEG_THRUST).min(THRUST_MAX);
            self.walk(w, thrust, turn);
            self.gait[w] = self.gait[w].wrapping_add((GAIT_STEP + drive * GAIT_PER_SPIKE).min(GAIT_STEP_MAX) as u16);
            // grounded: pitch and roll relax
            self.pitch[w] = (self.pitch[w] as i32 - (self.pitch[w] as i32 >> 2)) as i16;
            self.roll[w] = (self.roll[w] as i32 - (self.roll[w] as i32 >> 2)) as i16;
            cost = thrust >> MOVE_COST_SHIFT;
        } else {
            // yaw from the steering muscles, damped by the halteres
            let raw = steer * YAW_GAIN + wander;
            turn = raw * 8 / (8 + haltere * HALTERE_DAMP);
            thrust = self.fly(w, turn, abdomen, steer);
            self.wingbeat[w] = self.wingbeat[w].wrapping_add(WINGBEAT_STEP.wrapping_add((self.wing_rate[w] >> 2) as u16));
            cost = (thrust >> MOVE_COST_SHIFT) * FLIGHT_COST_MUL + FLIGHT_BASE_COST;
        }
        self.thrust_last[w] = thrust;
        self.turn_last[w] = turn;

        // -------- feeding: the proboscis pump is motor output --------
        let target = (prob * PROBOSCIS_PER_SPIKE).min(255);
        let ext = self.proboscis[w] as i32;
        self.proboscis[w] = (ext + ((target - ext) >> 2)) as u8;
        let here = cell_of(self.x[w], self.y[w]);
        let b = self.biome[here];
        let on_floor = self.mode[w] == MODE_WALK && self.surface[w] == SURF_FLOOR;
        let mut ate = 0;
        if on_floor && b != BIOME_WATER && self.food[here] > 0 && self.proboscis[w] >= PROBOSCIS_OUT {
            ate = self.food[here].min(FEED_MAX * self.proboscis[w] as i32 / 255);
            self.food[here] -= ate;
            self.energy[w] = (self.energy[w] + ate).min(ENERGY_CAP);
            self.eaten[w] = self.eaten[w].saturating_add(ate as u32);
        }
        self.ate_last[w] = ate;

        // -------- upkeep --------
        // Upkeep climbs with age, so an old fly dies when its habitat can no
        // longer carry it: death as a consequence, not a timer.
        let senesce = (self.age[w].saturating_sub(SENESCE_AT) >> 8) as i32;
        let in_water = on_floor && b == BIOME_WATER;
        let on_salt = on_floor && b == BIOME_SALT;
        self.energy[w] -= METABOLIC_COST
            + senesce
            + cost
            + if on_salt { SALT_DRAIN } else { 0 }
            + if in_water { WATER_DRAIN } else { 0 };

        if self.energy[w] <= 0 {
            let cause = if self.mode[w] == MODE_FLY {
                CAUSE_EXHAUSTED
            } else if in_water {
                CAUSE_DROWNED
            } else if on_salt {
                CAUSE_DESICCATED
            } else if self.age[w] > SENESCE_AT {
                CAUSE_SENESCENCE
            } else {
                CAUSE_STARVED
            };
            self.kill(w, cause);
            return;
        }

        // -------- neurosecretory gate --------
        if neuro > 0 {
            let before = self.hormone[w];
            self.hormone[w] = before.saturating_add(neuro);
            if before < HORMONE_THRESHOLD && self.hormone[w] >= HORMONE_THRESHOLD {
                self.push_event(EV_MATURE, w as u32, 0);
            }
        }
        if self.energy[w] >= REPRO_ENERGY && self.hormone[w] >= HORMONE_THRESHOLD {
            self.reproduce(w);
        }
        self.write_pose(w);
    }

    /// An eligible partner already within touching distance. A proximity
    /// test at the moment of reproduction, not steering: getting near a
    /// mate is the connectome's job.
    fn partner_within(&self, parent: usize, radius: i32) -> Option<usize> {
        let r = radius as i64;
        let mut best: Option<(i64, usize)> = None;
        for m in 0..self.p {
            if m == parent || self.alive[m] == 0 || self.energy[m] < MATE_MIN_ENERGY {
                continue;
            }
            let dx = (self.x[m] - self.x[parent]) as i64;
            let dy = (self.y[m] - self.y[parent]) as i64;
            let dz = (self.z[m] - self.z[parent]) as i64;
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 <= r * r && best.map_or(true, |(bd, _)| d2 < bd) {
                best = Some((d2, m));
            }
        }
        best.map(|(_, m)| m)
    }

    /// Where a child is born: the jittered point when that floor cell is
    /// spawnable, else the first spawnable of the parent's eight neighbours
    /// in a fixed order (so the choice replays), else the parent's own cell.
    /// A parent can be standing on salt or in water; the child should not
    /// start life there when open floor is one cell away.
    fn child_spot(&self, parent: usize, jitter_x: i32, jitter_y: i32) -> (i32, i32) {
        let (jx, jy) = (self.x[parent] + jitter_x, self.y[parent] + jitter_y);
        if self.spawnable(jx, jy) {
            return (jx, jy);
        }
        const NEIGHBOURS: [(i32, i32); 8] = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (-1, -1), (1, -1)];
        let c = cell_of(self.x[parent], self.y[parent]);
        let (cx, cy) = ((c % GRID) as i32, (c / GRID) as i32);
        for (dx, dy) in NEIGHBOURS {
            let (nx, ny) = (((cx + dx) << FP) + HALF, ((cy + dy) << FP) + HALF);
            if self.spawnable(nx, ny) {
                return (nx, ny);
            }
        }
        (self.x[parent], self.y[parent])
    }

    pub(crate) fn reproduce(&mut self, parent: usize) {
        if self.pop() >= self.capacity {
            return;
        }
        let Some(partner) = self.partner_within(parent, MATE_RADIUS) else { return };
        let Some(slot) = self.free_slot() else { return };

        let half = self.energy[parent] / 2;
        self.energy[parent] = half;
        self.energy[partner] -= MATE_COST;
        self.hormone[parent] = 0;
        // symmetric: [-1, +1] cells, so lineages do not drift across the cage
        let jitter_x = (self.rng.below((2 << FP) + 1) as i32) - (1 << FP);
        let jitter_y = (self.rng.below((2 << FP) + 1) as i32) - (1 << FP);
        let gen = self.generation[parent].max(self.generation[partner]) + 1;
        let lin = self.lineage[parent];
        let (px, py) = self.child_spot(parent, jitter_x, jitter_y);

        // crossover: each canonical edge weight from either parent (64 edges
        // per rng draw), then 1..6 signed mutations
        let e_count = self.e;
        let (gp, gq, gc) = (parent * e_count, partner * e_count, slot * e_count);
        for chunk in 0..e_count.div_ceil(64) {
            let bits = self.rng.next();
            let base = chunk * 64;
            let end = (base + 64).min(e_count);
            for e in base..end {
                self.genome[gc + e] = if (bits >> (e - base)) & 1 == 1 { self.genome[gp + e] } else { self.genome[gq + e] };
            }
        }
        // the child's digest is computed once here; every later weight
        // change goes through `set_weight` and updates it incrementally
        self.digest[slot] = self.genome_digest_full(slot);
        let muts = 1 + self.rng.below(6) as usize;
        for _ in 0..muts {
            let e = self.rng.below(e_count as u32) as usize;
            let w0 = self.genome[gc + e] as i32;
            // a floor of 64 lets a silenced synapse be rediscovered
            let span = (w0.abs() / 3).clamp(64, W_CAP) as u32;
            let delta = self.rng.below(span * 2 + 1) as i32 - span as i32;
            // Signed: the census records polarity on no edge, so
            // excitatory-only was never a fact about the animal. Any negative
            // weight in this world was found by selection HERE and is a claim
            // about this simulation, not about the fly.
            let w1 = (w0 + delta).clamp(-W_CAP, W_CAP) as i16;
            self.set_weight(slot, e, w1);
        }
        self.spawn(slot, px, py, gen, lin, half);
        self.births += 1;
        self.push_event(EV_BIRTH, slot as u32, parent as u32);
    }

    /// Fights, bucketed and lethal. Pair order is fixed and explicit:
    /// buckets in index order, list order within a bucket, offsets in the
    /// order given, `i` always tested as aggressor before `j`, because "who
    /// bit whom" has to be reproducible.
    fn contests(&mut self) {
        const BG: usize = 16; // 16x16 buckets of 8x8 cells
        let mut head = [-1i16; BG * BG];
        let mut next = [-1i16; MAX_POP_LIMIT];
        for w in 0..self.p {
            if self.alive[w] == 0 || self.mode[w] != MODE_WALK || self.surface[w] != SURF_FLOOR {
                continue;
            }
            let c = cell_of(self.x[w], self.y[w]);
            let b = (c / GRID / 8) * BG + (c % GRID) / 8;
            next[w] = head[b];
            head[b] = w as i16;
        }
        // {self, E, SE, S, SW} visits every unordered pair of adjacent
        // buckets exactly once; the cage has an edge, so no wrap.
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

    /// The clearly stronger fly lunges, but only when it is hungry and
    /// standing on a cell with nothing else to eat: a grazed cell reads zero
    /// within a few ticks, so the empty-cell test alone let sated parents
    /// eat their newborns.
    fn contest_pair(&mut self, i: usize, j: usize) {
        let dx = (self.x[i] - self.x[j]) as i64;
        let dy = (self.y[i] - self.y[j]) as i64;
        let dz = (self.z[i] - self.z[j]) as i64;
        if dx * dx + dy * dy + dz * dz > CONTEST_RADIUS_FP * CONTEST_RADIUS_FP {
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

    pub(crate) fn tick_one(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        if self.lights_off_ticks > 0 {
            self.lights_off_ticks -= 1;
        }
        self.sweep();
        if self.tick & ODOR_REFRESH_MASK == 0 {
            self.refresh_odor();
        }

        let mut drive = [0i32; ROLE_MAX];
        for w in 0..self.p {
            if self.alive[w] == 0 {
                continue;
            }
            self.age[w] = self.age[w].wrapping_add(1);
            self.sense(w, &mut drive);
            let cnt = self.brain(w, &drive);
            let fc = &mut self.fired_count[w * FIRE_GROUPS..(w + 1) * FIRE_GROUPS];
            fc.fill(0);
            for r in 0..ROLE_MAX {
                fc[GROUP_ANY] += cnt[r];
                fc[group_of(r as u8)] += cnt[r];
            }
            self.act(w, &cnt);
        }

        self.contests();
    }
}
