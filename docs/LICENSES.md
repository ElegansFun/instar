# Licence position

The code in this repository is MIT. The dataset is not the code, and carries
its own terms.

## Winding et al. 2023, the larval connectome

*The connectome of an insect brain.* Winding M., Pedigo B.D., Barnes C.L.,
Patsolic H.G., Park Y., Kazimiers T., Fushiki A., Andrade I.V., Khandelwal A.,
Valdes-Aleman J., Li F., Randel N., Barsotti E., Correia A., Fetter R.D.,
Hartenstein V., Priebe C.E., Vogelstein J.T., Cardona A., Zlatic M. Science
379, eadd9330 (2023). DOI 10.1126/science.add9330.

**The copy determines the licence.** The version of record and its
supplementary zip on science.org fall under the AAAS terms of service:
personal, non-commercial use, no redistribution without written permission.
The **author-manuscript deposit on Europe PMC (PMC7614541, files EMS175448
Data S1–S4) is CC BY 4.0**, and that is the only copy this project uses.

`tools/census/droso_larva.py` reads only the PMC bundle; the canonical file's
`provenance` block records each source file's URL and SHA-256, so anyone can
confirm the input was the openly licensed copy. The canonical file's
`dataset.license` field says exactly this.

What CC BY 4.0 requires of us, and where it is done:

| obligation | where |
|---|---|
| credit the authors and cite the work | `dataset.citation` in the canonical file; section 6 of the site; this file |
| link the licence | `dataset.license`; site section 6 |
| state that the material was modified | the census format is a conversion: `provenance.converter`, `docs/SCHEMA.md` |
| no implication of endorsement | none is made anywhere |
| no added restrictions on the redistributed data | `data/canonical/` is served unauthenticated by the world process at `/data/canonical/` |

## What is not used

The adult fly connectome (FlyWire) is not used: its public terms are
contradictory (CC BY-NC 4.0 on flywire.ai, CC BY 4.0 on the consortium's
Zenodo deposits) and at 139,000 neurons it is far beyond a per-larva genome in
any case. No other dataset ships with this project.

## Fonts and libraries

Instrument Serif and IBM Plex Mono are used under the SIL Open Font License
(`site/fonts/OFL-*.txt`). three.js is MIT (`site/vendor/`).
