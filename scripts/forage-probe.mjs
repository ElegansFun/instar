// Does the nervous system STEER, or does it only move?
//
// sim-probe proves the connectome reaches the descending neurons. That is a
// lower bar than it sounds: a larva can be driven entirely by its own network
// and still wander at random. This measures the thing that matters: whether
// a larva running the real connectome spends more of its life on food than
// the same larva with every synapse zeroed, at one stated horizon.
//
// A zeroed larva cannot feed at all (feeding is SEZ output), so time-on-food
// is compared, not energy: it is the only measure both populations can score.
//
//   node scripts/forage-probe.mjs [ticks]

import { boot, cellOf, SEED } from "./sim-host.mjs";

const TICKS = Number(process.argv[2] ?? 12000);
const START_POP = 8;

async function run(zeroGenome) {
  const { sim, view, N, E, P } = await boot();
  sim.world_init(SEED, N, E, START_POP);
  const zero = () => view.genome().fill(0);
  if (zeroGenome) zero();

  let larvaTicks = 0, onFood = 0, onRich = 0, inPool = 0, onDry = 0, moved = 0;
  let px = Array.from(view.x()), py = Array.from(view.y());
  const alive0 = Array.from(view.alive());
  for (let t = 0; t < TICKS; t++) {
    sim.step(1);
    if (zeroGenome) zero();
    const alive = view.alive(), xs = view.x(), ys = view.y(), food = view.food(), biome = view.biome();
    for (let w = 0; w < P; w++) {
      if (!alive[w]) { alive0[w] = 0; continue; }
      larvaTicks++;
      const c = cellOf(xs[w], ys[w]);
      if (food[c] > 0) onFood++;
      if (biome[c] === 2 || biome[c] === 3) onRich++;
      if (biome[c] === 5) inPool++;
      if (biome[c] === 4) onDry++;
      if (alive0[w] && (xs[w] !== px[w] || ys[w] !== py[w])) moved++;
      px[w] = xs[w]; py[w] = ys[w]; alive0[w] = 1;
    }
  }
  const pct = (n) => (100 * n) / Math.max(1, larvaTicks);
  return {
    pop: sim.pop_count(), births: sim.births_total(), deaths: sim.deaths_total(), kills: sim.kills_total(),
    maxGen: sim.max_generation(), larvaTicks,
    onFoodPct: pct(onFood), onRichPct: pct(onRich), inPoolPct: pct(inPool), onDryPct: pct(onDry), movedPct: pct(moved),
  };
}

const pad = (s, n) => String(s).padStart(n);

async function main() {
  console.log(`${TICKS.toLocaleString()} ticks, seed INSTA, ${START_POP} founders\n`);
  const real = await run(false);
  const dead = await run(true);

  console.log(`                              real     zeroed      ratio`);
  const row = (name, a, b, dp = 2) => {
    const r = b === 0 ? "-" : (a / b).toFixed(2) + "x";
    console.log(`  ${name.padEnd(26)} ${pad(a.toFixed(dp), 8)} ${pad(b.toFixed(dp), 10)} ${pad(r, 10)}`);
  };
  row("population at horizon", real.pop, dead.pop, 0);
  row("births", real.births, dead.births, 0);
  row("deaths", real.deaths, dead.deaths, 0);
  row("kills", real.kills, dead.kills, 0);
  row("max generation", real.maxGen, dead.maxGen, 0);
  row("larva-ticks", real.larvaTicks, dead.larvaTicks, 0);
  row("% of ticks on food", real.onFoodPct, dead.onFoodPct);
  row("% of ticks on yeast/fruit", real.onRichPct, dead.onRichPct);
  row("% of ticks in a pool", real.inPoolPct, dead.inPoolPct);
  row("% of ticks on crust", real.onDryPct, dead.onDryPct);
  row("% of ticks moving", real.movedPct, dead.movedPct);

  // "Time on food" is time on a yeast or fruit cell: the substrate is fixed,
  // so a control that never eats can score it. "% of ticks on a cell with
  // food > 0" is printed for context only: real larvae graze cells to zero
  // and zeroed larvae never do, so it measures eating, not steering.
  const lift = dead.onRichPct > 0 ? real.onRichPct / dead.onRichPct : Infinity;
  const patchShare = patchPct(await boot());
  // State the horizon with the ratio: these move with run length, so a figure
  // quoted without one cannot be reproduced.
  console.log(`\nover ${TICKS.toLocaleString()} ticks:  time-on-food (yeast/fruit) real ${real.onRichPct.toFixed(2)}%  zeroed ${dead.onRichPct.toFixed(2)}%  lift ${lift === Infinity ? "inf (zeroed never reached a patch)" : lift.toFixed(2) + "x"}`);
  console.log(`yeast/fruit share of the dish: ${patchShare.toFixed(2)}% (a uniform random position scores this)`);
  console.log(`zeroed-genome population extinct within horizon: ${dead.pop === 0 ? "yes" : "no"}`);

  // Gates are the claims the engine can back at generation zero: without the
  // connectome nothing feeds and the line dies; with it the line persists
  // and keeps moving. Time on patches is reported, not asserted, for either
  // population: the zeroed control crawls at base thrust and starves within
  // ~1,500 ticks, so its patch-time is the patch-time of its birthplace
  // (measured across seeds 1-6: 0.00% four times, 0.28% and 0.68% once
  // each, 5.66% on seed INSTA where the founders land beside a colony), and
  // whether generation zero steers better than chance is what selection is
  // supposed to find.
  const fail = [];
  if (dead.pop !== 0) fail.push("a population with zeroed synapses survived the horizon: feeding is not gated by the connectome");
  if (real.pop === 0) fail.push("the real-connectome population went extinct within the horizon");
  if (real.movedPct < 90) fail.push("real larvae are not moving most of the time");
  if (fail.length) {
    console.error(`\nFAIL:\n${fail.map((f) => "  - " + f).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nPASS: the connectome is the difference between a line that persists and one that starves.`);
}

function patchPct({ sim, view, N, E }) {
  sim.world_init(SEED, N, E, 0);
  const b = view.biome();
  let dish = 0, patch = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0) continue;
    dish++;
    if (b[i] === 2 || b[i] === 3) patch++;
  }
  return (100 * patch) / dish;
}

main().catch((e) => { console.error(e); process.exit(1); });
