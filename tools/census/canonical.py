"""Canonical serialization, Merkle construction (RFC 6962 / SHA-256), CBG0
packing and CCF v0.2 validation. Normative behavior is specified in
docs/SCHEMA.md. Standard library only: `verify` must run on a bare Python."""

import hashlib
import io
import json
import struct

from . import FORMAT_VERSION

NODE_KINDS = ("neuron", "muscle", "glia", "epithelial", "gland", "end_organ", "other")
EDGE_KINDS = ("chemical", "gap_junction")
SIDES = ("L", "R", "M")
NODE_FIELDS = ("id", "kind", "source_type", "side", "category")
EDGE_FIELDS = ("pre", "post", "kind", "weight")

CBG0_MAGIC = b"CBG0"
CBG0_HEADER = struct.Struct("<4s32sII")   # magic, root, node_count, edge_count
CBG0_EDGE = struct.Struct("<IIBI")        # pre_index, post_index, kind, weight


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


class MerkleAccumulator:
    """Streaming RFC 6962 tree: O(log n) memory. Leaves are pushed in order;
    complete power-of-two subtrees are folded eagerly, and the remaining
    subtrees are folded right-to-left at the end, which is exactly the
    largest-power-of-two-below-n split of RFC 6962."""

    __slots__ = ("_stack", "count")

    def __init__(self):
        self._stack = []   # list of (level, hash), levels strictly decreasing
        self.count = 0

    def add(self, leaf_bytes):
        self.add_hash(_leaf_hash(leaf_bytes))

    def add_hash(self, h):
        stack = self._stack
        level = 0
        while stack and stack[-1][0] == level:
            h = _interior_hash(stack.pop()[1], h)
            level += 1
        stack.append((level, h))
        self.count += 1

    def root(self):
        if not self._stack:
            raise ValueError("empty tree")
        stack = self._stack
        h = stack[-1][1]
        for i in range(len(stack) - 2, -1, -1):
            h = _interior_hash(stack[i][1], h)
        return h


def merkle_root(leaves):
    """RFC 6962 Merkle tree root over an iterable of leaf byte-strings."""
    acc = MerkleAccumulator()
    for leaf in leaves:
        acc.add(leaf)
    return acc.root()


def meta_leaf(census):
    """The first leaf: format, dataset and provenance blocks. `census` may be
    a full in-memory CCF or the split-layout header; both carry the keys."""
    return canon_bytes({
        "t": "meta",
        "v": {
            "census_format": census["census_format"],
            "dataset": census["dataset"],
            "provenance": census["provenance"],
        },
    })


def node_leaf(node):
    return canon_bytes({"t": "node", "v": node})


def _plain_id(ident):
    """Node ids are ASCII without characters that JSON would escape, so
    edge leaves can be formatted without a JSON encoder."""
    if not isinstance(ident, str) or not ident.isascii() or not ident.isprintable() \
            or '"' in ident or "\\" in ident:
        raise ValueError(f"node id must be printable ASCII without quote/backslash: {ident!r}")
    return ident


def edge_leaf(pre, post, kind, weight):
    """canon({"t":"edge","v":{pre,post,kind,weight}}) with keys in sorted
    order; equal to canon_bytes of the record for valid ids (see tests)."""
    if kind not in EDGE_KINDS:
        raise ValueError(f"bad edge kind {kind!r}")
    return b'{"t":"edge","v":{"kind":"%s","post":"%s","pre":"%s","weight":%d}}' % (
        kind.encode("ascii"), _plain_id(post).encode("ascii"), _plain_id(pre).encode("ascii"), weight)


def leaves_for(census):
    yield meta_leaf(census)
    for n in census["nodes"]:
        yield node_leaf(n)
    for e in census["edges"]:
        yield edge_leaf(e["pre"], e["post"], e["kind"], e["weight"])


def compute_root(census):
    return merkle_root(leaves_for(census)).hex()


def merkle_block(leaf_count, root_hex):
    return {
        "algorithm": "rfc6962-sha256",
        "leaf_order": "meta,nodes,edges",
        "leaf_count": leaf_count,
        "root_sha256": root_hex,
    }


def attach_merkle(census):
    census["merkle"] = merkle_block(
        1 + len(census["nodes"]) + len(census["edges"]), compute_root(census))
    return census


def validate_dataset(census, err):
    if census.get("census_format") != FORMAT_VERSION:
        err(f"census_format must be {FORMAT_VERSION!r}")
    ds = census.get("dataset", {})
    for field in ("id", "species", "common_name", "variant", "dataset_name",
                  "dataset_version", "modality", "citation", "license"):
        if not isinstance(ds.get(field), str) or not ds.get(field):
            err(f"dataset.{field} must be a non-empty string")
    if not isinstance(ds.get("source_urls"), list) or not ds.get("source_urls"):
        err("dataset.source_urls must be a non-empty list")


