// How much of a core does the cage cost at capacity?
//
// The world process runs 10 ticks/s and caps its carrying capacity by the
// engine budget: floor(80 ms / measured ms-per-fly-tick), 8..40. This prints
// the two numbers that formula needs, measured at population 40 on this
// host, and the memory the engine uses. Propagation is event-driven (CSR over
// the nodes that fired) and so is the update (touched list), so the cost is
// spikes and touched nodes, not synapses or neurons.
//
//   node scripts/sim-bench.mjs [ticks] [wasm-path]

import * as fs from "fs";
import * as os from "os";
import { boot, SEED, u64, TICKRATE, measure } from "./sim-host.mjs";

const TICKS = Number(process.argv[2] ?? 400);
const POP = 40;
const BUDGET_MS = 80;
const TARGET_MS = 50;

async function main() {
  const { sim, N, E, P } = await boot(POP, process.argv[3] ? fs.readFileSync(process.argv[3]) : undefined);
  sim.world_init(SEED, N, E, P, 0);
  sim.set_capacity(POP);
  sim.spawn_founders(POP);
  // warm-up: the JIT and the first-tick sensory transients
  sim.step(50);
  const pops = [];
  let flyTicks = 0, ns = 0n;
  for (let t = 0; t < TICKS; t += 50) {
    // keep the cage full so the figure is a pop-40 figure, not a survivor
    // count; the refill (a genome write + digest per founder) is host work
    // between epochs, not a tick, so it stays outside the clock
    const pop = sim.pop_count();
    if (pop < POP) sim.spawn_founders(POP - pop);
    for (let k = 0; k < 50; k++) {
      // the flies stepped by this tick are the ones alive as it starts
      flyTicks += sim.pop_count();
      const t0 = process.hrtime.bigint();
      sim.step(1);
      ns += process.hrtime.bigint() - t0;
    }
    pops.push(sim.pop_count());
  }
  const ms = Number(ns) / 1e6;
  const perTick = ms / TICKS;
  const perFlyTick = ms / flyTicks;
  const meanPop = pops.reduce((a, b) => a + b, 0) / pops.length;
  const t1 = process.hrtime.bigint();
  const h = u64(sim.state_hash());
  const hashMs = Number(process.hrtime.bigint() - t1) / 1e6;
  const memMB = sim.memory.buffer.byteLength / 1e6;

  console.log(`connectome ${N.toLocaleString()} neurons / ${E.toLocaleString()} connections, ${TICKS.toLocaleString()} ticks after 50 warm-up`);
  console.log(`population: started ${POP}, mean ${meanPop.toFixed(1)}, min ${Math.min(...pops)}, at end ${pops[pops.length - 1]}`);
  console.log(`ms/tick at pop ${POP}: ${perTick.toFixed(1)}  (${(100 * perTick / (1000 / TICKRATE)).toFixed(0)}% of one core at ${TICKRATE} ticks/s; contract target ${TARGET_MS} ms)`);
  console.log(`ms/fly-tick: ${perFlyTick.toFixed(3)}  -> engine budget floor(${BUDGET_MS} / ms-per-fly-tick) = ${Math.min(40, Math.max(8, Math.floor(BUDGET_MS / perFlyTick)))} flies`);
  console.log(`state_hash: ${hashMs.toFixed(2)} ms (${h.toString(16)})`);
  console.log(`memory: engine slabs ${(Number(sim.heap_bytes()) / 1e6).toFixed(0)} MB, wasm linear memory ${memMB.toFixed(0)} MB`);
  if (meanPop < POP * 0.9) {
    console.error(`FAIL: the population averaged ${meanPop.toFixed(1)} during the bench; the number above is not a pop-${POP} figure`);
    process.exit(1);
  }
  if (perTick > TARGET_MS) console.log(`NOTE: ${perTick.toFixed(1)} ms/tick is above the ${TARGET_MS} ms target at pop ${POP}; the world caps capacity by the engine budget above.`);
  console.log(`PASS: measured.`);
  const horizon = `${TICKS} ticks at ${POP} flies, wasm on Node, ${os.cpus()[0]?.model.replace(/\s+/g, " ").trim() ?? "unknown CPU"}`;
  const budget = Math.min(40, Math.max(8, Math.floor(BUDGET_MS / perFlyTick)));
  measure([
    { label: `engine time per tick at ${POP} flies (the world runs ${TICKRATE} ticks/s)`, value: perTick.toFixed(1), unit: "ms", horizon },
    { label: "engine time per fly-tick; the world caps its population at floor(80 ms / this)", value: `${perFlyTick.toFixed(2)} (${budget} flies)`, unit: "ms", horizon },
    { label: "engine memory at 40 flies (genomes, wiring, per-fly neural state)", value: memMB.toFixed(0), unit: "MB", horizon },
  ]);
}

main().catch((e) => { console.error(e); process.exit(1); });
