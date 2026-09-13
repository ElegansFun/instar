"""Census converter/verifier CLI.

  python -m tools.census fetch   malecns [--raw-dir data/raw/malecns]
  python -m tools.census convert malecns [--raw-dir data/raw/malecns] [--outdir data/canonical]
  python -m tools.census verify  <census.json> [more.json ...]
  python -m tools.census root    <census.json>

`fetch` and `convert` need pyarrow (`pip install pyarrow`); `verify` and
`root` are standard library only. A census.json is either the split-layout
header (with `files.graph` / `files.nodes` next to it) or a full in-memory
CCF document with `nodes` and `edges` arrays.
"""

import argparse
import json
import sys
from pathlib import Path

from . import canonical


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _verify_path(path):
    """(ok, root, problems, description) for either layout."""
    doc = _load(path)
    if "files" in doc:
        base = Path(path).parent
        nodes_doc = _load(base / doc["files"]["nodes"])
        blob = (base / doc["files"]["graph"]).read_bytes()
        ok, root, problems = canonical.verify_split(doc, nodes_doc, blob)
        desc = f"nodes={doc.get('node_count')} edges={doc.get('edge_count')}"
    else:
        ok, root, problems = canonical.verify(doc)
        desc = f"nodes={len(doc.get('nodes', []))} edges={len(doc.get('edges', []))}"
    return ok, root, problems, desc


def cmd_fetch(args):
    from . import malecns

    malecns.fetch(args.raw_dir)
    return 0


def cmd_convert(args):
    from . import malecns

    path = malecns.convert(raw_dir=args.raw_dir, outdir=args.outdir)
    ok, root, problems, desc = _verify_path(path)
    print(f"{'OK' if ok else 'FAILED'}  {path}")
    print(f"      {desc} root={root}")
    for p in problems:
        print(f"      problem: {p}", file=sys.stderr)
    return 0 if ok else 1


def cmd_verify(args):
    rc = 0
    for path in args.files:
        ok, root, problems, desc = _verify_path(path)
        print(f"{'OK' if ok else 'FAILED'}  {path}  {desc} root={root}")
        for p in problems:
            print(f"      {p}", file=sys.stderr)
        if not ok:
            rc = 1
    return rc


def cmd_root(args):
    _, root, _, _ = _verify_path(args.file)
    print(root)
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="census")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("fetch", help="download the source files into data/raw")
    sp.add_argument("dataset", choices=["malecns"])
    sp.add_argument("--raw-dir", default="data/raw/malecns")
    sp.set_defaults(fn=cmd_fetch)

    sp = sub.add_parser("convert", help="convert a source dataset to CCF v0.2 (CBG0 + nodes.json + header)")
    sp.add_argument("dataset", choices=["malecns"])
    sp.add_argument("--raw-dir", default="data/raw/malecns",
                    help="directory with the MaleCNS feather files")
    sp.add_argument("--outdir", default="data/canonical")
    sp.set_defaults(fn=cmd_convert)

    sp = sub.add_parser("verify", help="recompute the Merkle root and validate")
    sp.add_argument("files", nargs="+")
    sp.set_defaults(fn=cmd_verify)

    sp = sub.add_parser("root", help="print the recomputed Merkle root")
    sp.add_argument("file")
    sp.set_defaults(fn=cmd_root)

    args = p.parse_args(argv)
    return args.fn(args)