def validate_nodes(nodes, err):
    """Node-record checks shared by the in-memory and split layouts.
    Returns the list of ids (in file order)."""
    if not nodes:
        err("nodes must be non-empty")
    ids = [n.get("id") for n in nodes]
    if len(set(ids)) != len(ids):
        err("duplicate node ids")
    if ids != sorted(ids):
        err("nodes not sorted by id (bytewise)")
    for n in nodes:
        if tuple(sorted(n.keys())) != tuple(sorted(NODE_FIELDS)):
            err(f"node {n.get('id')}: fields must be exactly {NODE_FIELDS}")
        try:
            _plain_id(n.get("id"))
        except ValueError as e:
            err(str(e))
        if n.get("kind") not in NODE_KINDS:
            err(f"node {n.get('id')}: bad kind {n.get('kind')!r}")
        if n.get("side") not in SIDES and n.get("side") is not None:
            err(f"node {n.get('id')}: bad side {n.get('side')!r}")
        st = n.get("source_type")
        if st is not None and (not isinstance(st, str) or not st):
            err(f"node {n.get('id')}: source_type must be a non-empty string or null")
        cat = n.get("category")
        if cat is not None and (not isinstance(cat, str) or not cat):
            err(f"node {n.get('id')}: category must be a non-empty string or null")
        if cat is not None and n.get("kind") != "neuron":
            err(f"node {n.get('id')}: category set on non-neuron")
    return ids


def validate(census):
    """Structural + ordering validation of an in-memory CCF. Returns a list
    of problem strings (empty list means valid)."""
    problems = []

    def err(msg):
        problems.append(msg)

    validate_dataset(census, err)
    nodes = census.get("nodes", [])
    edges = census.get("edges", [])
    id_set = set(validate_nodes(nodes, err))
    if not edges:
        err("edges must be non-empty")

    keys = [(e.get("kind"), e.get("pre"), e.get("post")) for e in edges]
    if keys != sorted(keys):
        err("edges not sorted by (kind, pre, post) (bytewise)")
    if len(set(keys)) != len(keys):
        err("duplicate edges for the same (kind, pre, post)")
    for e in edges:
        if tuple(sorted(e.keys())) != tuple(sorted(EDGE_FIELDS)):
            err(f"edge {e.get('pre')}->{e.get('post')}: fields must be exactly {EDGE_FIELDS}")
        if e.get("kind") not in EDGE_KINDS:
            err(f"edge {e.get('pre')}->{e.get('post')}: bad kind {e.get('kind')!r}")
        for endpoint in ("pre", "post"):
            if e.get(endpoint) not in id_set:
                err(f"edge references unknown node {e.get(endpoint)!r}")
        w = e.get("weight")
        if not isinstance(w, int) or isinstance(w, bool) or w < 1:
            err(f"edge {e.get('pre')}->{e.get('post')}: weight must be a positive integer")
        if e.get("kind") == "gap_junction" and not (e.get("pre") <= e.get("post")):
            err(f"gap junction {e.get('pre')}<->{e.get('post')}: must be stored with pre <= post")

    mk = census.get("merkle")
    if mk is not None:
        expected = 1 + len(nodes) + len(edges)
        if mk.get("leaf_count") != expected:
            err(f"merkle.leaf_count {mk.get('leaf_count')} != {expected}")
    return problems


def verify(census):
    """In-memory CCF: returns (ok, recomputed_root_hex, problems)."""
    problems = validate(census)
    recomputed = compute_root(census)
    embedded = (census.get("merkle") or {}).get("root_sha256")
    ok = not problems and embedded == recomputed
    if embedded != recomputed:
        problems = problems + [
            f"merkle root mismatch: embedded={embedded} recomputed={recomputed}"
        ]
    return ok, recomputed, problems


# ---------------------------------------------------------------- CBG0 ----

def write_cbg0(fp, root_hex, nodes, edges, edge_count):
    """Stream a CBG0 blob: `nodes` is the canonical node list (id, kind
    needed), `edges` yields (pre_index, post_index, kind_code, weight) in
    canonical order. Little-endian; see docs/SCHEMA.md appendix."""
    fp.write(CBG0_HEADER.pack(CBG0_MAGIC, bytes.fromhex(root_hex), len(nodes), edge_count))
    kind_code = {k: i for i, k in enumerate(NODE_KINDS)}
    buf = bytearray()
    for n in nodes:
        ident = _plain_id(n["id"]).encode("ascii")
        if len(ident) > 255:
            raise ValueError(f"node id too long: {n['id']}")
        buf += bytes([len(ident)]) + ident + bytes([kind_code[n["kind"]]])
    fp.write(buf)
    pack = CBG0_EDGE.pack
    buf = bytearray()
    written = 0
    for pre, post, kind, weight in edges:
        buf += pack(pre, post, kind, weight)
        written += 1
        if len(buf) >= (1 << 20):
            fp.write(buf)
            buf = bytearray()
    fp.write(buf)
    if written != edge_count:
        raise ValueError(f"edge iterator produced {written} edges, header says {edge_count}")


