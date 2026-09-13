# Census Canonical Connectome Format (CCF) v0.1.0

One deterministic, hash-stable representation of the connectome that drives every larva in Instar. The converter in `tools/census` maps the published Winding et al. 2023 dataset into this format; the Merkle root of the canonical form is what the world and the site check against. This document is the normative spec: the Python reference (`tools/census/canonical.py`) and any other implementation that reads the file (the world process, the site, the role mapping scripts) must agree with it byte for byte.

Canonical file: `data/canonical/droso-winding2023-larva.census.json`.

## Design rules

1. **Real data only.** Every record traces to a published source file listed in `provenance` with its sha256. The converter never invents a neuron, an edge, or a weight.
2. **Deterministic.** The same input bytes produce a byte-identical hashed payload regardless of when or where conversion runs. Every ordering is specified. No timestamps inside the hashed payload.
3. **Explicit unknowns.** A fact the source does not state is `null`, never omitted, never guessed. The dataset reports no synapse polarity and no neurotransmitters, so those fields are `null` throughout.
4. **Integers only.** Weights are synapse counts. No floating point anywhere; the canonicalizer rejects floats.

## What the file does and does not contain

The Winding et al. 2023 dataset is the first-instar larval *brain*: 2,952 reconstructed neurons and their chemical synapses. It does not include the ventral nerve cord, motor neurons, muscles, neuron dynamics, neuromodulation, or gap junctions. The file therefore has `kind: "neuron"` for every node and `kind: "chemical"` for every edge. The other `kind` values in the vocabulary below exist so that the format can describe other datasets without a format change; they are unused here.

## File layout

`data/canonical/<dataset_id>.census.json`, UTF-8 JSON, pretty-printed for humans. Hashing uses the canonical serialization (below), so on-disk whitespace is irrelevant to the root.

| Key | Hashed | Content |
|-----|--------|---------|
| `census_format` | yes | `"0.1.0"` |
| `dataset` | yes | identity, citation, licence block |
| `nodes` | yes | neurons |
| `edges` | yes | chemical synapses with counts |
| `provenance` | yes | source files with sha256, converter version, conversion notes |
| `merkle` | no | the root and tree parameters (cannot hash itself) |
| `annotations` | no | optional, free-form, mutable; absent in the shipped file |

### `dataset`

```json
{
  "id": "droso-winding2023-larva",
  "species": "Drosophila melanogaster",
  "common_name": "fruit fly",
  "variant": "first instar larva, whole brain",
  "dataset_name": "The connectome of an insect brain (Winding et al. 2023)",
  "dataset_version": "PMC7614541 author-manuscript deposit, Data S1/S2",
  "modality": "electron microscopy reconstruction",
  "citation": "Winding, M., Pedigo, B.D., ... Zlatic, M. (2023). The connectome of an insect brain. Science 379, eadd9330. https://doi.org/10.1126/science.add9330",
  "license": "CC BY 4.0 (author-manuscript deposit PMC7614541; ...)",
  "source_urls": ["https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7614541/supplementaryFiles", "https://doi.org/10.1126/science.add9330"]
}
```

`id` is a slug `<species-short>-<source>-<variant>` matching `^[a-z0-9]+(-[a-z0-9]+)*$`.

### `nodes[]`

```json
{"id": "3464773", "kind": "neuron", "source_type": "sensory", "cell_class": null, "side": "L", "category": "olfactory", "neurotransmitter": null}
```

| Field | Values |
|-------|--------|
| `id` | CATMAID skeleton id as a decimal string; ASCII; unique |
| `kind` | `neuron` \| `muscle` \| `glia` \| `epithelial` \| `gland` \| `end_organ` \| `other` (this file: always `neuron`) |
| `source_type` | the S2 `celltype` string verbatim (`sensory`, `PN`, `KC`, `DN-VNC`, `DN-SEZ`, `RGN`, ...); `null` for the 346 neurons the matrix contains but S2 does not list |
| `cell_class` | `null` (the source gives no anatomical class) |
| `side` | `L` \| `R` \| `null`; hemisphere from which S2 pair column the skid sits in; `null` when S2 does not list the neuron |
| `category` | for `source_type` `sensory` or `ascending`: the S2 `additional_annotations` string verbatim, which for those two celltypes is the sensory modality. On `sensory`: `olfactory`, `gustatory-external`, `gustatory-pharyngeal`, `gut`, `respiratory`, `thermo-cold`, `thermo-warm`, `visual`. On `ascending` (body sensation relayed into the brain from the ventral nerve cord): `mechano-Ch`, `mechano-II/III`, `noci`, `proprio`, `unknown modality`, and three lineage-prefixed forms `A00c_a4; noci`, `A00c_a5; noci`, `A00c_a6; noci`. `null` for every other neuron. Any non-empty string is schema-valid; the vocabulary is the source's, not ours |
| `neurotransmitter` | `null` (not reported by the source) |

`category` is `null` for the remaining celltypes on purpose: for those rows S2 uses the same column for lineage and cluster labels (`FBN-3`, `MBON-a1`, `no official annotation`), which are not a category. The string is never split or normalized; a consumer that wants "noci" must also accept the `A00c_*; noci` forms.

`category` is a hashed field. Changing how it is populated changes the root; the root recorded below is for the population rule stated here.

### `edges[]`

```json
{"pre": "3464773", "post": "10831005", "kind": "chemical", "weight": 30, "polarity": null}
```

