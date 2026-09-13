"""Canonical serialization, Merkle construction (RFC 6962 / SHA-256), and
CCF validation. Normative behavior is specified in docs/SCHEMA.md."""

import hashlib
import json

from . import FORMAT_VERSION

NODE_KINDS = ("neuron", "muscle", "glia", "epithelial", "gland", "end_organ", "other")
EDGE_KINDS = ("chemical", "gap_junction")
POLARITIES = ("excitatory", "inhibitory")


def _reject_floats(obj, path="$"):
    if isinstance(obj, float):
        raise ValueError(f"float not allowed in canonical payload at {path}")
    if isinstance(obj, bool):
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            if not isinstance(k, str):
                raise ValueError(f"non-string key at {path}")
            _reject_floats(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _reject_floats(v, f"{path}[{i}]")


def canon_bytes(obj):
    """RFC 8785-style canonical JSON bytes (see docs/SCHEMA.md)."""
    _reject_floats(obj)
    return json.dumps(
        obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _leaf_hash(data):
    return hashlib.sha256(b"\x00" + data).digest()


def _interior_hash(left, right):
    return hashlib.sha256(b"\x01" + left + right).digest()


def merkle_root(leaves):
    """RFC 6962 Merkle tree root over a list of leaf byte-strings."""
    if not leaves:
        raise ValueError("empty tree")
    hashes = [_leaf_hash(b) for b in leaves]

    def mth(hs):
        n = len(hs)
        if n == 1:
            return hs[0]
        k = 1
        while k * 2 < n:
            k *= 2
        return _interior_hash(mth(hs[:k]), mth(hs[k:]))

    return mth(hashes)


def leaves_for(census):
    meta = {
        "t": "meta",
        "v": {
            "census_format": census["census_format"],
            "dataset": census["dataset"],
            "provenance": census["provenance"],
        },
    }
    out = [canon_bytes(meta)]
    for n in census["nodes"]:
        out.append(canon_bytes({"t": "node", "v": n}))
    for e in census["edges"]:
        out.append(canon_bytes({"t": "edge", "v": e}))
    return out


def compute_root(census):
    return merkle_root(leaves_for(census)).hex()


def attach_merkle(census):
    census["merkle"] = {
        "algorithm": "rfc6962-sha256",
        "leaf_order": "meta,nodes,edges",
        "leaf_count": 1 + len(census["nodes"]) + len(census["edges"]),
        "root_sha256": compute_root(census),
    }
    return census


def validate(census):
    """Structural + ordering validation. Returns a list of problem strings
    (empty list means valid). Does not require any third-party JSON Schema
    library — this mirrors schema/census.schema.json for the checks that
    matter for hashing integrity."""
    problems = []

    def err(msg):
        problems.append(msg)

    if census.get("census_format") != FORMAT_VERSION:
        err(f"census_format must be {FORMAT_VERSION!r}")

    ds = census.get("dataset", {})
    for field in ("id", "species", "common_name", "variant", "dataset_name",
                  "dataset_version", "modality", "citation", "license"):
        if not isinstance(ds.get(field), str) or not ds.get(field):
            err(f"dataset.{field} must be a non-empty string")
    if not isinstance(ds.get("source_urls"), list) or not ds.get("source_urls"):
        err("dataset.source_urls must be a non-empty list")

    nodes = census.get("nodes", [])
    edges = census.get("edges", [])
    if not nodes:
        err("nodes must be non-empty")
    if not edges:
        err("edges must be non-empty")

    ids = [n.get("id") for n in nodes]
    id_set = set(ids)
    if len(id_set) != len(ids):
        err("duplicate node ids")
    if ids != sorted(ids):
        err("nodes not sorted by id (bytewise)")
    for n in nodes:
        if n.get("kind") not in NODE_KINDS:
            err(f"node {n.get('id')}: bad kind {n.get('kind')!r}")
        if n.get("side") not in ("L", "R", None):
            err(f"node {n.get('id')}: bad side {n.get('side')!r}")
        cat = n.get("category")
        if cat is not None and (not isinstance(cat, str) or not cat):
            err(f"node {n.get('id')}: category must be a non-empty string or null")
        if cat is not None and n.get("kind") != "neuron":
            err(f"node {n.get('id')}: category set on non-neuron")

    keys = [(e.get("kind"), e.get("pre"), e.get("post")) for e in edges]
    if keys != sorted(keys):
        err("edges not sorted by (kind, pre, post) (bytewise)")
    if len(set(keys)) != len(keys):
        err("duplicate edges for the same (kind, pre, post)")
    for e in edges:
        if e.get("kind") not in EDGE_KINDS:
            err(f"edge {e.get('pre')}->{e.get('post')}: bad kind {e.get('kind')!r}")
        for endpoint in ("pre", "post"):
            if e.get(endpoint) not in id_set:
                err(f"edge references unknown node {e.get(endpoint)!r}")
        w = e.get("weight")
        if not isinstance(w, int) or isinstance(w, bool) or w < 1:
            err(f"edge {e.get('pre')}->{e.get('post')}: weight must be a positive integer")
        pol = e.get("polarity")
        if pol is not None and pol not in POLARITIES:
            err(f"edge {e.get('pre')}->{e.get('post')}: bad polarity {pol!r}")
        if e.get("kind") == "gap_junction" and not (e.get("pre") <= e.get("post")):
            err(f"gap junction {e.get('pre')}<->{e.get('post')}: must be stored with pre <= post")

    mk = census.get("merkle")
    if mk is not None:
        expected = 1 + len(nodes) + len(edges)
        if mk.get("leaf_count") != expected:
            err(f"merkle.leaf_count {mk.get('leaf_count')} != {expected}")

    return problems


def verify(census):
    """Returns (ok, recomputed_root_hex, problems)."""
    problems = validate(census)
    recomputed = compute_root(census)
    embedded = (census.get("merkle") or {}).get("root_sha256")
    ok = not problems and embedded == recomputed
    if embedded != recomputed:
        problems = problems + [
            f"merkle root mismatch: embedded={embedded} recomputed={recomputed}"
        ]
    return ok, recomputed, problems


def pack_cbg0(census):
    """Deterministic compact binary graph (CBG0) — see docs/SCHEMA.md appendix."""
    problems = validate(census)
    if problems:
        raise ValueError("cannot pack invalid CCF: " + "; ".join(problems[:5]))
    root = bytes.fromhex(census["merkle"]["root_sha256"])
    nodes = census["nodes"]
    edges = census["edges"]
    index = {n["id"]: i for i, n in enumerate(nodes)}
    if len(nodes) > 0xFFFF:
        raise ValueError("CBG0 supports at most 65535 nodes (Tier A only)")
    kind_code = {k: i for i, k in enumerate(NODE_KINDS)}  # CBG0 kind codes follow NODE_KINDS order
    edge_kind_code = {k: i for i, k in enumerate(EDGE_KINDS)}

    out = bytearray()
    out += b"CBG0"
    out += root
    out += len(nodes).to_bytes(4, "little")
    out += len(edges).to_bytes(4, "little")
    for n in nodes:
        ident = n["id"].encode("ascii")
        if len(ident) > 255:
            raise ValueError(f"node id too long: {n['id']}")
        out += bytes([len(ident)]) + ident + bytes([kind_code[n["kind"]]])
    for e in edges:
        out += index[e["pre"]].to_bytes(2, "little")
        out += index[e["post"]].to_bytes(2, "little")
        out += bytes([edge_kind_code[e["kind"]]])
        out += e["weight"].to_bytes(4, "little")
    return bytes(out)