def pack_cbg0(census):
    """CBG0 bytes for a valid in-memory CCF (merkle attached)."""
    problems = validate(census)
    if problems:
        raise ValueError("cannot pack invalid CCF: " + "; ".join(problems[:5]))
    nodes = census["nodes"]
    index = {n["id"]: i for i, n in enumerate(nodes)}
    edge_kind_code = {k: i for i, k in enumerate(EDGE_KINDS)}
    edges = ((index[e["pre"]], index[e["post"]], edge_kind_code[e["kind"]], e["weight"])
             for e in census["edges"])
    out = io.BytesIO()
    write_cbg0(out, census["merkle"]["root_sha256"], nodes, edges, len(census["edges"]))
    return out.getvalue()


def read_cbg0(blob):
    """Parse a CBG0 blob. Returns (root_hex, node_table, edges) where
    node_table is a list of (id, kind) and edges is an iterator of
    (pre_index, post_index, kind, weight)."""
    magic, root, node_count, edge_count = CBG0_HEADER.unpack_from(blob, 0)
    if magic != CBG0_MAGIC:
        raise ValueError("not a CBG0 blob")
    off = CBG0_HEADER.size
    node_table = []
    for _ in range(node_count):
        n = blob[off]
        ident = blob[off + 1:off + 1 + n].decode("ascii")
        kind_code = blob[off + 1 + n]
        if kind_code >= len(NODE_KINDS):
            raise ValueError(f"bad node kind code {kind_code} for node {ident}")
        node_table.append((ident, NODE_KINDS[kind_code]))
        off += 2 + n
    expected = off + edge_count * CBG0_EDGE.size
    if len(blob) != expected:
        raise ValueError(f"CBG0 size {len(blob)} != expected {expected} for {edge_count} edges")
    return root.hex(), node_table, CBG0_EDGE.iter_unpack(memoryview(blob)[off:])


def verify_split(header, nodes_doc, blob):
    """Split layout (header JSON + nodes.json + CBG0): validate and recompute
    the root over meta, node records and CBG0 edges. Returns
    (ok, recomputed_root_hex, problems)."""
    problems = []

    def err(msg):
        problems.append(msg)

    validate_dataset(header, err)
    nodes = nodes_doc.get("nodes", [])
    ids = validate_nodes(nodes, err)
    if nodes_doc.get("census_format") != header.get("census_format"):
        err("nodes.json census_format differs from header")
    if nodes_doc.get("dataset_id") != header.get("dataset", {}).get("id"):
        err("nodes.json dataset_id differs from header dataset.id")
    if nodes_doc.get("node_count") != len(nodes):
        err(f"nodes.json node_count {nodes_doc.get('node_count')} != {len(nodes)}")
    if header.get("node_count") != len(nodes):
        err(f"header node_count {header.get('node_count')} != {len(nodes)} nodes in nodes.json")

    embedded = (header.get("merkle") or {}).get("root_sha256")
    if nodes_doc.get("root_sha256") != embedded:
        err("nodes.json root_sha256 differs from header merkle root")

    try:
        blob_root, node_table, edge_iter = read_cbg0(blob)
    except ValueError as e:
        err(f"CBG0: {e}")
        return False, None, problems
    if blob_root != embedded:
        err(f"CBG0 embedded root {blob_root} != header root {embedded}")
    if [t[0] for t in node_table] != ids:
        err("CBG0 node table ids differ from nodes.json")
    if [t[1] for t in node_table] != [n.get("kind") for n in nodes]:
        err("CBG0 node table kinds differ from nodes.json")

    acc = MerkleAccumulator()
    acc.add(meta_leaf(header))
    for n in nodes:
        acc.add(node_leaf(n))

    n_nodes = len(ids)
    edge_count = 0
    last = (-1, -1)
    for pre, post, kind, weight in edge_iter:
        edge_count += 1
        if kind >= len(EDGE_KINDS):
            err(f"edge #{edge_count}: bad kind code {kind}")
            continue
        if pre >= n_nodes or post >= n_nodes:
            err(f"edge #{edge_count}: index out of range ({pre}, {post})")
            continue
        if weight < 1:
            err(f"edge #{edge_count}: weight must be positive")
        if kind != 0:
            err(f"edge #{edge_count}: split layout supports chemical edges only")
        if (pre, post) <= last:
            err(f"edge #{edge_count}: edges not sorted by (pre_index, post_index) or duplicated")
        last = (pre, post)
        acc.add(edge_leaf(ids[pre], ids[post], EDGE_KINDS[kind], weight))
        if len(problems) > 20:
            break
    if edge_count == 0:
        err("edges must be non-empty")
    if header.get("edge_count") != edge_count:
        err(f"header edge_count {header.get('edge_count')} != {edge_count} edges in CBG0")
    leaf_count = 1 + n_nodes + edge_count
    if (header.get("merkle") or {}).get("leaf_count") != leaf_count:
        err(f"merkle.leaf_count {(header.get('merkle') or {}).get('leaf_count')} != {leaf_count}")

    recomputed = acc.root().hex()
    if recomputed != embedded:
        err(f"merkle root mismatch: embedded={embedded} recomputed={recomputed}")
    return not problems, recomputed, problems
