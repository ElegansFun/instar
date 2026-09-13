# Licence position

The code in this repository is MIT. The dataset is not the code, and carries
its own terms.

## Berg et al. 2026, the Janelia MaleCNS connectome

*Sexual dimorphism in the complete connectome of the Drosophila male central
nervous system.* Berg S., Beckett I.R., Costa M., Schlegel P., Januszewski M.,
Marin E.C., Nern A., … Jefferis G.S.X.E. Cell (2026); bioRxiv
10.1101/2025.10.09.680999. Janelia FlyEM Male CNS connectome, release v1.0,
https://male-cns.janelia.org/.

**Licence: CC BY 4.0.** Janelia states it on the project pages verbatim:
"The Male CNS dataset is licensed under CC-BY", linking
https://creativecommons.org/licenses/by/4.0/. The data is served anonymously
from a public bucket; no account, token or click-through stands between the
files and anyone who wants to check them.

`tools/census/malecns.py` reads exactly two files from that bucket, the flat
connection weights (`connectome-weights-male-cns-v1.0-minconf-0.5.feather`)
and the body annotations; their URLs, sizes and SHA-256 are recorded in the
canonical header `data/canonical/male-cns-v1.0.census.json`, so anyone can
confirm the input. The conversion keeps every body Janelia annotates as a
neuron (166,700) and every connection of five or more synapses between them
(6,242,118); the weight is the synapse count as exported at confidence ≥ 0.5.

What CC BY 4.0 requires of us, and where it is done:

| obligation | where |
|---|---|
| credit the authors and cite the work | `dataset.citation` in the canonical header; section 6 of the site; this file; the NFT collection metadata |
| link the licence | `dataset.license`; site section 6 |
| state that the material was modified | the census format is a conversion and a threshold: `provenance.notes`, `docs/SCHEMA.md`, and the site's own words ("connections of five or more synapses") |
| no implication of endorsement | none is made anywhere |
| no added restrictions on the redistributed data | `data/canonical/` is served unauthenticated by the world process at `/data/canonical/` |

## What is not used, and why

**FlyWire / FAFB (Dorkenwald et al. 2024).** A female whole brain without a
nerve cord, so no leg or wing motor neurons. Its Zenodo connectivity tables
are marked CC BY 4.0, but flywire.ai's own Principles and Terms say
"Published versions of FlyWire's data are available under CC BY-NC 4.0"; a
token-funded product should not rest on a contradiction.

**BANC (Bates et al. 2026).** A female brain and nerve cord, CC BY 4.0 on its
Dataverse deposit, but sparser: only 18% of its synapses have an identified
neuron on both sides, against 40% for the MaleCNS.

**Hemibrain, MANC, the optic-lobe release.** Janelia, CC BY, and parts of a
fly rather than one animal's whole nervous system.

**Winding et al. 2023, the larva.** CC BY 4.0 via its PMC deposit; the world
ran on it before the adult, and the converter for it was removed when the
MaleCNS replaced it.

## Fonts and libraries

Instrument Serif and IBM Plex Mono are used under the SIL Open Font License
(`site/fonts/OFL-*.txt`). three.js is MIT (`site/vendor/`).
