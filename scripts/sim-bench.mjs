// How much of a core does the world cost at capacity?
//
// The world process runs 20 ticks/s. The requirement is that a full dish
// (population 40) uses under 40% of one core in WASM under Node, which is
// 20 ms per tick of budget. Propagation is event-driven (CSR over the nodes
// that fired), so the cost is spikes, not synapses.
//
//   node scripts/sim-bench.mjs [ticks]

import { boot, SEED, u64 } from "./sim-host.mjs";

const TICKS = Number(process.argv[2] ?? 2000);
const POP = 40;
const TICKRATE = 20;
const BUDGET_MS = (1000 / TICKRATE) * 0.4;

async function main() {
  const { sim, N, E } = await boot();
  sim.world_init(SEED, N, E, 0);
  sim.set_capacity(POP);
  sim.spawn_founders(POP);
  // warm-up: the JIT and the first-tick sensory transients
  sim.step(200);
  const pops = [];
  const t0 = process.hrtime.bigint();
  for (let t = 0; t < TICKS; t += 100) {
    // keep the dish full so the figure is a pop-40 figure, not a survivor count
    const pop = sim.pop_count();
    if (pop < POP) sim.spawn_founders(POP - pop);
    sim.step(100);
    pops.push(sim.pop_count());
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const perTick = ms / TICKS;
  const meanPop = pops.reduce((a, b) => a + b, 0) / pops.length;
  const t1 = process.hrtime.bigint();
  const h = u64(sim.state_hash());
  const hashMs = Number(process.hrtime.bigint() - t1) / 1e6;

  console.log(`connectome ${N} nodes / ${E} synapses, ${TICKS.toLocaleString()} ticks after 200 warm-up`);
  console.log(`population: started ${POP}, mean ${meanPop.toFixed(1)}, min ${Math.min(...pops)}, at end ${pops[pops.length - 1]}`);
  console.log(`ms/tick at pop ${POP}: ${perTick.toFixed(3)}  (${(100 * perTick / (1000 / TICKRATE)).toFixed(1)}% of one core at ${TICKRATE} ticks/s)`);
  console.log(`ms/larva-tick: ${(perTick / Math.max(1, meanPop)).toFixed(4)}`);
  console.log(`state_hash: ${hashMs.toFixed(2)} ms (${h.toString(16)})`);
  if (meanPop < POP * 0.9) {
    console.error(`FAIL: the population averaged ${meanPop.toFixed(1)} during the bench; the number above is not a pop-${POP} figure`);
    process.exit(1);
  }
  if (perTick > BUDGET_MS) {
    console.error(`FAIL: ${perTick.toFixed(2)} ms/tick exceeds the ${BUDGET_MS.toFixed(0)} ms budget (40% of a core at ${TICKRATE} ticks/s)`);
    process.exit(1);
  }
  console.log(`PASS: within budget.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
