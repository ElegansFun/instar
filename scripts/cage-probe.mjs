// Is the cage the cage it is designed to be, on every seed?
//
// Eight seeds: every substrate class present, four raised dishes (two
// yeast, two banana) clear of the water and of each other, a water pool, a
// salt crust in the corner farthest from the water, humidity 255 at the pool
// and 0 in the salt corner, the lamp on the ceiling, day/night and
// temperature as pure functions of the tick, and no fly ever outside the
// volume over a run that pushes forty of them around walls, ceiling and air.
//
//   node scripts/cage-probe.mjs

import { boot, cellOf, BIOME, GRID, LAYERS, SEED } from "./sim-host.mjs";

const SEEDS = [SEED, 1n, 2n, 12345n, 0xdeadbeefn, 99999999n, 777n, 31337n];
const WALK_TICKS = 600;

const pct = (n, d) => ((100 * n) / d).toFixed(1).padStart(6);

async function main() {
  const fail = [];
  const h = await boot();
  console.log(`biome shares per seed (% of the floor)\n`);
  console.log(["seed".padEnd(12), ...BIOME.map((b) => b.padStart(7))].join(" "), "  dishes  water   lamp    salt");
  for (const seed of SEEDS) {
    const { sim, view, N, E, P } = h;
    sim.world_init(seed, N, E, P, 0);
    const biome = view.biome(), height = view.height(), moisture = view.moisture();
    const counts = new Array(BIOME.length).fill(0);
    for (let c = 0; c < GRID * GRID; c++) counts[biome[c]]++;
    const dishes = [];
    for (let i = 0; i < sim.dish_count(); i++) dishes.push([sim.dish_kind(i), sim.dish_x(i), sim.dish_y(i), sim.dish_r(i)]);
    const water = [sim.water_x(), sim.water_y(), sim.water_r()];
    const lamp = [sim.lamp_x(), sim.lamp_y()];
    const corner = sim.salt_corner();
    console.log(`${seed.toString(16).padEnd(12)} ${counts.map((c) => pct(c, GRID * GRID)).join(" ")}   ${dishes.map((d) => `${BIOME[d[0]][0]}@${d[1]},${d[2]}r${d[3]}`).join(" ")}  ${water.join(",")}  ${lamp.join(",")}  corner ${corner}`);
    const tag = `seed ${seed.toString(16)}`;
    for (let b = 0; b < BIOME.length; b++) if (counts[b] === 0) fail.push(`${tag}: no ${BIOME[b]} cell`);
    if (dishes.length !== 4) fail.push(`${tag}: ${dishes.length} dishes`);
    if (dishes.filter((d) => d[0] === 1).length !== 2 || dishes.filter((d) => d[0] === 2).length !== 2) fail.push(`${tag}: dish kinds are not two yeast + two banana`);
    for (let i = 0; i < dishes.length; i++) {
      const [, x, y, r] = dishes[i];
      const c = y * GRID + x;
      if (height[c] !== 1) fail.push(`${tag}: dish ${i} centre is not raised`);
      if (biome[c] !== dishes[i][0]) fail.push(`${tag}: dish ${i} centre has biome ${BIOME[biome[c]]}`);
      if (Math.max(Math.abs(x - water[0]), Math.abs(y - water[1])) <= r + water[2]) fail.push(`${tag}: dish ${i} touches the water`);
      for (let j = 0; j < i; j++) if (Math.max(Math.abs(x - dishes[j][1]), Math.abs(y - dishes[j][2])) <= r + dishes[j][3]) fail.push(`${tag}: dishes ${i} and ${j} overlap`);
    }
    const wc = water[1] * GRID + water[0];
    if (biome[wc] !== 3 || moisture[wc] !== 255) fail.push(`${tag}: water centre is ${BIOME[biome[wc]]} with humidity ${moisture[wc]}`);
    const cx = corner & 1 ? GRID - 1 : 0, cy = corner & 2 ? GRID - 1 : 0;
    const cc = cy * GRID + cx;
    if (moisture[cc] !== 0 || biome[cc] !== 4) fail.push(`${tag}: salt corner cell is ${BIOME[biome[cc]]} with humidity ${moisture[cc]}`);
    const expectCorner = ((water[1] < GRID / 2) << 1) | (water[0] < GRID / 2 ? 1 : 0);
    if (corner !== expectCorner) fail.push(`${tag}: salt corner ${corner} is not the corner farthest from the water (${expectCorner})`);
    if (lamp[0] >= GRID || lamp[1] >= GRID) fail.push(`${tag}: lamp outside the ceiling`);
  }

  // day/night and temperature are pure functions of the tick
  {
    const { sim, N, E, P } = h;
    sim.world_init(SEED, N, E, P, 0);
    const l0 = sim.light_now(), t0 = sim.temp_now();
    sim.step(4096);
    const l1 = sim.light_now(), t1 = sim.temp_now();
    sim.step(16384 - 4096);
    const l2 = sim.light_now();
    console.log(`\nlight: tick 0 ${l0}, tick 4096 ${l1}, tick 16384 ${l2}; temperature tick 0 ${t0} cC, tick 4096 ${t1} cC; lamp ${sim.lamp_on() ? "on" : "off"}`);
    if (l0 === l1) fail.push("ambient light does not change over a quarter day");
    if (l2 !== l0) fail.push("ambient light is not periodic over 16,384 ticks");
    sim.int_lights_off(10);
    if (sim.lamp_on() !== 0 || sim.light_now() !== 1) fail.push("int_lights_off did not darken the cage");
    sim.step(10);
    if (sim.lamp_on() !== 1) fail.push("the lamp did not come back after the lights-off interval");
  }

  // the volume holds: forty flies, six hundred ticks, never outside the cage
  {
    const { sim, view, N, E, P } = h;
    sim.world_init(SEED, N, E, P, 0);
    sim.set_capacity(40);
    sim.spawn_founders(40);
    let out = 0, surfaces = new Set(), flew = 0;
    for (let t = 0; t < WALK_TICKS; t += 20) {
      sim.step(20);
      const alive = view.alive(), x = view.x(), y = view.y(), z = view.z(), pose = view.pose();
      for (let w = 0; w < P; w++) {
        if (!alive[w]) continue;
        if (x[w] < 0 || x[w] >= GRID << 16 || y[w] < 0 || y[w] >= GRID << 16 || z[w] < 0 || z[w] > LAYERS << 16) out++;
        if (pose[w * 12] === 1) flew++; else surfaces.add(pose[w * 12 + 1]);
        if (pose[w * 12] === 0 && pose[w * 12 + 1] === 0 && (z[w] >> 16) !== view.height()[cellOf(x[w], y[w])]) out++;
      }
    }
    console.log(`\n${WALK_TICKS} ticks x 40 flies: ${out} samples outside the volume or off their surface; surfaces seen ${[...surfaces].sort().join(",")}; flying samples ${flew}`);
    if (out > 0) fail.push(`${out} samples outside the volume`);
  }

  if (fail.length) {
    console.error(`\nFAIL:\n  - ${fail.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`\nPASS: the cage has its dishes, water, salt corner, lamp and gradients on every seed, and the volume holds.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
