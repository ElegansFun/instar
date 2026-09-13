// The engine's acceptance gates, in sequence, on Windows node against the
// WASM that scripts/wsl-build-sim.sh produced and the canonical MaleCNS
// data. Exits non-zero on the first failing gate. Every number these print
// is measured at a stated horizon:
//   sim-probe     MN firings per fly-tick (legs, wings, proboscis), feeding
//                 and takeoffs real vs zeroed, zeroed line extinct
//   forage-probe  real line persists 12k ticks, leg MN output while walking,
//                 time on dishes
//   cage-probe    the arena on eight seeds, the volume holds
//   sim-bench     ms/tick and ms/fly-tick at 40 flies, memory
// When every gate passes, the `MEASURE` lines the probes print are written
// to site/measurements.json: the landing page shows exactly those numbers,
// each with its horizon, and nothing when the file has not been produced.
//
//   node scripts/sim-gates.mjs

import { spawnSync } from "child_process";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { WASM_PATH, CBG_PATH, TICKRATE } from "./sim-host.mjs";

const GATES = [
  ["sim-probe.mjs", "8000"],
  ["forage-probe.mjs", "12000"],
  ["cage-probe.mjs"],
  ["sim-bench.mjs", "400"],
];
const MEASUREMENTS_PATH = new URL("../site/measurements.json", import.meta.url);

for (const p of [WASM_PATH, CBG_PATH]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${fileURLToPath(p)}: ${p === WASM_PATH ? "run scripts/wsl-build-sim.sh first" : "run the MaleCNS converter first"}`);
    process.exit(1);
  }
}

const items = [];
for (const [script, ...args] of GATES) {
  console.log(`\n==== ${script} ${args.join(" ")} ====`);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 26 });
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith("MEASURE ")) items.push(...JSON.parse(line.slice(8)));
    else if (line.length) console.log(line);
  }
  if (r.status !== 0) {
    console.error(`\nGATE FAILED: ${script} exited ${r.status}`);
    process.exit(r.status || 1);
  }
}

const wasm = fs.statSync(WASM_PATH);
fs.writeFileSync(MEASUREMENTS_PATH, JSON.stringify({
  measured_at: new Date().toISOString(),
  wasm_bytes: wasm.size,
  items,
  note: `Measured by scripts/sim-gates.mjs on ${new Date().toISOString().slice(0, 10)} against the checked-in engine (site/instar_sim.wasm, ${wasm.size.toLocaleString()} bytes) and the canonical MaleCNS census, genesis genome, seed INSTA. Fly-hours are at the world's ${TICKRATE} ticks per second. "Zeroed" is the same world with every synaptic weight set to zero: what the body does on its own.`,
}, null, 2) + "\n");
console.log(`\nwrote ${fileURLToPath(MEASUREMENTS_PATH)} (${items.length} measurements)`);
console.log(`\nSIM_GATES_OK`);
