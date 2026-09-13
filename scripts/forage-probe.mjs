// Does the nervous system STEER, or does it only move?
//
// sim-probe proves the connectome reaches the motor neurons. That is a lower
// bar than it sounds: a fly can be driven entirely by its own network and
// still wander at random. This measures the thing that matters: whether a
// fly running the real connectome spends more of its life on the food
// dishes than the same fly with every synapse zeroed, at one stated horizon,
// and whether the real line persists where the zeroed line starves.
//
// A zeroed fly cannot feed at all (feeding is proboscis motor output), so
// time-on-dish is compared, not energy: it is the only measure both
// populations can score.
//
//   node scripts/forage-probe.mjs [ticks]

import { boot, cellOf, SEED, GRID, GROUP, measure } from "./sim-host.mjs";

const TICKS = Number(process.argv[2] ?? 12000);
const START_POP = 8;

/// The walking gate: a walking fly moves by BASE_THRUST every tick whatever
/// its brain does, so "did it move" cannot fail. What the zeroed control
/// cannot score is leg motor output: the share of walking fly-ticks on which
/// at least one leg motor neuron fired. Measured 88.6% at genesis on the
/// MaleCNS (12,000 ticks, 8 founders, seed INSTA); the gate is the claim
/// "on most walking ticks the legs are driven through the wiring".
const LEG_DRIVEN_MIN_PCT = 50;

async function run(zeroGenome) {
  const { sim, view, N, E, P, GROUPS } = await boot();
  sim.world_init(SEED, N, E, P, START_POP);
  if (zeroGenome) view.genome().fill(0);
  const LEG_L = GROUP.indexOf("legL"), LEG_R = GROUP.indexOf("legR");

  let flyTicks = 0, onDish = 0, onFood = 0, inWater = 0, onSalt = 0, walking = 0, legDriven = 0, flying = 0, onFloor = 0;
  for (let t = 0; t < TICKS; t++) {
    sim.step(1);
    const alive = view.alive(), x = view.x(), y = view.y(), biome = view.biome(), food = view.food(), pose = view.pose(), fc = view.firedCount();
    for (let w = 0; w < P; w++) {
      if (!alive[w]) continue;
      flyTicks++;
      const c = cellOf(x[w], y[w]), b = biome[c];
      const floor = pose[w * 12] === 0 && pose[w * 12 + 1] === 0;
      if (floor) onFloor++;
      if (pose[w * 12] === 1) flying++;
      if (floor && (b === 1 || b === 2)) onDish++;
      if (floor && food[c] > 0) onFood++;
      if (floor && b === 3) inWater++;
      if (floor && b === 4) onSalt++;
      if (pose[w * 12] === 0) {
        walking++;
        if (fc[w * GROUPS + LEG_L] + fc[w * GROUPS + LEG_R] > 0) legDriven++;
      }
    }
  }
  const pct = (n) => (100 * n) / Math.max(1, flyTicks);
  return {
    pop: sim.pop_count(), births: sim.births_total(), deaths: sim.deaths_total(), kills: sim.kills_total(), maxGen: sim.max_generation(),
    flyTicks, onDishPct: pct(onDish), onFoodPct: pct(onFood), inWaterPct: pct(inWater), onSaltPct: pct(onSalt), flyingPct: pct(flying), onFloorPct: pct(onFloor),
    legDrivenPct: (100 * legDriven) / Math.max(1, walking),
  };
}

const pad = (s, n) => String(s).padStart(n);

