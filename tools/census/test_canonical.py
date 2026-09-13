"""Unit tests for the canonical serialization + Merkle layer.
Run: python -m unittest tools.census.test_canonical -v"""

import hashlib
import json
import unittest

from . import canonical


def h(data):
    return hashlib.sha256(data).digest()


class TestCanonBytes(unittest.TestCase):
    def test_sorted_keys_and_separators(self):
        self.assertEqual(
            canonical.canon_bytes({"b": 1, "a": [True, None, "x"]}),
            b'{"a":[true,null,"x"],"b":1}',
        )

    def test_floats_rejected(self):
        with self.assertRaises(ValueError):
            canonical.canon_bytes({"a": 1.0})
        with self.assertRaises(ValueError):
            canonical.canon_bytes([{"a": [0.0]}])

    def test_utf8_literal(self):
        # non-ASCII appears as literal UTF-8, not \u escapes
        self.assertEqual(canonical.canon_bytes({"n": "élan"}), '{"n":"élan"}'.encode("utf-8"))

    def test_edge_leaf_matches_generic_canonicalization(self):
        rec = {"pre": "10", "post": "9", "kind": "chemical", "weight": 12}
        self.assertEqual(canonical.edge_leaf("10", "9", "chemical", 12),
                         canonical.canon_bytes({"t": "edge", "v": rec}))

    def test_edge_leaf_rejects_ids_that_need_escaping(self):
        with self.assertRaises(ValueError):
            canonical.edge_leaf('a"b', "c", "chemical", 1)


class TestMerkle(unittest.TestCase):
    def test_single_leaf(self):
        # MTH([x]) = SHA256(0x00 || x)
        self.assertEqual(canonical.merkle_root([b"abc"]), h(b"\x00abc"))

    def test_two_leaves_manual(self):
        left, right = h(b"\x00" + b"a"), h(b"\x00" + b"b")
        self.assertEqual(canonical.merkle_root([b"a", b"b"]), h(b"\x01" + left + right))

    def test_three_leaves_rfc6962_split(self):
        # n=3 -> k=2: root = interior(MTH(l0,l1), leafhash(l2))
        l0, l1, l2 = h(b"\x00a"), h(b"\x00b"), h(b"\x00c")
        left = h(b"\x01" + l0 + l1)
        self.assertEqual(canonical.merkle_root([b"a", b"b", b"c"]), h(b"\x01" + left + l2))

    def test_six_leaves_rfc6962_split(self):
        # n=6 -> k=4: root = interior(MTH(first 4), MTH(last 2))
        leaves = [b"a", b"b", b"c", b"d", b"e", b"f"]
        lh = [h(b"\x00" + x) for x in leaves]
        n01, n23, n45 = (h(b"\x01" + lh[0] + lh[1]), h(b"\x01" + lh[2] + lh[3]),
                         h(b"\x01" + lh[4] + lh[5]))
        left = h(b"\x01" + n01 + n23)
        self.assertEqual(canonical.merkle_root(leaves), h(b"\x01" + left + n45))

    def test_streaming_equals_recursive_definition(self):
        # the accumulator must reproduce the recursive RFC 6962 split for every n
        def mth(hs):
            if len(hs) == 1:
                return hs[0]
            k = 1
            while k * 2 < len(hs):
                k *= 2
            return h(b"\x01" + mth(hs[:k]) + mth(hs[k:]))

        for n in range(1, 40):
            leaves = [bytes([i]) for i in range(n)]
            self.assertEqual(canonical.merkle_root(leaves), mth([h(b"\x00" + x) for x in leaves]), n)

    def test_empty_rejected(self):
        with self.assertRaises(ValueError):
            canonical.merkle_root([])


def _tiny_census():
    return {
        "census_format": "0.2.0",
        "dataset": {
            "id": "test-tiny",
            "species": "Testus exemplum",
            "common_name": "test",
            "variant": "unit",
            "dataset_name": "synthetic unit-test fixture (never registered)",
            "dataset_version": "0",
            "modality": "none",
            "citation": "none",
            "license": "none",
            "source_urls": ["about:blank"],
        },
        "nodes": [
            {"id": "A", "kind": "neuron", "source_type": "sensory", "side": "L",
             "category": "superclass=cb_sensory;type=ORN_DA1"},
            {"id": "B", "kind": "muscle", "source_type": None, "side": None, "category": None},
        ],
        "edges": [
            {"pre": "A", "post": "B", "kind": "chemical", "weight": 3},
            {"pre": "A", "post": "B", "kind": "gap_junction", "weight": 1},
        ],
        "provenance": {"converter": "test", "converted_from": [
            {"filename": "none", "sha256": "0" * 64, "url": "about:blank", "role": "fixture"}
        ], "notes": []},
    }


