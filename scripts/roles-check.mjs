// Asserts that the three role maps (world host, site mirror, scripts) produce
// byte-identical role arrays for the canonical node file, and that the counts
// per role match the numbers documented for it. A mismatch here means the
// world and its mirrors would compute different brains from the same genome,
// so this is a gate, not a report.
//
//   node scripts/roles-check.mjs

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODES = path.join(ROOT, "data", "canonical", "male-cns-v1.0.nodes.json");

/// Per-role counts on male-cns-v1.0.nodes.json (docs/SCHEMA.md, role table).
const EXPECTED = {
  1: ["ORN", 2639], 2: ["GRN_SWEET", 94], 3: ["GRN_BITTER", 38], 4: ["JON", 672], 5: ["BRISTLE", 3490],
  6: ["CHORDOTONAL", 1253], 7: ["THERMO_HOT", 7], 8: ["THERMO_COLD", 18], 9: ["HYGRO", 66],
  10: ["PR_R1_6", 1112], 11: ["PR_R7_8", 1233], 12: ["OCELLAR", 0], 13: ["HALTERE", 205], 14: ["TASTE_LEG", 788],
  15: ["INTERO", 50], 16: ["PR_R1_6_R", 2265], 17: ["PR_R7_8_R", 1481],
  20: ["MN_LEG_L1", 68], 21: ["MN_LEG_L2", 58], 22: ["MN_LEG_L3", 66], 23: ["MN_LEG_R1", 67], 24: ["MN_LEG_R2", 58], 25: ["MN_LEG_R3", 64],
  26: ["MN_WING_POWER_L", 12], 27: ["MN_WING_POWER_R", 12], 28: ["MN_WING_STEER_L", 21], 29: ["MN_WING_STEER_R", 22],
  30: ["MN_HALTERE_L", 8], 31: ["MN_HALTERE_R", 8], 32: ["MN_NECK", 44], 33: ["MN_PROBOSCIS", 67], 34: ["MN_ABDOMEN", 220],
  40: ["DN_L", 656], 41: ["DN_R", 648], 42: ["DN_C", 10], 43: ["AN", 1846], 50: ["NEUROSECRETORY", 94],
};
const NODE_COUNT = 166_700;

const doc = JSON.parse(fs.readFileSync(NODES, "utf8"));
const nodes = doc.nodes;
if (nodes.length !== NODE_COUNT) { console.error(`nodes.json has ${nodes.length} nodes, expected ${NODE_COUNT}`); process.exit(1); }
const sources = [
  ["services/world/roles.mts", "../services/world/roles.mts"],
  ["site/roles.js", "../site/roles.js"],
  ["scripts/roles.mjs", "./roles.mjs"],
];

const arrays = [];
for (const [label, spec] of sources) {
  const mod = await import(spec);
  if (typeof mod.rolesFor !== "function") throw new Error(`${label} does not export rolesFor(nodes)`);
  const roles = mod.rolesFor(nodes);
  if (!(roles instanceof Uint8Array) || roles.length !== nodes.length) {
    throw new Error(`${label}: rolesFor must return a Uint8Array of ${nodes.length}`);
  }
  arrays.push([label, roles]);
}

let failed = false;
const [refLabel, ref] = arrays[0];
for (const [label, roles] of arrays.slice(1)) {
  let diffs = 0, first = -1;
  for (let i = 0; i < ref.length; i++) if (ref[i] !== roles[i]) { if (first < 0) first = i; diffs++; }
  if (diffs) {
    failed = true;
    const n = nodes[first];
    console.error(`MISMATCH ${refLabel} vs ${label}: ${diffs} node(s) differ; first at #${first} ${n.id} ` +
      `(${n.source_type}/${n.category}/${n.side}) -> ${ref[first]} vs ${roles[first]}`);
  } else {
    console.log(`identical: ${refLabel} == ${label} (${ref.length} nodes)`);
  }
}

const counts = new Map();
for (const r of ref) counts.set(r, (counts.get(r) ?? 0) + 1);
for (const [role, [name, want]] of Object.entries(EXPECTED)) {
  const got = counts.get(Number(role)) ?? 0;
  const ok = got === want;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${String(role).padStart(2)} ${name.padEnd(16)} ${String(got).padStart(6)} (expected ${want})`);
}
const assigned = ref.length - (counts.get(0) ?? 0);
console.log(`${assigned} of ${ref.length} neurons carry a role; ${counts.get(0) ?? 0} are role 0`);

if (failed) {
  console.error("roles-check FAILED");
  process.exit(1);
}
console.log("roles-check passed");
