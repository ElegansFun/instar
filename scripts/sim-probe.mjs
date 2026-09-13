// Does the connectome actually drive the body?
//
// The Rust tests prove determinism on synthetic graphs. This loads the real
// 166,700-neuron MaleCNS exactly the way the world does and measures, over
// one stated horizon, whether the motor neurons fire (legs, wings,
// proboscis), whether the flies go somewhere different from flies with every
// synapse zeroed, whether feeding (proboscis motor output and nothing else)
// and flight (wing-power motor output and nothing else) happen at all, and
// whether a zeroed line dies out.
//
//   node scripts/sim-probe.mjs [ticks]

import { boot, SEED, u64, GROUP, EVENT, TICKRATE, measure } from "./sim-host.mjs";

const TICKS = Number(process.argv[2] ?? 8000);
const START_POP = 8;
// Trajectories are compared at this tick, while the zeroed population is
// still alive: it starves out long before any useful horizon ends.
const SNAPSHOT_TICK = Math.min(1000, TICKS);

async function run(zeroGenome) {
  const { sim, view, N, E, P, GROUPS, RING } = await boot();
  sim.world_init(SEED, N, E, P, START_POP);
  if (zeroGenome) view.genome().fill(0);
  const gi = Object.fromEntries(GROUP.map((g, i) => [g, i]));

  const sums = Object.fromEntries(GROUP.map((g) => [g, 0]));
  let flyTicks = 0, feedingTicks = 0, flyingTicks = 0, extinctAt = null, snapshot = null, takeoffs = 0;
  let evSeen = 0;
  for (let t = 1; t <= TICKS; t++) {
    sim.step(1);
    const alive = view.alive(), fc = view.firedCount(), ate = view.ateLast(), pose = view.pose();
    for (let w = 0; w < P; w++) {
      if (!alive[w]) continue;
      flyTicks++;
      for (const g of GROUP) sums[g] += fc[w * GROUPS + gi[g]];
      if (ate[w] > 0) feedingTicks++;
      if (pose[w * 12] === 1) flyingTicks++;
    }
    const head = sim.event_head();
    if (head - evSeen > RING) throw new Error("event ring overflowed between reads");
    const ev = view.events();
    for (let k = evSeen; k < head; k++) if (ev[(k % RING) * 4 + 1] === EVENT.indexOf("takeoff")) takeoffs++;
    evSeen = head;
    if (t === SNAPSHOT_TICK) snapshot = { alive: Array.from(alive), x: Array.from(view.x()), y: Array.from(view.y()), z: Array.from(view.z()) };
    if (extinctAt === null && sim.pop_count() === 0) extinctAt = t;
  }
  return {
    flyTicks, sums, feedingTicks, flyingTicks, takeoffs, extinctAt, snapshot,
    pop: sim.pop_count(), births: sim.births_total(), deaths: sim.deaths_total(), maxGen: sim.max_generation(),
    hash: u64(sim.state_hash()),
  };
}

