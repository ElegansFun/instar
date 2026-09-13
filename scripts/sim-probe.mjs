// Does the connectome actually drive the body?
//
// The Rust tests prove determinism on a stub graph. This loads the real
// 2,952-neuron census exactly the way the world does and measures, over one
// stated horizon, whether the descending neurons fire, whether the larvae go
// somewhere different from larvae with every synapse zeroed, and whether
// feeding (which is SEZ output and nothing else) happens at all.
//
//   node scripts/sim-probe.mjs [ticks]

import { boot, SEED, u64 } from "./sim-host.mjs";
import { ROLE } from "./roles.mjs";

const TICKS = Number(process.argv[2] ?? 20000);
const START_POP = 8;
// Trajectories are compared at this tick, while the zeroed population is
// still alive: it starves out long before any useful horizon ends.
const SNAPSHOT_TICK = Math.min(1000, TICKS);

async function run(zeroGenome) {
  const { sim, view, N, E, P, MAXN, roles } = await boot();
  sim.world_init(SEED, N, E, START_POP);
  const zero = () => view.genome().fill(0);
  if (zeroGenome) zero();

  const byRole = new Map();
  roles.forEach((r, i) => {
    if (r === 0) return;
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r).push(i);
  });
  const dnRoles = [ROLE.DN_L, ROLE.DN_R, ROLE.DN_C];
  const dnNodes = dnRoles.flatMap((r) => byRole.get(r) ?? []);
  const sezNodes = byRole.get(ROLE.DN_SEZ) ?? [];
  const rgnNodes = byRole.get(ROLE.RGN) ?? [];
  const sensoryNodes = [...byRole.entries()].filter(([r]) => r < 20).flatMap(([, v]) => v);

  let larvaTicks = 0, anyFirings = 0, dnFirings = 0, sezFirings = 0, rgnFirings = 0, sensFirings = 0;
  let feedingTicks = 0;
  let extinctAt = null;
  let snapshot = null;
  for (let t = 1; t <= TICKS; t++) {
    sim.step(1);
    // re-zero every tick so larvae born mid-run inherit nothing either
    if (zeroGenome) zero();
    const fired = view.fired();
    const alive = view.alive();
    // the engine's own record of what was swallowed this tick: grazing only,
    // never a contest bite, which also raises `eaten`
    const ateLast = view.ateLast();
    let pop = 0;
    for (let w = 0; w < P; w++) {
      if (!alive[w]) continue;
      pop++;
      larvaTicks++;
      const base = w * MAXN;
      for (let i = 0; i < N; i++) if (fired[base + i]) anyFirings++;
      for (const i of dnNodes) if (fired[base + i]) dnFirings++;
      for (const i of sezNodes) if (fired[base + i]) sezFirings++;
      for (const i of rgnNodes) if (fired[base + i]) rgnFirings++;
      for (const i of sensoryNodes) if (fired[base + i]) sensFirings++;
      if (ateLast[w] > 0) feedingTicks++;
    }
    if (pop === 0 && extinctAt === null) extinctAt = t;
    if (t === SNAPSHOT_TICK) {
      snapshot = { x: Array.from(view.x()), y: Array.from(view.y()), h: Array.from(view.heading()), alive: Array.from(view.alive()) };
    }
  }
  return {
    pop: sim.pop_count(), births: sim.births_total(), deaths: sim.deaths_total(), maxGen: sim.max_generation(),
    larvaTicks, anyFirings, dnFirings, sezFirings, rgnFirings, sensFirings, feedingTicks, extinctAt,
    dnCount: dnNodes.length, sezCount: sezNodes.length, rgnCount: rgnNodes.length,
    snapshot,
    hash: u64(sim.state_hash()),
  };
}

