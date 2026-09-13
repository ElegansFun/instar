// Asserts that the three role maps (world host, site mirror, scripts) produce
// byte-identical role arrays for the canonical census, and that the counts per
// role match the numbers documented for the canonical file. A mismatch here
// means the world and its mirrors would compute different brains from the
// same genome, so this is a gate, not a report.
//
//   node scripts/roles-check.mjs

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS = path.join(ROOT, "data", "canonical", "droso-winding2023-larva.census.json");

const EXPECTED = {
  1: ["ORN", 42], 2: ["GUST_EXT", 131], 3: ["GUST_PHAR", 107], 4: ["MECH", 14], 5: ["NOCI", 12],
  6: ["THERMO_COLD", 6], 7: ["THERMO_WARM", 4], 8: ["VISUAL", 29], 9: ["PROPRIO", 8], 10: ["GUT", 85],
  11: ["RESP", 26], 23: ["DN_SEZ", 164], 24: ["RGN", 54],
};
const DN_VNC_TOTAL = 182; // DN_L + DN_R + DN_C

const census = JSON.parse(fs.readFileSync(CENSUS, "utf8"));
const sources = [
  ["services/world/roles.mts", "../services/world/roles.mts"],
  ["site/roles.js", "../site/roles.js"],
  ["scripts/roles.mjs", "./roles.mjs"],
];

const arrays = [];
for (const [label, spec] of sources) {
  const mod = await import(spec);
  if (typeof mod.rolesFor !== "function") throw new Error(`${label} does not export rolesFor(nodes)`);
  const roles = mod.rolesFor(census.nodes);
  if (!(roles instanceof Uint8Array) || roles.length !== census.nodes.length) {
    throw new Error(`${label}: rolesFor must return a Uint8Array of ${census.nodes.length}`);
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
    const n = census.nodes[first];
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
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(12)} ${String(got).padStart(4)} (expected ${want})`);
}
const dn = (counts.get(20) ?? 0) + (counts.get(21) ?? 0) + (counts.get(22) ?? 0);
console.log(`${dn === DN_VNC_TOTAL ? "ok  " : "FAIL"} DN-VNC       ${String(dn).padStart(4)} (expected ${DN_VNC_TOTAL}; L ${counts.get(20) ?? 0} R ${counts.get(21) ?? 0} C ${counts.get(22) ?? 0})`);
if (dn !== DN_VNC_TOTAL) failed = true;

if (failed) {
  console.error("roles-check FAILED");
  process.exit(1);
}
console.log("roles-check passed");
