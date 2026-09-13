// Role table: census node -> engine role byte. One of three identical copies
// (scripts/roles.mjs, services/world/roles.mts); scripts/roles-check.mjs
// asserts all three agree byte for byte on the canonical node file. The
// browser uses it in the verification worker, which hands the engine the
// same role array the world process does, or its hashes disagree.
//
// A role is derived only from the node record of male-cns-v1.0.nodes.json:
// `source_type` (the Janelia annotation `class`), `side` (somaSide, else
// rootSide) and `category`, a `key=value;key=value` string of the annotation
// columns superclass, type, subclass, nerve, receptor, neuromere (absent keys
// mean the annotation is null). The mapping is documented in docs/SCHEMA.md.

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

// what the page calls each role
export const ROLE_LABEL = Object.freeze({
  0: "unassigned", 1: "olfactory receptor", 2: "gustatory, sweet", 3: "gustatory, bitter", 4: "Johnston's organ",
  5: "bristle", 6: "chordotonal / campaniform", 7: "thermosensory, hot", 8: "thermosensory, cold", 9: "hygrosensory",
  10: "photoreceptor R1-6, left", 11: "photoreceptor R7/8, left", 12: "ocellar", 13: "haltere sensory", 14: "leg taste", 15: "interoceptive",
  16: "photoreceptor R1-6, right", 17: "photoreceptor R7/8, right",
  20: "leg MN L1", 21: "leg MN L2", 22: "leg MN L3", 23: "leg MN R1", 24: "leg MN R2", 25: "leg MN R3",
  26: "wing power MN, left", 27: "wing power MN, right", 28: "wing steering MN, left", 29: "wing steering MN, right",
  30: "haltere MN, left", 31: "haltere MN, right", 32: "neck MN", 33: "proboscis MN", 34: "abdominal MN",
  40: "descending, left", 41: "descending, right", 42: "descending, unpaired", 43: "ascending", 50: "neurosecretory",
});

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