class TestCensusValidation(unittest.TestCase):
    def test_valid_fixture(self):
        c = canonical.attach_merkle(_tiny_census())
        ok, _, problems = canonical.verify(c)
        self.assertEqual(problems, [])
        self.assertTrue(ok)

    def test_root_changes_with_weight(self):
        a = canonical.attach_merkle(_tiny_census())
        b = _tiny_census()
        b["edges"][0]["weight"] = 4
        b = canonical.attach_merkle(b)
        self.assertNotEqual(a["merkle"]["root_sha256"], b["merkle"]["root_sha256"])

    def test_unsorted_edges_flagged(self):
        c = _tiny_census()
        c["edges"].reverse()  # gap_junction before chemical -> out of order
        c = canonical.attach_merkle(c)
        _, _, problems = canonical.verify(c)
        self.assertTrue(any("not sorted" in p for p in problems))

    def test_gap_junction_ordering_flagged(self):
        c = _tiny_census()
        c["edges"][1] = {"pre": "B", "post": "A", "kind": "gap_junction", "weight": 1}
        c = canonical.attach_merkle(c)
        _, _, problems = canonical.verify(c)
        self.assertTrue(any("pre <= post" in p for p in problems))

    def test_side_vocabulary(self):
        c = _tiny_census()
        c["nodes"][1]["side"] = "M"
        self.assertEqual(canonical.validate(c), [])
        c["nodes"][1]["side"] = "left"
        self.assertTrue(any("bad side" in p for p in canonical.validate(c)))

    def test_category_free_string_on_neurons_only(self):
        c = canonical.attach_merkle(_tiny_census())
        self.assertEqual(canonical.validate(c), [])
        c["nodes"][0]["category"] = ""
        self.assertTrue(any("category" in p for p in canonical.validate(c)))
        c["nodes"][0]["category"] = "superclass=cb_sensory"
        c["nodes"][1]["category"] = "superclass=ENS"  # node B is a muscle
        self.assertTrue(any("non-neuron" in p for p in canonical.validate(c)))

    def test_extra_node_field_flagged(self):
        c = _tiny_census()
        c["nodes"][0]["neurotransmitter"] = None
        self.assertTrue(any("fields must be exactly" in p for p in canonical.validate(c)))

    def test_root_changes_with_category(self):
        a = canonical.attach_merkle(_tiny_census())
        b = _tiny_census()
        b["nodes"][0]["category"] = None
        b = canonical.attach_merkle(b)
        self.assertNotEqual(a["merkle"]["root_sha256"], b["merkle"]["root_sha256"])

    def test_tampered_root_fails(self):
        c = canonical.attach_merkle(_tiny_census())
        c["merkle"]["root_sha256"] = "0" * 64
        ok, _, problems = canonical.verify(c)
        self.assertFalse(ok)
        self.assertTrue(any("mismatch" in p for p in problems))


class TestPack(unittest.TestCase):
    def test_cbg0_layout(self):
        c = canonical.attach_merkle(_tiny_census())
        blob = canonical.pack_cbg0(c)
        self.assertEqual(blob[:4], b"CBG0")
        self.assertEqual(blob[4:36], bytes.fromhex(c["merkle"]["root_sha256"]))
        self.assertEqual(int.from_bytes(blob[36:40], "little"), 2)  # nodes
        self.assertEqual(int.from_bytes(blob[40:44], "little"), 2)  # edges
        # node table: len 'A' kind, len 'B' kind
        self.assertEqual(blob[44:47], bytes([1]) + b"A" + bytes([0]))
        self.assertEqual(blob[47:50], bytes([1]) + b"B" + bytes([1]))
        # first edge: u32 pre=0, u32 post=1, u8 kind=0 (chemical), u32 weight=3
        e0 = blob[50:63]
        self.assertEqual(int.from_bytes(e0[0:4], "little"), 0)
        self.assertEqual(int.from_bytes(e0[4:8], "little"), 1)
        self.assertEqual(e0[8], 0)
        self.assertEqual(int.from_bytes(e0[9:13], "little"), 3)
        self.assertEqual(len(blob), 63 + 13)

    def test_read_roundtrip(self):
        c = canonical.attach_merkle(_tiny_census())
        root, table, edges = canonical.read_cbg0(canonical.pack_cbg0(c))
        self.assertEqual(root, c["merkle"]["root_sha256"])
        self.assertEqual(table, [("A", "neuron"), ("B", "muscle")])
        self.assertEqual(list(edges), [(0, 1, 0, 3), (0, 1, 1, 1)])