async function main() {
  console.log(`${TICKS.toLocaleString()} ticks, seed INSTA, ${START_POP} founders\n`);
  const real = await run(false);
  const dead = await run(true);

  console.log(`                              real     zeroed      ratio`);
  const row = (name, a, b, dp = 2) => {
    const ratio = b > 0 ? (a / b).toFixed(2) : a > 0 ? "inf" : "-";
    console.log(`${name.padEnd(28)}${pad(a.toFixed(dp), 10)}${pad(b.toFixed(dp), 10)}${pad(ratio, 10)}`);
  };
  row("population at horizon", real.pop, dead.pop, 0);
  row("births", real.births, dead.births, 0);
  row("deaths", real.deaths, dead.deaths, 0);
  row("kills", real.kills, dead.kills, 0);
  row("max generation", real.maxGen, dead.maxGen, 0);
  row("fly-ticks", real.flyTicks, dead.flyTicks, 0);
  row("% of ticks on the floor", real.onFloorPct, dead.onFloorPct);
  row("% of ticks flying", real.flyingPct, dead.flyingPct);
  row("% of ticks on a dish", real.onDishPct, dead.onDishPct);
  row("% of ticks on food", real.onFoodPct, dead.onFoodPct);
  row("% of ticks in water", real.inWaterPct, dead.inWaterPct);
  row("% of ticks on salt", real.onSaltPct, dead.onSaltPct);
  row("% of walking ticks with leg MN output", real.legDrivenPct, dead.legDrivenPct);

  // "Time on a dish" is time on a yeast or banana cell: the substrate is
  // fixed, so a control that never eats can score it. "% of ticks on food"
  // is context only: real flies graze the floor medium down and zeroed
  // flies never do, so it measures eating, not steering.
  const lift = dead.onDishPct > 0 ? real.onDishPct / dead.onDishPct : Infinity;
  const dishShare = dishPct(await boot());
  console.log(`\nover ${TICKS.toLocaleString()} ticks:  time-on-dish real ${real.onDishPct.toFixed(2)}%  zeroed ${dead.onDishPct.toFixed(2)}%  lift ${lift === Infinity ? "inf (zeroed never reached a dish)" : lift.toFixed(2) + "x"}`);
  console.log(`dish share of the floor: ${dishShare.toFixed(2)}% (a uniform random floor position scores this)`);
  console.log(`zeroed-genome population extinct within horizon: ${dead.pop === 0 ? "yes" : "no"}`);

  // Gates are the claims the engine can back at generation zero: without
  // the connectome nothing feeds and the line dies; with it the line
  // persists and its legs are driven by motor neurons, not by the body's
  // baseline shuffle. Time on dishes is reported, not asserted: whether
  // generation zero steers better than chance is what selection is supposed
  // to find.
  const fail = [];
  if (dead.pop !== 0) fail.push("a population with zeroed synapses survived the horizon: feeding is not gated by the connectome");
  if (real.pop === 0) fail.push("the real-connectome population went extinct within the horizon");
  if (dead.legDrivenPct !== 0) fail.push("leg motor neurons fired with every synapse zeroed: the legs are not driven through the wiring");
  if (real.legDrivenPct < LEG_DRIVEN_MIN_PCT) fail.push(`leg motor neurons fired on only ${real.legDrivenPct.toFixed(1)}% of walking ticks (gate ${LEG_DRIVEN_MIN_PCT}%)`);
  if (fail.length) {
    console.error(`\nFAIL:\n  - ${fail.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`\nPASS: the connectome is the difference between a line that persists and one that starves.`);
  const horizon = `${TICKS.toLocaleString()} ticks, ${START_POP} founders, seed INSTA`;
  measure([
    { label: "population at the horizon, real connectome vs every synapse zeroed", value: `${real.pop} vs ${dead.pop}`, unit: "flies", horizon },
    { label: "walking fly-ticks with leg motor-neuron output, real vs zeroed", value: `${real.legDrivenPct.toFixed(1)} vs ${dead.legDrivenPct.toFixed(1)}`, unit: "%", horizon },
    { label: "fly-ticks on a food dish, real vs zeroed (dishes are this share of the floor)", value: `${real.onDishPct.toFixed(2)} vs ${dead.onDishPct.toFixed(2)} (${dishShare.toFixed(2)})`, unit: "%", horizon },
  ]);
}

function dishPct({ sim, view, N, E, P }) {
  sim.world_init(SEED, N, E, P, 0);
  const biome = view.biome();
  let dish = 0;
  for (let c = 0; c < GRID * GRID; c++) if (biome[c] === 1 || biome[c] === 2) dish++;
  return (100 * dish) / (GRID * GRID);
}

main().catch((e) => { console.error(e); process.exit(1); });
