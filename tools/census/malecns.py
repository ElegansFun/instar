"""Janelia MaleCNS v1.0 -> CCF v0.2 converter.

Adult male Drosophila melanogaster, whole central nervous system (central
brain, both optic lobes, ventral nerve cord). Berg et al. 2025/2026 report
166,691 neurons; the flat export carries a `superclass` annotation on
166,700 bodies and that annotated set is the census (it is also the count
Codex reports for the dataset). Licence: CC BY 4.0 (Janelia FlyEM).

Source files (anonymous HTTPS on the public GCS bucket, sha256 recorded in
provenance):
  - connectome-weights-male-cns-v1.0-minconf-0.5.feather: one row per
    (pre body, post body) segment pair with the synapse count at
    confidence >= 0.5.
  - body-annotations-male-cns-v1.0-minconf-0.5.feather: one row per body
    with class, type, side, nerve, target, receptor, flow, superclass,
    status ...

Reading feather needs pyarrow (`pip install pyarrow`); everything else is
the standard library, and `verify` never needs pyarrow.
"""

import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

from . import CONVERTER_VERSION, FORMAT_VERSION, canonical

BUCKET_URL = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/"
WEIGHTS_FILE = "connectome-weights-male-cns-v1.0-minconf-0.5.feather"
ANNOTATIONS_FILE = "body-annotations-male-cns-v1.0-minconf-0.5.feather"
# byte sizes from the bucket listing (ListBucketResult, 2026-06-03 objects)
SOURCE_SIZES = {WEIGHTS_FILE: 1051241946, ANNOTATIONS_FILE: 14483314}
MIN_WEIGHT = 5
DATASET_ID = "male-cns-v1.0"


class ConversionError(Exception):
    pass


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(raw_dir):
    """Download both source files into raw_dir (skips files already present
    with the listed size). Returns [(path, sha256, size)]."""
    raw_dir = Path(raw_dir)
    raw_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for name, size in SOURCE_SIZES.items():
        dest = raw_dir / name
        if dest.exists() and dest.stat().st_size == size:
            print(f"present  {dest} ({size} bytes)")
        else:
            url = BUCKET_URL + name
            part = dest.with_suffix(dest.suffix + ".part")
            print(f"GET      {url}")
            t0 = time.monotonic()
            done = 0
            with urllib.request.urlopen(url) as resp, open(part, "wb") as f:
                length = int(resp.headers.get("Content-Length") or 0)
                if length and length != size:
                    raise ConversionError(f"{name}: server reports {length} bytes, expected {size}")
                next_report = 0
                for chunk in iter(lambda: resp.read(1 << 22), b""):
                    f.write(chunk)
                    done += len(chunk)
                    if done >= next_report:
                        pct = 100 * done // size
                        print(f"         {pct:3d}%  {done / (1 << 20):8.1f} MiB  {time.monotonic() - t0:6.0f}s",
                              file=sys.stderr, flush=True)
                        next_report += 64 << 20
            if done != size:
                raise ConversionError(f"{name}: got {done} bytes, expected {size}")
            part.replace(dest)
            print(f"saved    {dest} ({done} bytes, {time.monotonic() - t0:.0f}s)")
        out.append((dest, _sha256_file(dest), dest.stat().st_size))
        print(f"sha256   {out[-1][1]}  {name}")
    return out


# Annotation columns folded into `category`, in this order, as `key=value`
# pairs joined by ";" (null columns skipped). `nerve` is entryNerve for
# bodies that have one (sensory afferents) and exitNerve otherwise (motor,
# efferent); no body carries both (checked at conversion).
CATEGORY_KEYS = (
    ("superclass", "superclass"),
    ("type", "type"),
    ("subclass", "subclass"),
    ("nerve", None),
    ("receptor", "receptorType"),
    ("neuromere", "somaNeuromere"),
)


def _category(row):
    parts = []
    for key, col in CATEGORY_KEYS:
        if col is None:
            entry, exit_ = row["entryNerve"], row["exitNerve"]
            if entry and exit_:
                raise ConversionError(f"body {row['bodyId']} has both entryNerve and exitNerve")
            value = entry or exit_
        else:
            value = row[col]
        if value is None:
            continue
        if ";" in value or "=" in value or '"' in value or "\\" in value \
                or not value.isprintable() or value != value.strip():
            raise ConversionError(f"body {row['bodyId']}: {key} value {value!r} cannot be packed")
        parts.append(f"{key}={value}")
    return ";".join(parts) if parts else None


