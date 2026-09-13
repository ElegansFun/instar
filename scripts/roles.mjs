// Role table: census node -> engine role byte. One of three identical copies
// (services/world/roles.mts, site/roles.js); scripts/roles-check.mjs asserts
// all three agree byte for byte on the canonical file.
//
// A role is derived from three node fields: `source_type`, `category` (the
// Winding S2 modality annotation, carried on sensory and ascending neurons)
// and `side`. `category` may be a "; "-separated list; every token is tested
// against the rules in order and the first matching role wins.

import * as fs from "fs";

export const ROLE = Object.freeze({
  NONE: 0,
  ORN: 1,
  GUST_EXT: 2,
  GUST_PHAR: 3,
  MECH: 4,
  NOCI: 5,
  THERMO_COLD: 6,
  THERMO_WARM: 7,
  VISUAL: 8,
  PROPRIO: 9,
  GUT: 10,
  RESP: 11,
  DN_L: 20,
  DN_R: 21,
  DN_C: 22,
  DN_SEZ: 23,
  RGN: 24,
});

export const ROLE_NAME = Object.freeze(Object.fromEntries(Object.entries(ROLE).map(([k, v]) => [v, k])));

// [source_type, role, matcher] in precedence order
const SENSORY_RULES = [
  ["sensory", ROLE.ORN, (t) => t.startsWith("olfactory")],
  ["sensory", ROLE.GUST_EXT, (t) => t.startsWith("gustatory-external")],
  ["sensory", ROLE.GUST_PHAR, (t) => t.startsWith("gustatory-pharyngeal")],
  ["ascending", ROLE.MECH, (t) => t.startsWith("mechano")],
  ["ascending", ROLE.NOCI, (t) => t.startsWith("noci")],
  ["sensory", ROLE.THERMO_COLD, (t) => t === "thermo-cold"],
  ["sensory", ROLE.THERMO_WARM, (t) => t === "thermo-warm"],
  ["sensory", ROLE.VISUAL, (t) => t.startsWith("visual")],
  ["ascending", ROLE.PROPRIO, (t) => t.startsWith("proprio")],
  ["sensory", ROLE.GUT, (t) => t.startsWith("gut")],
  ["sensory", ROLE.RESP, (t) => t.startsWith("respiratory")],
];

export function roleFor(node) {
  const st = node.source_type;
  if (st === "DN-VNC") return node.side === "L" ? ROLE.DN_L : node.side === "R" ? ROLE.DN_R : ROLE.DN_C;
  if (st === "DN-SEZ") return ROLE.DN_SEZ;
  if (st === "RGN") return ROLE.RGN;
  if ((st !== "sensory" && st !== "ascending") || typeof node.category !== "string") return ROLE.NONE;
  const tokens = node.category.split(";").map((t) => t.trim()).filter((t) => t.length > 0);
  for (const [type, role, match] of SENSORY_RULES) {
    if (type !== st) continue;
    for (const t of tokens) if (match(t)) return role;
  }
  return ROLE.NONE;
}

export function rolesFor(nodes) {
  const out = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) out[i] = roleFor(nodes[i]);
  return out;
}

export const CENSUS_PATH = new URL("../data/canonical/droso-winding2023-larva.census.json", import.meta.url);

export function loadCensus() {
  return JSON.parse(fs.readFileSync(CENSUS_PATH, "utf8"));
}