| Field | Values |
|-------|--------|
| `pre`, `post` | node ids (must exist in `nodes`) |
| `kind` | `chemical` \| `gap_junction` (this file: always `chemical`) |
| `weight` | positive integer synapse count exactly as the summed all-all matrix reports it |
| `polarity` | `excitatory` \| `inhibitory` \| `null` (this file: always `null`) |

Rules:

- Every non-zero cell of the source matrix is one edge; zero cells produce no record. Self-loops are kept if the source reports them.
- Gap junctions, when a dataset has them, are undirected and stored once per unordered pair with `pre <= post` bytewise. The validator enforces this even though this file has none.

### Ordering (normative)

- `nodes` sorted by `id`, bytewise ascending.
- `edges` sorted by (`kind`, `pre`, `post`), bytewise ascending.

**Genome mapping.** A larva's genome is the vector of edge weights in exactly this order: `genome[i]` is the weight for `edges[i]` of the canonical file, and the engine's `edge_pre[i]` / `edge_post[i]` are the node indexes (positions in `nodes`) of `edges[i].pre` / `edges[i].post`. Every place that refers to a weight index (engine, host, site, probe scripts) means this ordering. This is what makes "descended from the real connectome" checkable rather than a claim: an edge's ancestral weight is the number at the same position in the canonical file.

### `provenance`

```json
{
  "converter": "census-converter/0.1.0",
  "converted_from": [
    {"filename": "all-all_connectivity_matrix.csv", "sha256": "...", "url": "...", "role": "summed connectivity matrix (row=pre, col=post)"},
    {"filename": "EMS175448-supplement-Supplementary_Data_S2.csv", "sha256": "...", "url": "...", "role": "cell annotations (celltype, hemisphere pairs)"},
    {"filename": "PMC7614541_SupplementaryFiles.zip", "sha256": "...", "url": "...", "role": "source bundle (Europe PMC, CC BY 4.0)"}
  ],
  "notes": ["...conversion decisions..."]
}
```

No dates here (rule 2).

## Canonical serialization (for hashing)

RFC 8785-style JSON subset:

- UTF-8 bytes; object keys sorted bytewise; separators `,` and `:` with no whitespace.
- Strings minimally escaped: only `"`, `\`, and control characters U+0000 to U+001F are escaped; every other character appears as literal UTF-8.
- Integers in base 10, no leading zeros, `-` for negatives. Floats are rejected.
- `null`, `true`, `false` as literals.

Python reference: `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")` after float rejection.

## Merkle construction (normative)

RFC 6962 (Certificate Transparency) tree over SHA-256:

- `leaf_hash = SHA256(0x00 || leaf_bytes)`
- `interior = SHA256(0x01 || left || right)`
- For n > 1 leaves, split at k = the largest power of two strictly less than n; root = interior(MTH(first k), MTH(rest)).

Leaves, in order:

1. one **meta** leaf: `canon({"t":"meta","v":{"census_format":...,"dataset":{...},"provenance":{...}}})`
2. one leaf per node, in node order: `canon({"t":"node","v":{...node record...}})`
3. one leaf per edge, in edge order: `canon({"t":"edge","v":{...edge record...}})`

The `merkle` block records the parameters and the root:

```json
{"algorithm": "rfc6962-sha256", "leaf_order": "meta,nodes,edges", "leaf_count": 113630, "root_sha256": "20bf96b024a0443cef186773d7c1bf615c9f46377c02480fc31edad5a3096b5a"}
```

Domain separation (the 0x00 / 0x01 prefixes) prevents second-preimage attacks; per-record leaves give O(log n) inclusion proofs, so a single neuron or synapse can be proven against the root.

Shipped file, as measured by `python -m tools.census verify` on regeneration: 2,952 nodes, 110,677 edges, 113,630 leaves, root `20bf96b024a0443cef186773d7c1bf615c9f46377c02480fc31edad5a3096b5a`.

## Re-verification

Python 3 standard library only; no packages to install.

```
python -m tools.census verify data/canonical/droso-winding2023-larva.census.json
python -m tools.census root   data/canonical/droso-winding2023-larva.census.json
```

`verify` runs the structural validator (vocabularies, ordering, referential integrity, weight positivity, leaf count) and recomputes the root; it prints `OK` only when the recomputed root equals the embedded one and there are no problems. `root` prints the recomputed root alone.

To regenerate from the raw sources (`data/raw/droso_larva/`, sha256 of each file recorded in `provenance.converted_from`):

```
python -m tools.census convert droso_larva --raw-dir data/raw/droso_larva --outdir data/canonical
```

The converter is deterministic; regeneration must reproduce the root above byte for byte or the raw files differ from the recorded sha256s.

Unit tests for canonicalization, Merkle construction, validation and CBG0 packing:

```
python -m unittest tools.census.test_canonical -v
```

## Appendix: CBG0 compact binary graph

A deterministic binary derivation of a canonical CCF file, for consumers that want the graph without a JSON parser. Little-endian throughout. Produced by `python -m tools.census pack <ccf.json> [-o out.cbg]`; the Merkle root at offset 4 binds the blob to the JSON it came from.

```
offset  size  field
0       4     magic "CBG0"
4       32    merkle root_sha256 of the source CCF file
36      4     u32 node_count
40      4     u32 edge_count
44      ...   node table, per node in canonical node order:
                u8 id_len, id bytes (ASCII), u8 kind
...     ...   edge table, per edge in canonical edge order:
                u16 pre_index, u16 post_index, u8 kind, u32 weight
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

Node indexes refer to canonical node order, so a CBG0 edge table is the genome mapping in binary form. `node_count` must fit in 16 bits (65,535); the larval brain uses 2,952. The shipped file packs to 1,024,394 bytes.