def _side(row):
    side = row["somaSide"] or row["rootSide"]
    return side if side in canonical.SIDES else None


def _load_nodes(annotations_path):
    """Canonical node records (sorted by id bytewise) from the annotations
    feather. A body is a neuron of the census iff it carries a `superclass`
    annotation (Janelia's neuron set: 166,700 bodies in v1.0)."""
    import pyarrow.compute as pc
    import pyarrow.feather as feather

    cols = ["bodyId", "class", "superclass", "type", "subclass", "entryNerve", "exitNerve",
            "receptorType", "somaNeuromere", "somaSide", "rootSide"]
    table = feather.read_table(annotations_path, columns=cols)
    table = table.filter(pc.is_valid(table["superclass"]))
    rows = table.to_pylist()
    nodes = []
    for row in rows:
        nodes.append({
            "id": str(row["bodyId"]),
            "kind": "neuron",
            "source_type": row["class"],
            "side": _side(row),
            "category": _category(row),
        })
    nodes.sort(key=lambda n: n["id"])
    if len({n["id"] for n in nodes}) != len(nodes):
        raise ConversionError("duplicate bodyId in annotations")
    return nodes


def _load_edges(weights_path, node_ids):
    """Edges with both endpoints in `node_ids` and weight >= MIN_WEIGHT, as
    three Python lists (pre_index, post_index, weight) in canonical order.
    Indices refer to the position in `node_ids` (canonical node order)."""
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.feather as feather

    ids = pa.array([int(i) for i in node_ids], type=pa.int64())
    table = feather.read_table(weights_path, columns=["body_pre", "body_post", "weight"])
    total = table.num_rows
    table = table.filter(pc.greater_equal(table["weight"], MIN_WEIGHT))
    keep = pc.and_(pc.is_in(table["body_pre"], value_set=ids),
                   pc.is_in(table["body_post"], value_set=ids))
    table = table.filter(keep)
    pre = pc.index_in(table["body_pre"], value_set=ids)
    post = pc.index_in(table["body_post"], value_set=ids)
    table = pa.table({"pre": pre, "post": post, "weight": table["weight"]})
    table = table.sort_by([("pre", "ascending"), ("post", "ascending")])
    return total, table["pre"].to_pylist(), table["post"].to_pylist(), table["weight"].to_pylist()


