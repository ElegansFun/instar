"""Census converter/verifier CLI. Standard library only.

  python -m tools.census convert droso_larva [--raw-dir data/raw/droso_larva] [--outdir data/canonical]
  python -m tools.census verify  <ccf.json> [more.json ...]
  python -m tools.census root    <ccf.json>
  python -m tools.census pack    <ccf.json> [-o out.cbg]
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from . import canonical


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def cmd_convert(args):
    from . import droso_larva

    written = droso_larva.convert(raw_dir=args.raw_dir, outdir=args.outdir)
    for path in written:
        ccf = _load(path)
        ok, root, problems = canonical.verify(ccf)
        status = "OK" if ok else "FAILED"
        print(f"{status}  {path}")
        print(f"      nodes={len(ccf['nodes'])} edges={len(ccf['edges'])} root={root}")
        for p in problems:
            print(f"      problem: {p}", file=sys.stderr)
        if not ok:
            return 1
    return 0


def cmd_verify(args):
    rc = 0
    for path in args.files:
        ok, root, problems = canonical.verify(_load(path))
        print(f"{'OK' if ok else 'FAILED'}  {path}  root={root}")
        for p in problems:
            print(f"      {p}", file=sys.stderr)
        if not ok:
            rc = 1
    return rc


def cmd_root(args):
    print(canonical.compute_root(_load(args.file)))
    return 0


def cmd_pack(args):
    ccf = _load(args.file)
    blob = canonical.pack_cbg0(ccf)
    out = args.output or (str(Path(args.file).with_suffix("")) + ".cbg")
    Path(out).write_bytes(blob)
    print(f"{out}  {len(blob)} bytes  sha256={hashlib.sha256(blob).hexdigest()}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="census")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("convert", help="convert a source dataset to CCF")
    sp.add_argument("dataset", choices=["droso_larva"])
    sp.add_argument("--raw-dir", default="data/raw/droso_larva",
                    help="directory with the PMC7614541 files")
    sp.add_argument("--outdir", default="data/canonical")
    sp.set_defaults(fn=cmd_convert)

    sp = sub.add_parser("verify", help="recompute Merkle root and validate")
    sp.add_argument("files", nargs="+")
    sp.set_defaults(fn=cmd_verify)

    sp = sub.add_parser("root", help="print recomputed Merkle root")
    sp.add_argument("file")
    sp.set_defaults(fn=cmd_root)

    sp = sub.add_parser("pack", help="produce CBG0 compact binary graph")
    sp.add_argument("file")
    sp.add_argument("-o", "--output")
    sp.set_defaults(fn=cmd_pack)

    args = p.parse_args(argv)
    return args.fn(args)
