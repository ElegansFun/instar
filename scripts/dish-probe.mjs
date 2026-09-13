// Is the dish the dish it is designed to be, on every seed?
//
// Eight seeds: every substrate class present, crust and pool at the same
// share on every seed (the moisture field is histogram-equalised, so a
// downstream constant is never a per-seed lottery), the dish is a disc of the
// stated radius with a one-cell rim and wall outside, and no larva ever
// stands in the wall over a run that pushes forty of them around.
//
//   node scripts/dish-probe.mjs

import { boot, cellOf, BIOME, GRID, SEED } from "./sim-host.mjs";

const SEEDS = [SEED, 1n, 2n, 12345n, 0xdeadbeefn, 99999999n, 777n, 31337n];
const WALK_TICKS = 3000;

async function worldFor(seed) {
  const h = await boot();
  h.sim.world_init(seed, h.N, h.E, 0);
  return h;
}

const pct = (n, d) => ((100 * n) / d).toFixed(1).padStart(6);

async function main() {
  const fail = [];
  console.log(`biome shares per seed (% of the dish)\n`);
  console.log(["seed".padEnd(12), ...BIOME.map((b) => b.padStart(7))].join(" "), "   dish  light  temp");
  const dryShares = [], poolShares = [];
  for (const seed of SEEDS) {
    const { sim, view } = await worldFor(seed);
    const b = view.biome();
    const count = new Array(8).fill(0);
    for (const v of b) count[v]++;
    const dish = b.length - count[0];
    const R = sim.dish_radius();
    // the disc: every cell inside radius R is not wall and every cell outside is
    let shapeErrors = 0, rimErrors = 0;
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const d2 = (x - 64) ** 2 + (y - 64) ** 2;
      const v = b[y * GRID + x];
      if ((d2 < R * R) !== (v !== 0)) shapeErrors++;
      if (d2 < R * R && d2 >= (R - 1) * (R - 1) && v !== 7) rimErrors++;
    }
    if (shapeErrors) fail.push(`seed ${seed}: ${shapeErrors} cells break the disc of radius ${R}`);
    if (rimErrors) fail.push(`seed ${seed}: ${rimErrors} cells of the outer ring are not RIM`);
    for (let k = 1; k < 8; k++) if (count[k] === 0) fail.push(`seed ${seed}: no ${BIOME[k]} cell`);
    dryShares.push((100 * count[4]) / dish);
    poolShares.push((100 * count[5]) / dish);
    console.log(
      [seed.toString(16).padEnd(12), ...count.map((c) => pct(c, dish).padStart(7))].join(" "),
      ` ${dish}`.padStart(7), `${sim.light_now()}`.padStart(6), `${sim.temp_now()}`.padStart(6),
    );
  }
  const spread = (a) => Math.max(...a) - Math.min(...a);
  console.log(`\ncrust share spread across seeds: ${spread(dryShares).toFixed(2)} points; pool share spread: ${spread(poolShares).toFixed(2)} points`);
  // features (yeast, fruit, lit) paint over crust as well as agar, and their
  // radius varies by seed, so the crust share moves by up to ~2 points
  if (spread(dryShares) > 2.5) fail.push(`crust share varies ${spread(dryShares).toFixed(2)} points across seeds`);
  if (spread(poolShares) > 1.5) fail.push(`pool share varies ${spread(poolShares).toFixed(2)} points across seeds`);

  // day/night and temperature are pure functions of the tick
  {
    const { sim } = await worldFor(SEED);
    const lights = [], temps = [];
    for (let i = 0; i < 16; i++) { sim.step(1024); lights.push(sim.light_now()); temps.push(sim.temp_now()); }
    console.log(`light over one day (every 1,024 ticks): ${lights.join(" ")}`);
    console.log(`temperature over 16,384 ticks (centi-C): ${temps[0]} .. ${temps[temps.length - 1]}`);
    if (Math.max(...lights) < 250 || Math.min(...lights) > 5) fail.push("day/night cycle does not span dark to bright");
  }

  // wall impassable: forty larvae, three thousand ticks, never a cell of wall
  {
    const { sim, view } = await worldFor(SEED);
    sim.set_capacity(40);
    sim.spawn_founders(40);
    let inWall = 0, maxR2 = 0;
    for (let t = 0; t < WALK_TICKS; t++) {
      sim.step(1);
      if (sim.pop_count() < 40) sim.spawn_founders(40 - sim.pop_count());
      const alive = view.alive(), xs = view.x(), ys = view.y(), b = view.biome();
      for (let w = 0; w < alive.length; w++) {
        if (!alive[w]) continue;
        if (b[cellOf(xs[w], ys[w])] === 0) inWall++;
        const dx = xs[w] / 65536 - 64, dy = ys[w] / 65536 - 64;
        maxR2 = Math.max(maxR2, dx * dx + dy * dy);
      }
    }
    console.log(`wall test: ${WALK_TICKS} ticks x 40 larvae, larva-ticks in wall ${inWall}, farthest radius ${Math.sqrt(maxR2).toFixed(2)} cells`);
    if (inWall) fail.push(`${inWall} larva-ticks inside the wall`);
    // the flood grows the pools and recedes
    const before = view.biome().filter((v) => v === 5).length;
    sim.int_flood();
    const during = view.biome().filter((v) => v === 5).length;
    sim.step(1300);
    const after = view.biome().filter((v) => v === 5).length;
    console.log(`flood: pool cells ${before} -> ${during} -> ${after} after 1,300 ticks`);
    if (!(during > before && after === before)) fail.push("flood did not expand and recede");
    const dryBefore = view.biome().filter((v) => v === 4).length;
    sim.int_dry_spell();
    const dryDuring = view.biome().filter((v) => v === 4).length;
    console.log(`dry spell: crust cells ${dryBefore} -> ${dryDuring}`);
    if (dryDuring <= dryBefore) fail.push("dry spell did not spread the crust");
  }

  if (fail.length) {
    console.error(`\nFAIL:\n${fail.map((f) => "  - " + f).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nPASS: the dish is a disc, every substrate exists, shares hold across seeds, and the wall holds.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