def convert(raw_dir, outdir):
    raw_dir = Path(raw_dir)
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    weights = raw_dir / WEIGHTS_FILE
    annotations = raw_dir / ANNOTATIONS_FILE
    for p in (weights, annotations):
        if not p.exists():
            raise ConversionError(f"missing source file {p} (run: python -m tools.census fetch malecns)")

    t0 = time.monotonic()
    nodes = _load_nodes(annotations)
    ids = [n["id"] for n in nodes]
    print(f"nodes    {len(nodes)} ({time.monotonic() - t0:.0f}s)")
    total_rows, pre, post, weight = _load_edges(weights, ids)
    print(f"edges    {len(pre)} of {total_rows} weight rows ({time.monotonic() - t0:.0f}s)")
    if not pre:
        raise ConversionError("no edges survived the filter")
    self_loops = sum(1 for a, b in zip(pre, post) if a == b)

    header = {
        "census_format": FORMAT_VERSION,
        "dataset": {
            "id": DATASET_ID,
            "species": "Drosophila melanogaster",
            "common_name": "fruit fly",
            "variant": "adult male, whole central nervous system (brain, optic lobes, ventral nerve cord)",
            "dataset_name": "Janelia FlyEM Male CNS connectome (MaleCNS) v1.0",
            "dataset_version": "v1.0 flat connectome export, synapse confidence >= 0.5",
            "modality": "electron microscopy reconstruction",
            "citation": (
                "Berg, S., Beckett, I.R., Costa, M., Schlegel, P., Januszewski, M., Marin, E.C., "
                "Nern, A., ... Jefferis, G.S.X.E. (2025). Sexual dimorphism in the complete "
                "connectome of the Drosophila male central nervous system. bioRxiv. "
                "https://doi.org/10.1101/2025.10.09.680999 (Cell 2026, "
                "https://www.cell.com/cell/fulltext/S0092-8674(26)00942-6). Janelia FlyEM."
            ),
            "license": "CC BY 4.0 (Janelia FlyEM: \"The Male CNS dataset is licensed under CC-BY\")",
            "source_urls": [
                BUCKET_URL + WEIGHTS_FILE,
                BUCKET_URL + ANNOTATIONS_FILE,
                "https://male-cns.janelia.org/",
            ],
        },
        "provenance": {
            "converter": CONVERTER_VERSION,
            "converted_from": [
                {"filename": WEIGHTS_FILE, "sha256": _sha256_file(weights),
                 "size": weights.stat().st_size, "url": BUCKET_URL + WEIGHTS_FILE,
                 "role": "segment-to-segment connection weights (body_pre, body_post, weight)"},
                {"filename": ANNOTATIONS_FILE, "sha256": _sha256_file(annotations),
                 "size": annotations.stat().st_size, "url": BUCKET_URL + ANNOTATIONS_FILE,
                 "role": "body annotations (class, superclass, type, subclass, nerves, receptor, sides)"},
            ],
            "notes": [
                "nodes: every body with a non-null `superclass` annotation (Janelia's neuron set), "
                "id = bodyId as a decimal string; bytewise node ordering",
                "source_type = annotation `class` verbatim (null where Janelia gives none)",
                "side = somaSide, or rootSide when somaSide is null (sensory afferents have no soma "
                "in the volume); L, R, M or null",
                "category = `key=value` pairs joined by `;` in the order superclass, type, subclass, "
                "nerve (entryNerve, else exitNerve), receptor (receptorType), neuromere "
                "(somaNeuromere); null columns skipped",
                f"edges: weight rows with both bodies in the node set and weight >= {MIN_WEIGHT}; "
                f"weight = synapse count at confidence >= 0.5 as exported; {self_loops} self-loops kept",
                "all edges chemical; the export does not distinguish gap junctions",
            ],
        },
    }

    acc = canonical.MerkleAccumulator()
    acc.add(canonical.meta_leaf(header))
    for n in nodes:
        acc.add(canonical.node_leaf(n))
    edge_leaf = canonical.edge_leaf
    for a, b, w in zip(pre, post, weight):
        acc.add(edge_leaf(ids[a], ids[b], "chemical", w))
    root = acc.root().hex()
    print(f"root     {root} ({time.monotonic() - t0:.0f}s)")

    header["files"] = {
        "graph": f"{DATASET_ID}.census.cbg",
        "nodes": f"{DATASET_ID}.nodes.json",
    }
    header["node_count"] = len(nodes)
    header["edge_count"] = len(pre)
    header["merkle"] = canonical.merkle_block(acc.count, root)

    cbg_path = outdir / header["files"]["graph"]
    with open(cbg_path, "wb") as f:
        canonical.write_cbg0(f, root, nodes, zip(pre, post, (0 for _ in pre), weight), len(pre))

    nodes_path = outdir / header["files"]["nodes"]
    with open(nodes_path, "w", encoding="utf-8", newline="\n") as f:
        f.write('{"census_format":%s,"dataset_id":%s,"root_sha256":%s,"node_count":%d,"nodes":[\n' % (
            json.dumps(FORMAT_VERSION), json.dumps(DATASET_ID), json.dumps(root), len(nodes)))
        last = len(nodes) - 1
        for i, n in enumerate(nodes):
            f.write(json.dumps(n, ensure_ascii=False, separators=(",", ":")))
            f.write(",\n" if i != last else "\n")
        f.write("]}\n")

    header_path = outdir / f"{DATASET_ID}.census.json"
    with open(header_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(header, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"written  {cbg_path} {cbg_path.stat().st_size} bytes; {nodes_path} "
          f"{nodes_path.stat().st_size} bytes; {header_path} ({time.monotonic() - t0:.0f}s)")
    return str(header_path)