async function main() {
  const { N, E } = await boot();
  console.log(`connectome: ${N} nodes, ${E} chemical synapses; ${START_POP} founders; horizon ${TICKS.toLocaleString()} ticks`);

  console.log(`\n--- run A: the real connectome ---`);
  const A = await run(false);
  const per = (v) => (v / A.larvaTicks).toFixed(3);
  console.log(`larva-ticks        : ${A.larvaTicks.toLocaleString()}`);
  console.log(`any node firings   : ${A.anyFirings.toLocaleString()}  (${per(A.anyFirings)} per larva-tick)`);
  console.log(`sensory firings    : ${A.sensFirings.toLocaleString()}  (${per(A.sensFirings)} per larva-tick)`);
  console.log(`DN-VNC firings     : ${A.dnFirings.toLocaleString()}  (${per(A.dnFirings)} per larva-tick, of ${A.dnCount} DN nodes)`);
  console.log(`DN-SEZ firings     : ${A.sezFirings.toLocaleString()}  (${per(A.sezFirings)} per larva-tick, of ${A.sezCount})`);
  console.log(`RGN firings        : ${A.rgnFirings.toLocaleString()}  (${per(A.rgnFirings)} per larva-tick, of ${A.rgnCount})`);
  console.log(`feeding ticks      : ${A.feedingTicks.toLocaleString()}  (${(100 * A.feedingTicks / A.larvaTicks).toFixed(2)}% of larva-ticks)`);
  console.log(`pop/births/deaths  : ${A.pop}/${A.births}/${A.deaths}  max generation ${A.maxGen}`);
  console.log(`state hash         : ${A.hash.toString(16)}`);

  console.log(`\n--- run B: identical world, every synaptic weight zeroed ---`);
  const B = await run(true);
  console.log(`larva-ticks        : ${B.larvaTicks.toLocaleString()}`);
  console.log(`any node firings   : ${B.anyFirings.toLocaleString()}  (sensory-only: ${B.sensFirings.toLocaleString()})`);
  console.log(`DN-VNC firings     : ${B.dnFirings.toLocaleString()}`);
  console.log(`DN-SEZ firings     : ${B.sezFirings.toLocaleString()}`);
  console.log(`feeding ticks      : ${B.feedingTicks.toLocaleString()}`);
  console.log(`pop/births/deaths  : ${B.pop}/${B.births}/${B.deaths}`);
  const extinct = B.pop === 0;
  console.log(`extinct within horizon: ${extinct ? `yes, at tick ${B.extinctAt.toLocaleString()}` : "no"}`);

  // Compare TRAJECTORIES, not the state hash: the hash mixes the genome in
  // directly, so a zeroed genome always changes it whether or not the network
  // ever influenced a single movement. Compared at SNAPSHOT_TICK, where both
  // populations are still alive; at the horizon the zeroed dish is empty and
  // there would be nothing to compare.
  let compared = 0, identical = 0;
  for (let w = 0; w < A.snapshot.alive.length; w++) {
    if (!A.snapshot.alive[w] || !B.snapshot.alive[w]) continue;
    compared++;
    if (A.snapshot.x[w] === B.snapshot.x[w] && A.snapshot.y[w] === B.snapshot.y[w] && A.snapshot.h[w] === B.snapshot.h[w]) identical++;
  }

  console.log(`\nVERDICT over ${TICKS.toLocaleString()} ticks`);
  console.log(`  DN firings per larva-tick, real            : ${per(A.dnFirings)}`);
  console.log(`  feeding ticks, real vs zeroed              : ${(100 * A.feedingTicks / A.larvaTicks).toFixed(2)}% vs ${B.larvaTicks ? (100 * B.feedingTicks / B.larvaTicks).toFixed(2) : "0.00"}%`);
  console.log(`  slots alive in both at tick ${SNAPSHOT_TICK.toLocaleString()} / position-identical : ${compared} / ${identical}`);
  console.log(`  zeroed population extinct within horizon   : ${extinct ? `yes, tick ${B.extinctAt.toLocaleString()}` : "no"}`);

  const fail = [];
  if (A.dnFirings === 0) fail.push("the descending neurons never fire: the connectome does not reach the body");
  if (compared === 0) fail.push(`no slot alive in both runs at tick ${SNAPSHOT_TICK.toLocaleString()}: the trajectory comparison never happened`);
  else if (identical === compared) fail.push("zeroing every synapse changed no trajectory: the nervous system steers nothing");
  if (A.feedingTicks === 0) fail.push("no larva ever fed: DN-SEZ output never reached the pharynx");
  if (B.feedingTicks !== 0) fail.push("a larva with silent DN-SEZ ate: feeding is not SEZ-gated");
  if (A.dnFirings / A.larvaTicks > A.dnCount * 0.6) fail.push("descending neurons are saturated: near-constant firing is not behaviour either");
  if (fail.length) {
    console.error(`\nFAIL:\n${fail.map((f) => "  - " + f).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nPASS: the nervous system is in the loop.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
