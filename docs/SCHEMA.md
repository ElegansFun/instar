# Census Canonical Connectome Format (CCF) v0.2.0

One deterministic, hash-stable representation of the connectome that drives every fly in Instar. The converter in `tools/census` maps the Janelia FlyEM MaleCNS v1.0 flat export into this format; the Merkle root of the canonical form is what the world and the site check against. This document is the normative spec: the Python reference (`tools/census/canonical.py`) and any other implementation that reads the files (the world process, the site, the role mapping scripts) must agree with it byte for byte.

Canonical files, all in `data/canonical/`:

| File | Size | Content |
|------|------|---------|
| `male-cns-v1.0.census.json` | 3 KB | header: format, dataset, provenance, counts, Merkle root, names of the other two files |
| `male-cns-v1.0.nodes.json` | 19,447,724 B | the 166,700 node records, in canonical node order |
| `male-cns-v1.0.census.cbg` | 82,411,320 B | CBG0: node table (id, kind) + edge table (6,242,118 edges as node indices) |

v0.1 stored the whole census as one JSON document. At 6.2 M edges that document would be ~500 MB, so v0.2 splits it: the hashed records are the same shape, but the edges live only in the binary CBG0 and the node records only in `nodes.json`. The `.cbg` is committed to git (Git LFS is optional: `git lfs track "data/canonical/*.cbg"` if a fork wants it out of the object store).

## Design rules

1. **Real data only.** Every record traces to a published source file listed in `provenance` with its sha256 and size. The converter never invents a neuron, an edge, or a weight.
2. **Deterministic.** The same input bytes produce byte-identical hashed payloads regardless of when or where conversion runs. Every ordering is specified. No timestamps inside the hashed payload.
3. **Explicit unknowns.** A fact the source does not state is `null`, never omitted, never guessed.
4. **Integers only.** Weights are synapse counts. No floating point anywhere; the canonicalizer rejects floats.

## What the files do and do not contain

