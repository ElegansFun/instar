// Role table: census node -> engine role byte. One of three identical copies
// (services/world/roles.mts, site/roles.js); scripts/roles-check.mjs asserts
// all three agree byte for byte on the canonical node file.
//
// A role is derived only from the node record of male-cns-v1.0.nodes.json:
// `source_type` (the Janelia annotation `class`), `side` (somaSide, else
// rootSide) and `category`, a `key=value;key=value` string of the annotation
// columns superclass, type, subclass, nerve, receptor, neuromere (absent keys
// mean the annotation is null). The mapping is documented in docs/SCHEMA.md.
//
//   node scripts/roles.mjs        prints the per-role counts

import * as fs from "fs";

export const ROLE = Object.freeze({
  NONE: 0,
  ORN: 1,
  GRN_SWEET: 2,
  GRN_BITTER: 3,
  JON: 4,
  BRISTLE: 5,
  CHORDOTONAL: 6,
  THERMO_HOT: 7,
  THERMO_COLD: 8,
  HYGRO: 9,
  PR_R1_6: 10,      // left eye (or eye side unknown)
  PR_R7_8: 11,      // left eye (or eye side unknown)
  OCELLAR: 12,
  HALTERE: 13,
  TASTE_LEG: 14,
  INTERO: 15,
  PR_R1_6_R: 16,    // right eye
  PR_R7_8_R: 17,    // right eye
  MN_LEG_L1: 20,
  MN_LEG_L2: 21,
  MN_LEG_L3: 22,
  MN_LEG_R1: 23,
  MN_LEG_R2: 24,
  MN_LEG_R3: 25,
  MN_WING_POWER_L: 26,
  MN_WING_POWER_R: 27,
  MN_WING_STEER_L: 28,
  MN_WING_STEER_R: 29,
  MN_HALTERE_L: 30,
  MN_HALTERE_R: 31,
  MN_NECK: 32,
  MN_PROBOSCIS: 33,
  MN_ABDOMEN: 34,
  DN_L: 40,
  DN_R: 41,
  DN_C: 42,
  AN: 43,
  NEUROSECRETORY: 50,
});

export const ROLE_NAME = Object.freeze(Object.fromEntries(Object.entries(ROLE).map(([k, v]) => [v, k])));

export function parseCategory(category) {
  const out = {};
  if (typeof category !== "string") return out;
  for (const part of category.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const LEG_SUBCLASS = { fl: 0, ml: 1, hl: 2 }; // T1, T2, T3
const SWEET_TYPES = new Set(["LB3b", "LB3c", "dorsal_tpGRN", "claw_tpGRN"]);
const BITTER_TYPES = new Set(["LB1a", "LB1b", "LB1c", "LB1d"]);

function lr(side, left, right, other) {
  return side === "L" ? left : side === "R" ? right : other;
}

export function roleFor(node) {
  const cls = node.source_type;
  const side = node.side;
  const c = parseCategory(node.category);
  const sc = c.superclass ?? "";
  const type = c.type ?? "";
  const sub = c.subclass ?? "";

  // --- motor, command, endocrine (by superclass) ---
  if (sc === "vnc_motor" || sc === "cb_motor") {
    if (sub in LEG_SUBCLASS) {
      const leg = LEG_SUBCLASS[sub];
      return side === "L" ? ROLE.MN_LEG_L1 + leg : side === "R" ? ROLE.MN_LEG_R1 + leg : ROLE.NONE;
    }
    if (sub === "wm") {
      const power = type.startsWith("DLMn") || type.startsWith("DVMn");
      if (power) return lr(side, ROLE.MN_WING_POWER_L, ROLE.MN_WING_POWER_R, ROLE.NONE);
      return lr(side, ROLE.MN_WING_STEER_L, ROLE.MN_WING_STEER_R, ROLE.NONE);
    }
    if (sub === "hm") return lr(side, ROLE.MN_HALTERE_L, ROLE.MN_HALTERE_R, ROLE.NONE);
    if (sub === "nm") return ROLE.MN_NECK;
    if (sub === "pm") return ROLE.MN_PROBOSCIS;
    if (sub === "ad" || sub === "abdomen") return ROLE.MN_ABDOMEN;
    return ROLE.NONE;
  }
  if (sc === "vnc_efferent" && (sub === "ad" || sub === "abdomen")) return ROLE.MN_ABDOMEN;
  if (sc === "descending_neuron") return lr(side, ROLE.DN_L, ROLE.DN_R, ROLE.DN_C);
  if (sc === "ascending_neuron") return ROLE.AN;
  if (sc === "cb_endocrine" || sc === "vnc_endocrine") return ROLE.NEUROSECRETORY;
  if (sc === "ENS") return ROLE.INTERO;

  // --- sensory (by class, then type/subclass) ---
  if (!sc.includes("sensory")) return ROLE.NONE;
  if (sub === "haltere") return ROLE.HALTERE;
  switch (cls) {
    case "olfactory":
      return ROLE.ORN;
    case "visual":
      if (type === "R1-R6") return side === "R" ? ROLE.PR_R1_6_R : ROLE.PR_R1_6;
      if (type.startsWith("R7") || type.startsWith("R8")) return side === "R" ? ROLE.PR_R7_8_R : ROLE.PR_R7_8;
      if (type.startsWith("ocell")) return ROLE.OCELLAR;
      return ROLE.NONE;
    case "thermosensory":
      return type.startsWith("TRN_VP2") ? ROLE.THERMO_HOT : ROLE.THERMO_COLD;
    case "hygrosensory":
      return ROLE.HYGRO;
    case "gustatory":
      if (SWEET_TYPES.has(type)) return ROLE.GRN_SWEET;
      if (BITTER_TYPES.has(type)) return ROLE.GRN_BITTER;
      if (sub === "leg bristle") return ROLE.TASTE_LEG;
      return ROLE.NONE;
    case "chemosensory":
      return sub === "leg" ? ROLE.TASTE_LEG : ROLE.NONE;
    case "mechanosensory":
      if (type.startsWith("JO-") || sub === "auditory" || sub === "wind_gravity") return ROLE.JON;
      if (type.startsWith("BM")) return ROLE.BRISTLE;
      return ROLE.NONE;
    case "mechanosensory_tactile":
      return ROLE.BRISTLE;
    case "mechanosensory_proprioceptive":
      return ROLE.CHORDOTONAL;
    default:
      return ROLE.NONE;
  }
}

export function rolesFor(nodes) {
  const out = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) out[i] = roleFor(nodes[i]);
  return out;
}

export const NODES_PATH = new URL("../data/canonical/male-cns-v1.0.nodes.json", import.meta.url);

export function loadNodes() {
  return JSON.parse(fs.readFileSync(NODES_PATH, "utf8"));
}

export function roleCounts(roles) {
  const counts = new Map();
  for (const r of roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const doc = loadNodes();
  const roles = rolesFor(doc.nodes);
  for (const [role, n] of roleCounts(roles)) {
    console.log(`${String(role).padStart(3)}  ${(ROLE_NAME[role] ?? "?").padEnd(16)} ${String(n).padStart(7)}`);
  }
  console.log(`total ${roles.length} nodes, root ${doc.root_sha256}`);
}
