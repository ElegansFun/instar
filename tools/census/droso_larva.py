"""Winding et al. 2023 (Science 379:eadd9330) -> CCF converter.

Drosophila melanogaster first-instar larva, whole BRAIN connectome
(2,952 reconstructed neurons; the ventral nerve cord, where motor neurons
live, is not part of this dataset).

Source (the only openly licensed copy — CC BY 4.0 via the author-manuscript
deposit, see docs/LICENSES.md): Europe PMC bundle for PMC7614541.
  - all-all_connectivity_matrix.csv: 2952x2952, row = presynaptic skid,
    col = postsynaptic skid, values = synapse counts (verified elsewhere to
    equal ad+aa+dd+da exactly). Matrix files are aligned by skid, not
    position.
  - Supplementary_Data_S2.csv: one row per homologous left/right neuron
    pair: left_id, right_id, celltype, additional_annotations,
    level_7_cluster. Hemisphere comes from which column a skid sits in.

Conversion decisions (recorded in provenance.notes):
  - node id = CATMAID skeleton id as decimal string; bytewise node ordering
    per CCF spec.
  - source_type = the S2 celltype string verbatim; ~346 matrix skids have no
    S2 row -> source_type null.
  - category = the S2 additional_annotations string verbatim for neurons
    whose celltype is "sensory" (olfactory, gustatory-external,
    gustatory-pharyngeal, gut, respiratory, thermo-cold, thermo-warm,
    visual) or "ascending" (mechano-Ch, mechano-II/III, noci, proprio,
    unknown modality: body sensation relayed from the ventral nerve cord).
    For those two celltypes the column is the modality. Every other neuron
    gets null: for the remaining celltypes S2 uses the same column for
    lineage/cluster labels, which are not a category. A sensory or
    ascending row with an empty annotation would also yield null.
  - all edges kind "chemical" (the dataset reports chemical synapses only).
"""

import csv
import hashlib
import json
from pathlib import Path

from . import CONVERTER_VERSION, FORMAT_VERSION, canonical

BUNDLE_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7614541/supplementaryFiles"
# S2 celltypes whose additional_annotations column is a sensory modality.
MODALITY_CELLTYPES = ("sensory", "ascending")