def _split_fixture():
    """Split layout (header + nodes.json + CBG0) with chemical edges only,
    built from the in-memory fixture so both layouts must agree on the root."""
    c = _tiny_census()
    c["nodes"].append({"id": "C", "kind": "neuron", "source_type": None, "side": "R",
                       "category": "superclass=descending_neuron"})
    c["edges"] = [
        {"pre": "A", "post": "B", "kind": "chemical", "weight": 3},
        {"pre": "A", "post": "C", "kind": "chemical", "weight": 7},
        {"pre": "C", "post": "A", "kind": "chemical", "weight": 5},
    ]
    canonical.attach_merkle(c)
    header = {k: c[k] for k in ("census_format", "dataset", "provenance", "merkle")}
    header["files"] = {"graph": "x.cbg", "nodes": "x.nodes.json"}
    header["node_count"] = len(c["nodes"])
    header["edge_count"] = len(c["edges"])
    nodes_doc = {"census_format": c["census_format"], "dataset_id": c["dataset"]["id"],
                 "root_sha256": c["merkle"]["root_sha256"], "node_count": len(c["nodes"]),
                 "nodes": json.loads(json.dumps(c["nodes"]))}
    return c, header, nodes_doc, canonical.pack_cbg0(c)


class TestSplitVerify(unittest.TestCase):
    def test_split_root_equals_in_memory_root(self):
        c, header, nodes_doc, blob = _split_fixture()
        ok, root, problems = canonical.verify_split(header, nodes_doc, blob)
        self.assertEqual(problems, [])
        self.assertTrue(ok)
        self.assertEqual(root, canonical.compute_root(c))

    def test_tampered_weight_in_blob_detected(self):
        _, header, nodes_doc, blob = _split_fixture()
        blob = bytearray(blob)
        blob[-1] ^= 1  # last byte of the last edge's weight
        ok, _, problems = canonical.verify_split(header, nodes_doc, bytes(blob))
        self.assertFalse(ok)
        self.assertTrue(any("mismatch" in p for p in problems))

    def test_tampered_node_record_detected(self):
        _, header, nodes_doc, blob = _split_fixture()
        nodes_doc["nodes"][2]["side"] = "L"
        ok, _, problems = canonical.verify_split(header, nodes_doc, blob)
        self.assertFalse(ok)
        self.assertTrue(any("mismatch" in p for p in problems))

    def test_unsorted_edges_in_blob_flagged(self):
        c, header, nodes_doc, blob = _split_fixture()
        c["edges"][1], c["edges"][2] = c["edges"][2], c["edges"][1]
        out = __import__("io").BytesIO()
        index = {n["id"]: i for i, n in enumerate(c["nodes"])}
        canonical.write_cbg0(out, c["merkle"]["root_sha256"], c["nodes"],
                             ((index[e["pre"]], index[e["post"]], 0, e["weight"]) for e in c["edges"]),
                             len(c["edges"]))
        ok, _, problems = canonical.verify_split(header, nodes_doc, out.getvalue())
        self.assertFalse(ok)
        self.assertTrue(any("not sorted" in p for p in problems))

    def test_node_table_mismatch_flagged(self):
        _, header, nodes_doc, blob = _split_fixture()
        nodes_doc["nodes"][1]["id"] = "BB"
        ok, _, problems = canonical.verify_split(header, nodes_doc, blob)
        self.assertFalse(ok)
        self.assertTrue(any("node table ids differ" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
