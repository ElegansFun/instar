// Role map: census node -> engine role byte.
//
// Every host that boots the engine must assign roles identically, or the
// world and its mirrors compute different brains from the same genome and the
// epoch hash proves nothing. The same function lives in site/roles.js and
// scripts/roles.mjs; scripts/roles-check.mjs asserts the three agree byte for
// byte on the canonical census.
//
// Roles come only from fields the census records verbatim: `source_type`
// (Winding 2023 S2 cell type), `category` (S2 modality annotation, carried
// for sensory and ascending neurons) and `side`. Body mechanosensation,
// proprioception and nociception reach the brain on ascending neurons from
// the VNC, so those three roles are assigned there; the head senses are on
// `sensory`. Anything whose annotation is not in this table stays 0.

export const ROLE = {
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
} as const;

export type CensusNode = {
  id: string;
  source_type: string | null;
  category: string | null;
  side: string | null;
};

/// Modality rules in precedence order. A category may be a "; "-separated
/// list ("A00c_a4; noci"); each token is tested, and the first rule in this
/// order that any token satisfies wins.
const SENSORY_RULES: [number, (t: string) => boolean][] = [
  [ROLE.ORN, t => t.startsWith("olfactory")],
  [ROLE.GUST_EXT, t => t.startsWith("gustatory-external")],
  [ROLE.GUST_PHAR, t => t.startsWith("gustatory-pharyngeal")],
  [ROLE.THERMO_COLD, t => t === "thermo-cold"],
  [ROLE.THERMO_WARM, t => t === "thermo-warm"],
  [ROLE.VISUAL, t => t.startsWith("visual")],
  [ROLE.GUT, t => t.startsWith("gut")],
  [ROLE.RESP, t => t.startsWith("respiratory")],
];
const ASCENDING_RULES: [number, (t: string) => boolean][] = [
  [ROLE.MECH, t => t.startsWith("mechano")],
  [ROLE.NOCI, t => t.startsWith("noci")],
  [ROLE.PROPRIO, t => t.startsWith("proprio")],
];

function firstRole(category: string | null, rules: [number, (t: string) => boolean][]): number {
  const tokens = (category ?? "").split("; ").map(t => t.trim()).filter(Boolean);
  for (const [role, test] of rules) if (tokens.some(test)) return role;
  return ROLE.NONE;
}

export function roleFor(node: CensusNode): number {
  const st = node.source_type;
  if (st === "sensory") return firstRole(node.category, SENSORY_RULES);
  if (st === "ascending") return firstRole(node.category, ASCENDING_RULES);
  if (st === "DN-VNC") {
    if (node.side === "L") return ROLE.DN_L;
    if (node.side === "R") return ROLE.DN_R;
    return ROLE.DN_C;
  }
  if (st === "DN-SEZ") return ROLE.DN_SEZ;
  if (st === "RGN") return ROLE.RGN;
  return ROLE.NONE;
}

export function rolesFor(nodes: CensusNode[]): Uint8Array {
  const out = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) out[i] = roleFor(nodes[i]);
  return out;
}
