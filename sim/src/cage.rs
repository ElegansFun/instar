//! The arena: a lab fly cage. A 128x128 floor grid (bare floor with a thin
//! residue, four raised food dishes, one water pool, a salt crust in the
//! driest corner), four walls and a ceiling that flies walk on, sixteen
//! flight layers, a lamp at the ceiling, a temperature gradient across the
//! cage and a humidity gradient from the water to the salt corner.

use crate::*;

/// Dish radius 4..6 cells; dishes keep this far from the water and each
/// other so a fly is never on two substrates.
const DISH_R_MIN: u32 = 4;
const DISH_R_SPAN: u32 = 3;
const WATER_R: i32 = 5;
const FEATURE_MARGIN: i32 = 10;
/// Odour chamfer decay per cell: 7/8.
const ODOR_NUM: i64 = 7;
const ODOR_DEN: i64 = 8;

impl World {
    /// Build the cage. Runs once, at genesis, and costs nothing per tick.
    pub(crate) fn gen_cage(&mut self) {
        let g = GRID as i32;
        // the water pool, then the salt corner farthest from it
        let wx = FEATURE_MARGIN + self.rng.below((g - 2 * FEATURE_MARGIN) as u32) as i32;
        let wy = FEATURE_MARGIN + self.rng.below((g - 2 * FEATURE_MARGIN) as u32) as i32;
        self.water = [wx as u8, wy as u8, WATER_R as u8];
        let corner = ((wy < g / 2) as u8) << 1 | (wx < g / 2) as u8;
        self.salt_corner = corner;
        let (sx, sy) = (if corner & 1 == 1 { g - 1 } else { 0 }, if corner & 2 == 2 { g - 1 } else { 0 });

        // the lamp: anywhere on the ceiling
        self.lamp = [self.rng.below(GRID as u32) as u8, self.rng.below(GRID as u32) as u8];

        // humidity: 255 at the pool falling to 0 at the salt corner, by
        // Chebyshev distance so it reads as a plain gradient
        for c in 0..GRID * GRID {
            let (cx, cy) = ((c % GRID) as i32, (c / GRID) as i32);
            let dw = ((cx - wx).abs().max((cy - wy).abs()) - WATER_R).max(0);
            let ds = (cx - sx).abs().max((cy - sy).abs());
            let m = if dw + ds == 0 { 255 } else { (255 * ds) / (dw + ds) };
            self.moisture0[c] = m.clamp(0, 255) as u8;
            self.height[c] = 0;
            self.biome[c] = BIOME_FLOOR;
        }
        for c in 0..GRID * GRID {
            let (cx, cy) = ((c % GRID) as i32, (c / GRID) as i32);
            if (cx - wx) * (cx - wx) + (cy - wy) * (cy - wy) <= WATER_R * WATER_R {
                self.biome[c] = BIOME_WATER;
                self.moisture0[c] = 255;
            }
        }

        // dishes: two yeast, two banana, raised one layer, never touching the
        // water or each other
        for i in 0..DISHES {
            let kind = if i % 2 == 0 { BIOME_YEAST } else { BIOME_BANANA };
            let r = (DISH_R_MIN + self.rng.below(DISH_R_SPAN)) as i32;
            let mut placed = false;
            for _ in 0..64 {
                let cx = FEATURE_MARGIN + self.rng.below((g - 2 * FEATURE_MARGIN) as u32) as i32;
                let cy = FEATURE_MARGIN + self.rng.below((g - 2 * FEATURE_MARGIN) as u32) as i32;
                let clear_water = (cx - wx).abs().max((cy - wy).abs()) > r + WATER_R + 2;
                let clear_dishes = (0..i).all(|j| {
                    let d = self.dish[j];
                    (cx - d[1] as i32).abs().max((cy - d[2] as i32).abs()) > r + d[3] as i32 + 2
                });
                if clear_water && clear_dishes {
                    self.dish[i] = [kind, cx as u8, cy as u8, r as u8];
                    placed = true;
                    break;
                }
            }
            if !placed {
                // a crowded draw: stack on the cage centre line, still apart
                let cx = 16 + 32 * i as i32;
                self.dish[i] = [kind, cx as u8, (g / 2) as u8, r as u8];
            }
            let d = self.dish[i];
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx * dx + dy * dy > r * r {
                        continue;
                    }
                    let (x, y) = (d[1] as i32 + dx, d[2] as i32 + dy);
                    if x < 0 || y < 0 || x >= g || y >= g {
                        continue;
                    }
                    let c = y as usize * GRID + x as usize;
                    if self.biome[c] == BIOME_FLOOR {
                        self.biome[c] = kind;
                        self.height[c] = DISH_HEIGHT;
                    }
                }
            }
        }

        self.moisture.copy_from_slice(&self.moisture0);
        for c in 0..GRID * GRID {
            self.biome[c] = self.classify(c);
        }
    }

    /// What a cell is right now: the salt crust follows the humidity,
    /// everything else is fixed at genesis.
    #[inline]
    pub(crate) fn classify(&self, c: usize) -> u8 {
        match self.biome[c] {
            BIOME_FLOOR | BIOME_SALT => {
                if self.moisture[c] < DRY_MOIST {
                    BIOME_SALT
                } else {
                    BIOME_FLOOR
                }
            }
            b => b,
        }
    }

    /// Ambient light 0..255: a pure function of the tick, which is already
    /// hashed, so the cycle costs no state and cannot desync. Lights off:
    /// the night floor.
    #[inline]
    pub(crate) fn ambient(&self) -> i32 {
        if self.lights_off_ticks > 0 {
            return 1;
        }
        128 + ((isin((self.tick << DAY_SHIFT) as u16) * 127) >> 15)
    }

    /// The lamp's own light at a point, 0..255, in cell units: `255 * K /
    /// (K + d^2)` from the bulb at the ceiling. Zero when the lights are off.
    #[inline]
    pub(crate) fn lamp_light(&self, x: i32, y: i32, z: i32) -> i32 {
        if self.lights_off_ticks > 0 {
            return 0;
        }
        let dx = ((x - ((self.lamp[0] as i32) << FP)) >> FP) as i64;
        let dy = ((y - ((self.lamp[1] as i32) << FP)) >> FP) as i64;
        let dz = ((ZTOP - z) >> FP) as i64;
        let d2 = dx * dx + dy * dy + dz * dz;
        (255 * LAMP_K as i64 / (LAMP_K as i64 + d2)) as i32
    }

    /// Total light at a point: ambient plus the lamp.
    #[inline]
    pub(crate) fn light_at(&self, x: i32, y: i32, z: i32) -> i32 {
        self.ambient() + self.lamp_light(x, y, z)
    }

    /// Temperature at the cage centre in centi-degrees Celsius, 18 to 30
    /// around a 24 baseline.
    #[inline]
    pub(crate) fn temperature_centre(&self) -> i32 {
        TEMP_BASE + ((isin((self.tick >> TEMP_SHIFT) as u16) * TEMP_AMP) >> 15)
    }

    /// Temperature at a position: the centre value plus a linear gradient
    /// across x, hot on the lamp's side.
    #[inline]
    pub(crate) fn temperature_at(&self, x: i32) -> i32 {
        let cx = (x >> FP) - (GRID as i32 / 2);
        let sign = if (self.lamp[0] as usize) >= GRID / 2 { 1 } else { -1 };
        self.temperature_centre() + sign * (cx * TEMP_GRAD) / (GRID as i32 / 2)
    }

    /// Odour on the floor: every cell's food is a source, spread by a
    /// two-pass chamfer with a 7/8 decay per cell (max, not sum: a plume
    /// reads as the nearest strong source). Refreshed every 8 ticks.
    pub(crate) fn refresh_odor(&mut self) {
        let g = GRID;
        for c in 0..g * g {
            self.odor[c] = self.food[c];
        }
        let decay = |v: i32| ((v as i64 * ODOR_NUM) / ODOR_DEN) as i32;
        for y in 0..g {
            for x in 0..g {
                let c = y * g + x;
                let mut v = self.odor[c];
                if x > 0 {
                    v = v.max(decay(self.odor[c - 1]));
                }
                if y > 0 {
                    v = v.max(decay(self.odor[c - g]));
                }
                self.odor[c] = v;
            }
        }
        for y in (0..g).rev() {
            for x in (0..g).rev() {
                let c = y * g + x;
                let mut v = self.odor[c];
                if x + 1 < g {
                    v = v.max(decay(self.odor[c + 1]));
                }
                if y + 1 < g {
                    v = v.max(decay(self.odor[c + g]));
                }
                self.odor[c] = v;
            }
        }
    }

    /// Odour at a point in the volume: the floor field, thinning linearly
    /// with height to nothing at the ceiling.
    #[inline]
    pub(crate) fn odor_at(&self, x: i32, y: i32, z: i32) -> i32 {
        let layer = (z >> FP).clamp(0, LAYERS);
        ((self.odor[cell_of(x, y)] as i64 * (LAYERS - layer) as i64) / LAYERS as i64) as i32
    }

    /// One row of the floor per tick, so every cell refreshes every 128
    /// ticks: food regrows to its substrate ceiling, humidity recovers
    /// toward genesis, and the salt crust follows the humidity.
    pub(crate) fn sweep(&mut self) {
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

    pub(crate) fn deposit(&mut self, c: usize, amount: i32) {
        if self.biome[c] == BIOME_WATER {
            return; // nothing settles in liquid
        }
        self.food[c] = (self.food[c] + amount).min(FOOD_MAX);
    }

    /// Where a founder may stand: floor or a dish, never water or salt.
    #[inline]
    pub(crate) fn spawnable(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= XMAX || y >= XMAX {
            return false;
        }
        matches!(self.biome[cell_of(x, y)], BIOME_FLOOR | BIOME_YEAST | BIOME_BANANA)
    }

    pub(crate) fn floor_spot(&mut self) -> (i32, i32) {
        for _ in 0..64 {
            let x = self.rng.below(XMAX as u32) as i32;
            let y = self.rng.below(XMAX as u32) as i32;
            if self.spawnable(x, y) {
                return (x, y);
            }
        }
        for c in 0..GRID * GRID {
            let (x, y) = ((((c % GRID) as i32) << FP) + HALF, (((c / GRID) as i32) << FP) + HALF);
            if self.spawnable(x, y) {
                return (x, y);
            }
        }
        ((GRID as i32 / 2) << FP, (GRID as i32 / 2) << FP)
    }

    /// Surface height under a floor position, 16.16.
    #[inline]
    pub(crate) fn floor_z(&self, x: i32, y: i32) -> i32 {
        (self.height[cell_of(x, y)] as i32) << FP
    }
}