async function main() {
  const { N, E } = await boot();
  console.log(`connectome: ${N.toLocaleString()} neurons, ${E.toLocaleString()} connections of >= 5 synapses; ${START_POP} founders; horizon ${TICKS.toLocaleString()} ticks`);

  console.log(`\n--- run A: the real connectome ---`);
  const A = await run(false);
  const per = (v) => (v / A.flyTicks).toFixed(3);
  const flyHours = A.flyTicks / (TICKRATE * 3600);
  console.log(`fly-ticks          : ${A.flyTicks.toLocaleString()}`);
  for (const g of GROUP) console.log(`${g.padEnd(8)} firings   : ${A.sums[g].toLocaleString().padStart(12)}  (${per(A.sums[g])} per fly-tick)`);
  console.log(`feeding ticks      : ${A.feedingTicks.toLocaleString()}  (${(100 * A.feedingTicks / A.flyTicks).toFixed(2)}% of fly-ticks)`);
  console.log(`flying ticks       : ${A.flyingTicks.toLocaleString()}  (${(100 * A.flyingTicks / A.flyTicks).toFixed(2)}% of fly-ticks); takeoffs ${A.takeoffs} = ${(A.takeoffs / flyHours).toFixed(1)} per fly-hour at ${TICKRATE} ticks/s`);
  console.log(`pop/births/deaths  : ${A.pop}/${A.births}/${A.deaths}  max generation ${A.maxGen}`);
  console.log(`state hash         : ${A.hash.toString(16)}`);

  console.log(`\n--- run B: identical world, every synaptic weight zeroed ---`);
  const B = await run(true);
  console.log(`fly-ticks          : ${B.flyTicks.toLocaleString()}`);
  console.log(`any node firings   : ${B.sums.any.toLocaleString()}  (sensory-only: ${B.sums.sens.toLocaleString()})`);
  console.log(`leg/wing/prob MN   : ${B.sums.legL + B.sums.legR}/${B.sums.wingP + B.sums.wingS}/${B.sums.prob}`);
  console.log(`feeding ticks      : ${B.feedingTicks.toLocaleString()}; flying ticks ${B.flyingTicks}; takeoffs ${B.takeoffs}`);
  console.log(`pop/births/deaths  : ${B.pop}/${B.births}/${B.deaths}`);
  const extinct = B.pop === 0;
  console.log(`extinct within horizon: ${extinct ? `yes, at tick ${B.extinctAt.toLocaleString()}` : "no"}`);

  // Compare TRAJECTORIES, not the state hash: the hash mixes the genome
  // digest in directly, so a zeroed genome always changes it whether or not
  // the network ever influenced a single movement.
  let compared = 0, identical = 0;
  for (let w = 0; w < A.snapshot.alive.length; w++) {
    if (!A.snapshot.alive[w] || !B.snapshot.alive[w]) continue;
    compared++;
    if (A.snapshot.x[w] === B.snapshot.x[w] && A.snapshot.y[w] === B.snapshot.y[w] && A.snapshot.z[w] === B.snapshot.z[w]) identical++;
  }

  const legs = A.sums.legL + A.sums.legR, wings = A.sums.wingP + A.sums.wingS;
  console.log(`\nVERDICT over ${TICKS.toLocaleString()} ticks`);
  console.log(`  MN firings per fly-tick, real: legs ${per(legs)}  wings ${per(wings)}  proboscis ${per(A.sums.prob)}`);
  console.log(`  feeding ticks, real vs zeroed              : ${(100 * A.feedingTicks / A.flyTicks).toFixed(2)}% vs ${B.flyTicks ? (100 * B.feedingTicks / B.flyTicks).toFixed(2) : "0.00"}%`);
  console.log(`  takeoffs per fly-hour, real vs zeroed      : ${(A.takeoffs / flyHours).toFixed(1)} vs ${B.takeoffs}`);
  console.log(`  slots alive in both at tick ${SNAPSHOT_TICK.toLocaleString()} / position-identical : ${compared} / ${identical}`);
  console.log(`  zeroed population extinct within horizon   : ${extinct ? `yes, tick ${B.extinctAt.toLocaleString()}` : "no"}`);

  const fail = [];
  if (legs === 0) fail.push("the leg motor neurons never fire: the connectome does not reach the legs");
  if (wings === 0) fail.push("the wing motor neurons never fire: the connectome does not reach the wings");
  if (compared === 0) fail.push(`no slot alive in both runs at tick ${SNAPSHOT_TICK.toLocaleString()}: the trajectory comparison never happened`);
  else if (identical === compared) fail.push("zeroing every synapse changed no trajectory: the nervous system steers nothing");
  if (A.feedingTicks === 0) fail.push("no fly ever fed: proboscis motor output never reached the pump");
  if (B.feedingTicks !== 0) fail.push("a fly with a silent proboscis ate: feeding is not motor-gated");
  if (B.flyingTicks !== 0 || B.takeoffs !== 0) fail.push("a fly with silent wing-power motor neurons flew: flight is not motor-gated");
  if (!extinct) fail.push("the zeroed line survived the horizon");
  if (A.sums.dn / A.flyTicks > 1314 * 0.6) fail.push("descending neurons are saturated: near-constant firing is not behaviour either");
  if (fail.length) {
    console.error(`\nFAIL:\n  - ${fail.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`\nPASS: the nervous system is in the loop.`);
  const horizon = `${TICKS.toLocaleString()} ticks, ${START_POP} founders, seed INSTA`;
  const pctB = B.flyTicks ? (100 * B.feedingTicks / B.flyTicks).toFixed(2) : "0.00";
  measure([
    { label: "leg motor-neuron spikes per fly-tick", value: per(legs), horizon },
    { label: "wing motor-neuron spikes per fly-tick", value: per(wings), horizon },
    { label: "proboscis motor-neuron spikes per fly-tick", value: per(A.sums.prob), horizon },
    { label: "fly-ticks feeding, real connectome vs every synapse zeroed", value: `${(100 * A.feedingTicks / A.flyTicks).toFixed(2)} vs ${pctB}`, unit: "%", horizon },
    { label: `takeoffs per fly-hour at ${TICKRATE} ticks/s, real vs zeroed`, value: `${(A.takeoffs / flyHours).toFixed(1)} vs ${B.takeoffs}`, horizon },
    { label: "zeroed-synapse line extinct at tick", value: B.extinctAt.toLocaleString(), horizon },
  ]);
}

main().catch((e) => { console.error(e); process.exit(1); });