class ConversionError(Exception):
    pass


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _read_annotations(s2_path):
    """skid -> (celltype, additional_annotations, side)

    S2 has one row per homologous pair; a skid sits in left_id or right_id,
    and the missing partner is written as the literal "no pair"."""
    out = {}
    with open(s2_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        if header[:4] != ["left_id", "right_id", "celltype", "additional_annotations"]:
            raise ConversionError(f"unexpected S2 header: {header}")
        for row in reader:
            left_id, right_id = row[0].strip(), row[1].strip()
            celltype, annotation = row[2].strip(), row[3].strip()
            for skid, side in ((left_id, "L"), (right_id, "R")):
                if skid and skid != "no pair":
                    if skid in out:
                        raise ConversionError(f"S2 lists skid {skid} more than once")
                    out[skid] = (celltype, annotation, side)
    return out


def _cell_value(text):
    if text in ("", "0", "0.0"):
        return 0
    value = float(text)
    if not value.is_integer():
        raise ConversionError(f"non-integer synapse count {text!r}")
    return int(value)


def convert(raw_dir, outdir):
    raw_dir = Path(raw_dir)
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    allall = raw_dir / "S1" / "Supplementary-Data-S1" / "all-all_connectivity_matrix.csv"
    s2 = raw_dir / "EMS175448-supplement-Supplementary_Data_S2.csv"
    bundle = raw_dir / "PMC7614541_SupplementaryFiles.zip"
    for p in (allall, s2, bundle):
        if not p.exists():
            raise ConversionError(f"missing source file {p}")

    annotations = _read_annotations(s2)

    edges = []
    with open(allall, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        if header[0].strip():
            raise ConversionError("expected empty corner cell in matrix header")
        col_skids = [c.strip() for c in header[1:]]
        if len(set(col_skids)) != len(col_skids):
            raise ConversionError("duplicate column skids")
        row_skids = []
        for row in reader:
            pre = row[0].strip()
            row_skids.append(pre)
            for j, cell in enumerate(row[1:]):
                w = _cell_value(cell)
                if w > 0:
                    edges.append(
                        {"pre": pre, "post": col_skids[j], "kind": "chemical",
                         "weight": w, "polarity": None}
                    )
        if sorted(row_skids) != sorted(col_skids):
            raise ConversionError("row skid set differs from column skid set")

    unannotated = 0
    nodes = []
    for skid in sorted(col_skids):
        ann = annotations.get(skid)
        if ann is None:
            unannotated += 1
        celltype, annotation, side = ann if ann else (None, "", None)
        nodes.append({
            "id": skid,
            "kind": "neuron",
            "source_type": celltype,
            "cell_class": None,
            "side": side,
            "category": annotation if celltype in MODALITY_CELLTYPES and annotation else None,
            "neurotransmitter": None,
        })
    edges.sort(key=lambda e: (e["kind"], e["pre"], e["post"]))

    census = {
        "census_format": FORMAT_VERSION,
        "dataset": {
            "id": "droso-winding2023-larva",
            "species": "Drosophila melanogaster",
            "common_name": "fruit fly",
            "variant": "first instar larva, whole brain",
            "dataset_name": "The connectome of an insect brain (Winding et al. 2023)",
            "dataset_version": "PMC7614541 author-manuscript deposit, Data S1/S2",
            "modality": "electron microscopy reconstruction",
            "citation": (
                "Winding, M., Pedigo, B.D., Barnes, C.L., Patsolic, H.G., Park, Y., "
                "Kazimiers, T., Fushiki, A., Andrade, I.V., Khandelwal, A., Valdes-Aleman, J., "
                "Li, F., Randel, N., Barsotti, E., Correia, A., Fetter, R.D., Hartenstein, V., "
                "Priebe, C.E., Vogelstein, J.T., Cardona, A., Zlatic, M. (2023). The connectome "
                "of an insect brain. Science 379, eadd9330. https://doi.org/10.1126/science.add9330"
            ),
            "license": (
                "CC BY 4.0 (author-manuscript deposit PMC7614541; the science.org version of "
                "record carries different terms and was not used -- see docs/LICENSES.md)"
            ),
            "source_urls": [
                BUNDLE_URL,
                "https://doi.org/10.1126/science.add9330",
            ],
        },
        "nodes": nodes,
        "edges": edges,
        "provenance": {
            "converter": CONVERTER_VERSION,
            "converted_from": [
                {"filename": "all-all_connectivity_matrix.csv", "sha256": _sha256(allall),
                 "url": BUNDLE_URL, "role": "summed connectivity matrix (row=pre, col=post)"},
                {"filename": s2.name, "sha256": _sha256(s2),
                 "url": BUNDLE_URL, "role": "cell annotations (celltype, hemisphere pairs)"},
                {"filename": bundle.name, "sha256": _sha256(bundle),
                 "url": BUNDLE_URL, "role": "source bundle (Europe PMC, CC BY 4.0)"},
            ],
            "notes": [
                "brain only: the ventral nerve cord (motor neurons, muscles) is not part of this dataset",
                "node ids are CATMAID skeleton ids as decimal strings; matrix files align by skid",
                "weights are synapse counts from the summed all-all matrix "
                "(verified equal to ad+aa+dd+da component matrices by independent inspection)",
                f"{unannotated} of {len(nodes)} neurons have no S2 annotation row: source_type null",
                "hemisphere (side) derived from S2 left_id/right_id pair columns",
                "category = S2 additional_annotations verbatim for celltype sensory or ascending "
                "(the sensory modality); null for every other neuron, whose S2 annotation "
                "column holds lineage/cluster labels rather than a category",
                "all edges chemical; the dataset reports no gap junctions",
            ],
        },
    }
    canonical.attach_merkle(census)
    out = outdir / f"{census['dataset']['id']}.census.json"
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(census, f, ensure_ascii=False, indent=1)
        f.write("\n")
    return [str(out)]
