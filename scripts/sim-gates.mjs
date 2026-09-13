// The engine's acceptance gates, in sequence, on Windows node against the
// WASM that scripts/wsl-build-sim.sh produced. Exits non-zero on the first
// failing gate. Every number these print is measured at a stated horizon.
//
//   node scripts/sim-gates.mjs

import { spawnSync } from "child_process";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { WASM_PATH } from "./sim-host.mjs";

const GATES = [
  ["sim-probe.mjs", "8000"],
  ["forage-probe.mjs", "12000"],
  ["dish-probe.mjs"],
  ["sim-bench.mjs", "2000"],
];

if (!fs.existsSync(WASM_PATH)) {
  console.error(`missing ${fileURLToPath(WASM_PATH)}: run scripts/wsl-build-sim.sh first`);
  process.exit(1);
}

for (const [script, ...args] of GATES) {
  console.log(`\n==== ${script} ${args.join(" ")} ====`);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nGATE FAILED: ${script} exited ${r.status}`);
    process.exit(r.status || 1);
  }
}
console.log(`\nSIM_GATES_OK`);
