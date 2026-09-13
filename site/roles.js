// Host-side role assignment for the Instar engine. One u8 per census node,
// derived only from `source_type`, `category` (annotation string) and `side`.
//
// This function exists three times on purpose (site/roles.js,
// services/world/roles.mts, scripts/roles.mjs): the browser mirror, the world
// process and the probe scripts must all hand the engine the same role array
// or their hashes disagree. scripts/roles-check.mjs asserts the three outputs
// are byte-identical for the canonical census.
//
// Body mechanosensation, proprioception and nociception reach the brain over
// ascending neurons from the ventral nerve cord, which is why those three roles
// are read from `ascending` nodes while the head senses are `sensory` nodes.

export const ROLE = Object.freeze({
  NONE: 0,
  ORN: 1, GUST_EXT: 2, GUST_PHAR: 3, MECH: 4, NOCI: 5,
  THERMO_COLD: 6, THERMO_WARM: 7, VISUAL: 8, PROPRIO: 9, GUT: 10, RESP: 11,
  DN_L: 20, DN_R: 21, DN_C: 22, DN_SEZ: 23, RGN: 24,
});

export const ROLE_NAME = Object.freeze({
  0: "none",
  1: "olfactory (ORN)", 2: "gustatory, external", 3: "gustatory, pharyngeal",
  4: "mechanosensory (ascending)", 5: "nociceptive (ascending)", 6: "thermosensory, cold", 7: "thermosensory, warm",
  8: "visual", 9: "proprioceptive (ascending)", 10: "gut", 11: "respiratory",
  20: "descending to VNC, left", 21: "descending to VNC, right", 22: "descending to VNC, unpaired",
  23: "descending to SEZ (feeding)", 24: "ring gland (ecdysone)",
});

// [role, source_type, matcher] tested in this order; the first hit wins.
const CATEGORY_RULES = [
  [1, "sensory", (t) => t.startsWith("olfactory")],
  [2, "sensory", (t) => t.startsWith("gustatory-external")],
  [3, "sensory", (t) => t.startsWith("gustatory-pharyngeal")],
  [4, "ascending", (t) => t.startsWith("mechano")],
  [5, "ascending", (t) => t.startsWith("noci")],
  [6, "sensory", (t) => t === "thermo-cold"],
  [7, "sensory", (t) => t === "thermo-warm"],
  [8, "sensory", (t) => t.startsWith("visual")],
  [9, "ascending", (t) => t.startsWith("proprio")],
  [10, "sensory", (t) => t.startsWith("gut")],
  [11, "sensory", (t) => t.startsWith("respiratory")],
];

export function roleOf(node) {
  const st = node.source_type;
  if (st === "sensory" || st === "ascending") {
    const c = node.category;
    if (typeof c !== "string") return 0;
    const tokens = c.split("; ").map(t => t.trim());
    for (const [role, type, match] of CATEGORY_RULES) {
      if (type !== st) continue;
      for (const t of tokens) if (match(t)) return role;
    }
    return 0;
  }
  if (st === "DN-VNC") {
    if (node.side === "L") return 20;
    if (node.side === "R") return 21;
    return 22;
  }
  if (st === "DN-SEZ") return 23;
  if (st === "RGN") return 24;
  return 0;
}

export function rolesFor(nodes) {
  const out = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) out[i] = roleOf(nodes[i]);
  return out;
}