The MaleCNS v1.0 is the complete central nervous system of one adult male *Drosophila melanogaster*: central brain, both optic lobes and the ventral nerve cord, reconstructed from electron microscopy (Berg et al. 2025/2026, Janelia FlyEM, CC BY 4.0). The census holds **every body that Janelia annotated with a `superclass`** (166,700 bodies; the preprint's headline figure is 166,691 neurons, Codex reports 166,700) and **every connection of five or more synapses between two of them** (6,242,118 edges; the export reports 25,582,938 body pairs with at least one synapse between census bodies, so the ≥ 5 cut keeps 24.4 % of the pairs). Synapses are those the export lists at confidence ≥ 0.5. Honesty rule for every string derived from this: "every neuron of the MaleCNS connectome, and every connection of five or more synapses"; never "the whole wiring".

All nodes are `kind: "neuron"` and all edges `kind: "chemical"`; the export does not distinguish gap junctions and the census carries no neurotransmitter or polarity field. The other `kind` values exist so the format can describe other datasets without a format change.

## Header: `<dataset_id>.census.json`

UTF-8 JSON, pretty-printed for humans (hashing uses the canonical serialization below, so on-disk whitespace is irrelevant). JSON Schema: `schema/census.schema.json`.

| Key | Hashed | Content |
|-----|--------|---------|
| `census_format` | yes | `"0.2.0"` |
| `dataset` | yes | identity, citation, licence block |
| `provenance` | yes | source files with sha256 + size, converter version, conversion notes |
| `files` | no | `{"graph": "<id>.census.cbg", "nodes": "<id>.nodes.json"}`, relative to the header |
| `node_count`, `edge_count` | no | must equal the record counts in the other two files |
| `merkle` | no | the root and tree parameters (cannot hash itself) |

### `dataset`

```json
{
  "id": "male-cns-v1.0",
  "species": "Drosophila melanogaster",
  "common_name": "fruit fly",
  "variant": "adult male, whole central nervous system (brain, optic lobes, ventral nerve cord)",
  "dataset_name": "Janelia FlyEM Male CNS connectome (MaleCNS) v1.0",
  "dataset_version": "v1.0 flat connectome export, synapse confidence >= 0.5",
  "modality": "electron microscopy reconstruction",
  "citation": "Berg, S., Beckett, I.R., Costa, M., Schlegel, P., ... Jefferis, G.S.X.E. (2025). Sexual dimorphism in the complete connectome of the Drosophila male central nervous system. bioRxiv. https://doi.org/10.1101/2025.10.09.680999 (Cell 2026, https://www.cell.com/cell/fulltext/S0092-8674(26)00942-6). Janelia FlyEM.",
  "license": "CC BY 4.0 (Janelia FlyEM: \"The Male CNS dataset is licensed under CC-BY\")",
  "source_urls": ["https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/connectome-weights-male-cns-v1.0-minconf-0.5.feather", "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/body-annotations-male-cns-v1.0-minconf-0.5.feather", "https://male-cns.janelia.org/"]
}
```

`id` is a slug matching `^[a-z0-9]+([-.][a-z0-9]+)*$`.

### `provenance`

```json
{
  "converter": "census-converter/0.2.0",
  "converted_from": [
    {"filename": "connectome-weights-male-cns-v1.0-minconf-0.5.feather", "sha256": "e35da783d1c686b2b58b3b87cd6a403ae43bfcfba8bff28e08ef752c1a56afc1", "size": 1051241946, "url": "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/connectome-weights-male-cns-v1.0-minconf-0.5.feather", "role": "segment-to-segment connection weights (body_pre, body_post, weight)"},
    {"filename": "body-annotations-male-cns-v1.0-minconf-0.5.feather", "sha256": "2177e246113e4cfbf1e7772ec37c6da1955ff22e8063d0b1f833101f99a9a3b2", "size": 14483314, "url": "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/body-annotations-male-cns-v1.0-minconf-0.5.feather", "role": "body annotations (class, superclass, type, subclass, nerves, receptor, sides)"}
  ],
  "notes": ["...conversion decisions, verbatim in the shipped header..."]
}
```

The two feathers are the objects the public bucket lists under `v1.0/connectome-data/flat-connectome/` (`https://storage.googleapis.com/flyem-male-cns?prefix=v1.0/connectome-data/`, anonymous). No dates here (rule 2).

## Node records: `<dataset_id>.nodes.json`

```json
{"census_format":"0.2.0","dataset_id":"male-cns-v1.0","root_sha256":"a7999c12...","node_count":166700,"nodes":[
{"id":"100000","kind":"neuron","source_type":null,"side":"L","category":"superclass=ol_intrinsic;type=L5"},
{"id":"101326","kind":"neuron","source_type":"visual","side":"R","category":"superclass=ol_sensory;type=R1-R6"},
...
]}
```

One node per line. `nodes[i]` is node index `i` everywhere: in the CBG0 node table, in the CBG0 edge table, in the engine's CSR, in the role array. `root_sha256` repeats the header root so a consumer holding only this file can check it belongs to the graph it loaded.

| Field | Values |
|-------|--------|
| `id` | Janelia bodyId as a decimal string; ASCII; unique |
| `kind` | `neuron` \| `muscle` \| `glia` \| `epithelial` \| `gland` \| `end_organ` \| `other` (this census: always `neuron`) |
| `source_type` | the annotation `class` verbatim (`olfactory`, `visual`, `gustatory`, `mechanosensory`, `mechanosensory_tactile`, `mechanosensory_proprioceptive`, `thermosensory`, `hygrosensory`, `chemosensory`, `unknown_sensory`, `Kenyon_Cell`, `CX`, `ALPN`, `DAN`, `MBON`, ...); `null` for the 140,187 bodies Janelia gives no class (most intrinsic neurons) |
| `side` | `L` \| `R` \| `M` \| `null`: the annotation `somaSide`, or `rootSide` when `somaSide` is null (sensory afferents have no soma in the volume; `rootSide` is the side their axon enters). `rootSide = unknown` becomes `null` |
| `category` | `key=value` pairs joined by `;`, in this fixed order, null columns skipped: `superclass` (Janelia `superclass`, always present), `type` (`type`), `subclass` (`subclass`: the muscle group for motor neurons, the sensillum class for sensory neurons), `nerve` (`entryNerve` when present, else `exitNerve`; no body has both), `receptor` (`receptorType`), `neuromere` (`somaNeuromere`). Values are used verbatim; the converter refuses any value containing `;`, `=`, `"` or `\` so the string parses unambiguously |

`category` and `source_type` are hashed fields. Changing how they are populated changes the root; the root recorded below is for the population rule stated here.

## Edge records (hashed form)

```json
{"pre": "10203", "post": "100000", "kind": "chemical", "weight": 12}
```

| Field | Values |
|-------|--------|
| `pre`, `post` | node ids (must exist in `nodes`) |
| `kind` | `chemical` \| `gap_junction` (this census: always `chemical`) |
| `weight` | positive integer synapse count exactly as the weights export reports it (confidence ≥ 0.5); only rows with `weight >= 5` and both bodies in the node set become edges |

Rules:

- Self-loops are kept if the source reports them (33 in this census).
- Gap junctions, when a dataset has them, are undirected and stored once per unordered pair with `pre <= post` bytewise. The split layout (CBG0 + nodes.json) supports chemical edges only; the in-memory validator still enforces the gap-junction rule for small datasets.

The edge records are never written as JSON: they are hashed from the CBG0 edge table (indices resolved to ids through the node table) and that is the only place they exist on disk.

### Ordering (normative)

- `nodes` sorted by `id`, bytewise ascending (so `"100000"` precedes `"10203"`).
- `edges` sorted by (`kind`, `pre`, `post`), bytewise ascending. With one kind and node indices assigned in node order this is exactly ascending (`pre_index`, `post_index`), which is the order the CBG0 edge table is in.

**Genome mapping.** A fly's genome is the vector of edge weights in exactly this order: `genome[i]` is the weight for edge `i` of the CBG0, and the engine's CSR (`out_start[pre]..out_start[pre+1]` listing `out_post`) enumerates edges in the same order because edges are grouped by `pre_index` ascending and by `post_index` within a `pre`. Every place that refers to a weight index (engine, host, site, probe scripts, the verifier) means this ordering. This is what makes "descended from the real connectome" checkable rather than a claim: an edge's ancestral weight is the number at the same position in the CBG0.

## Canonical serialization (for hashing)

RFC 8785-style JSON subset:

- UTF-8 bytes; object keys sorted bytewise; separators `,` and `:` with no whitespace.
- Strings minimally escaped: only `"`, `\`, and control characters U+0000 to U+001F are escaped; every other character appears as literal UTF-8.
- Integers in base 10, no leading zeros, `-` for negatives. Floats are rejected.
- `null`, `true`, `false` as literals.

Python reference: `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")` after float rejection. Because node ids are printable ASCII without `"` or `\` (enforced), an edge leaf is the fixed byte string `{"t":"edge","v":{"kind":"chemical","post":"<post id>","pre":"<pre id>","weight":<n>}}`; `canonical.edge_leaf` formats it directly and the unit tests pin it to the generic serializer.

## Merkle construction (normative)

RFC 6962 (Certificate Transparency) tree over SHA-256:

- `leaf_hash = SHA256(0x00 || leaf_bytes)`
- `interior = SHA256(0x01 || left || right)`
- For n > 1 leaves, split at k = the largest power of two strictly less than n; root = interior(MTH(first k), MTH(rest)).

Leaves, in order:

1. one **meta** leaf: `canon({"t":"meta","v":{"census_format":...,"dataset":{...},"provenance":{...}}})` from the header
2. one leaf per node, in node order: `canon({"t":"node","v":{...node record...}})` from `nodes.json`
3. one leaf per edge, in CBG0 order: `canon({"t":"edge","v":{...edge record...}})` with `pre`/`post` resolved to ids

The reference computes this streaming (`canonical.MerkleAccumulator`): leaves are pushed in order, complete power-of-two subtrees are folded eagerly, and the remaining subtrees are folded right-to-left at the end, which is the RFC 6962 split; memory is O(log n) and the unit tests check it against the recursive definition for every n < 40.

The `merkle` block records the parameters and the root:

```json
{"algorithm": "rfc6962-sha256", "leaf_order": "meta,nodes,edges", "leaf_count": 6408819, "root_sha256": "a7999c12b33dd7a5681541b7b9025c165b236b40cb76117885d5663e839b196e"}
```

Domain separation (the 0x00 / 0x01 prefixes) prevents second-preimage attacks; per-record leaves give O(log n) inclusion proofs, so a single neuron or synapse can be proven against the root.

Shipped files, as measured by `python -m tools.census verify` on regeneration: 166,700 nodes, 6,242,118 edges, 6,408,819 leaves, root `a7999c12b33dd7a5681541b7b9025c165b236b40cb76117885d5663e839b196e`; the CBG0 is 82,411,320 bytes (sha256 `799428b719f016cbd29da78549b23dfad22c9b4d635663c1e997e0f094bb0c61`), `nodes.json` 19,447,724 bytes.

## Re-verification

Python 3 standard library only; no packages to install:

```
python -m tools.census verify data/canonical/male-cns-v1.0.census.json
python -m tools.census root   data/canonical/male-cns-v1.0.census.json
```

`verify` reads the header, `nodes.json` and the CBG0 named in `files`, runs the structural validator (vocabularies, node ordering, node table equality between the two files, edge ordering and uniqueness, index range, weight positivity, counts, leaf count) and recomputes the root; it prints `OK` only when the recomputed root equals the header root and the root embedded in the CBG0 and there are no problems (about 20 s). `root` prints the recomputed root alone.

To regenerate from the raw sources (needs `pip install pyarrow` for the feather reader; ~1.07 GB download into `data/raw/malecns/`, gitignored; about a minute end to end):

```
python -m tools.census fetch   malecns
python -m tools.census convert malecns
```

`fetch` checks the byte sizes against the bucket listing and prints each file's sha256; `convert` records them in `provenance.converted_from`. The converter is deterministic; regeneration must reproduce the root above byte for byte or the raw files differ from the recorded sha256s.

Unit tests for canonicalization, Merkle construction (in-memory and streaming), validation, CBG0 packing/reading and split-layout verification:

```
python -m unittest tools.census.test_canonical -v
```

## Roles: node record → engine role byte

`scripts/roles.mjs` (mirrored byte for byte in `services/world/roles.mts` and `site/roles.js`; `node scripts/roles-check.mjs` asserts all three agree on `nodes.json` and match the counts below) derives every role from the node record only: `source_type` (= Janelia `class`), `side`, and the `category` keys `superclass`, `type`, `subclass`. Nothing outside the canonical files is consulted. `node scripts/roles.mjs` prints the counts.

Motor, command and endocrine roles come from `superclass` and, for motor neurons, the `subclass` muscle group (`fl`/`ml`/`hl` front/middle/hind leg, `wm` wing, `hm` haltere, `nm` neck, `pm` pharyngeal/proboscis, `ad` abdominal; `am`, `rm`, `xm` have no role):

| Role | Id | Rule (annotation values) | Count |
|------|----|--------------------------|-------|
| `MN_LEG_L1..L3` / `MN_LEG_R1..R3` | 20–22 / 23–25 | `superclass` `vnc_motor` or `cb_motor`, `subclass` `fl`/`ml`/`hl` → T1/T2/T3, `side` L/R (no leg MN lacks a side) | 68, 58, 66 / 67, 58, 64 |
| `MN_WING_POWER_L/R` | 26/27 | motor, `subclass` `wm`, `type` starts with `DLMn` or `DVMn` (indirect flight muscles) | 12 / 12 |
| `MN_WING_STEER_L/R` | 28/29 | motor, `subclass` `wm`, any other type (direct steering muscles b1–b3, i1–i2, iii1–iii3, hg1–hg4, tp1–tp2, tpn, ps1–ps2, plus the tergotrochanteral jump-muscle MNs TTMn/STTMm and MNwm35/36) | 21 / 22 |
| `MN_HALTERE_L/R` | 30/31 | motor, `subclass` `hm` | 8 / 8 |
| `MN_NECK` | 32 | motor, `subclass` `nm` (24 `vnc_motor` + 20 `cb_motor`) | 44 |
| `MN_PROBOSCIS` | 33 | `cb_motor`, `subclass` `pm` (MN1–MN13, MNx01–05, CEM: proboscis and pharyngeal pump) | 67 |
| `MN_ABDOMEN` | 34 | `subclass` `ad` or `abdomen` on `vnc_motor` (214) or `vnc_efferent` (6) | 220 |
| `DN_L` / `DN_R` / `DN_C` | 40/41/42 | `superclass` `descending_neuron`, by `side` (`M` or null → `DN_C`) | 656 / 648 / 10 |
| `AN` | 43 | `superclass` `ascending_neuron` | 1846 |
| `NEUROSECRETORY` | 50 | `superclass` `cb_endocrine` (IPC, PI3, DH44, DMS, ITP, DNES1–3, Hugin-RG, CAPA: 72) or `vnc_endocrine` (LK, FMRFa, CAPA: 22) | 94 |
| `INTERO` | 15 | `superclass` `ENS` (enteric nervous system) | 50 |

Sensory roles require a `superclass` containing `sensory` and then use `source_type` (class), `type` and `subclass`:

| Role | Id | Rule (annotation values) | Count |
|------|----|--------------------------|-------|
| `HALTERE` | 13 | any sensory `subclass` `haltere` (201 `mechanosensory_proprioceptive` + 4 `unknown_sensory`); tested first | 205 |
| `ORN` | 1 | class `olfactory` (types `ORN_*`, antennal nerve and maxillary palp) | 2639 |
| `PR_R1_6` / `PR_R1_6_R` | 10 / 16 | class `visual`, `type` `R1-R6`; `side` `R` → 16, else 10 (left eye; no photoreceptor lacks a `rootSide`) | 1112 / 2265 |
| `PR_R7_8` / `PR_R7_8_R` | 11 / 17 | class `visual`, `type` starts with `R7` or `R8` (`R7y`, `R8y`, `R7p`, `R8p`, `R7d`, `R8d`, `R7_unclear`, `R8_unclear`, `R7R8_unclear`); side as above | 1233 / 1481 |
| `OCELLAR` | 12 | class `visual`, `type` starting `ocell` — **no body in v1.0 carries such a type**; the role exists in the table and is empty | 0 |
| `THERMO_HOT` | 7 | class `thermosensory`, `type` starts with `TRN_VP2` (arista warming cells, Gr28b.d) | 7 |
| `THERMO_COLD` | 8 | class `thermosensory`, any other type (`TRN_VP3a`, `TRN_VP3b` arista cooling cells, `TRN_VP1m` sacculus) | 18 |
| `HYGRO` | 9 | class `hygrosensory` (`HRN_VP1d`, `HRN_VP1l`, `HRN_VP4`, `HRN_VP5`) | 66 |
| `GRN_SWEET` | 2 | class `gustatory`, `type` in {`LB3b`, `LB3c`} (labellar bristle GRNs matching Gr64f) or {`dorsal_tpGRN` (Gr5a), `claw_tpGRN` (Gr64e/Ir56d)} (taste pegs) — matches per the MaleCNS GRN typing paper, bioRxiv 10.1101/2025.08.25.671814 | 94 |
| `GRN_BITTER` | 3 | class `gustatory`, `type` in {`LB1a`, `LB1b`, `LB1c`, `LB1d`} (labellar bristle GRNs matching Gr33a, same paper) | 38 |
| `TASTE_LEG` | 14 | class `gustatory` with `subclass` `leg bristle` (LgLG*, LgAG*, SNch05; 768) or class `chemosensory` with `subclass` `leg` (20) | 788 |
| `JON` | 4 | class `mechanosensory`, `type` starts with `JO-` or `subclass` `auditory`/`wind_gravity` (Johnston's organ) | 672 |
| `BRISTLE` | 5 | class `mechanosensory_tactile` (all: bristle, notum, leg, wing; 2558) or class `mechanosensory` with `type` starting `BM` (head bristles: `BM_InOm`, `BM_Taste`, `BM_Vib`, ...; 932) | 3490 |
| `CHORDOTONAL` | 6 | class `mechanosensory_proprioceptive` not `haltere` (chordotonal organs, campaniform sensilla, hair plates, leg/wing/notum/abdomen/neck proprioceptors) | 1253 |

Everything else — intrinsic neurons, visual projection and centrifugal neurons, `unknown_sensory`, wing-bristle and pharyngeal GRNs not listed above, labellar `LB1e`/`LB2*`/`LB3a` (water)/`LB4*`, `am`/`rm`/`xm` motor neurons, non-abdominal `vnc_efferent`, and every `*_tbc` superclass — is role 0 (`NONE`): 147,240 nodes. Totals: 166,700.

## Appendix: CBG0 compact binary graph

The canonical edge table. Little-endian throughout; produced by the converter (`canonical.write_cbg0`), parsed by `canonical.read_cbg0`; the Merkle root at offset 4 binds the blob to the header and `nodes.json` it belongs with.

```
offset  size  field
0       4     magic "CBG0"
4       32    merkle root_sha256 of the census
36      4     u32 node_count
40      4     u32 edge_count
44      ...   node table, per node in canonical node order:
                u8 id_len, id bytes (ASCII), u8 kind
...     ...   edge table, per edge in canonical edge order (ascending pre_index, then post_index):
                u32 pre_index, u32 post_index, u8 kind, u32 weight      (13 bytes, packed)
```

Kind codes are the positions in the vocabularies in `tools/census/canonical.py` (`NODE_KINDS`, `EDGE_KINDS`):

| node kind code | value | | edge kind code | value |
|---|---|---|---|---|
| 0 | `neuron` | | 0 | `chemical` |
| 1 | `muscle` | | 1 | `gap_junction` |
| 2 | `glia` | | | |
| 3 | `epithelial` | | | |
| 4 | `gland` | | | |
| 5 | `end_organ` | | | |
| 6 | `other` | | | |

Node indices refer to canonical node order (= `nodes.json` row order), so the CBG0 edge table is the genome mapping in binary form and can be read straight into a CSR: `out_start[p]` is the offset of the first edge with `pre_index == p`. The shipped file: 44 + 166,700 × (2 + id_len) + 6,242,118 × 13 = 82,411,320 bytes. A host that wants only the graph reads the CBG0 and never parses JSON; a host that needs roles reads `nodes.json` too.
