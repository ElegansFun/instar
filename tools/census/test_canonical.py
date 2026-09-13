"""Unit tests for the canonical serialization + Merkle layer.
Run: python -m unittest tools.census.test_canonical -v"""

import hashlib
import unittest

from . import canonical


def h(data):
    return hashlib.sha256(data).digest()


class TestCanonBytes(unittest.TestCase):
    def test_sorted_keys_and_separators(self):
        self.assertEqual(
            canonical.canon_bytes({"b": 1, "a": [None, True, "x"]}),
            b'{"a":[null,true,"x"],"b":1}',
        )

    def test_floats_rejected(self):
        with self.assertRaises(ValueError):
            canonical.canon_bytes({"w": 1.5})
        with self.assertRaises(ValueError):
            canonical.canon_bytes([{"a": [0.0]}])

    def test_utf8_literal(self):
        # non-ASCII appears as literal UTF-8, not \u escapes
        self.assertEqual(canonical.canon_bytes({"n": "élan"}), '{"n":"élan"}'.encode("utf-8"))


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
        n01 = h(b"\x01" + lh[0] + lh[1])
        n23 = h(b"\x01" + lh[2] + lh[3])
        n45 = h(b"\x01" + lh[4] + lh[5])
        left = h(b"\x01" + n01 + n23)
        self.assertEqual(canonical.merkle_root(leaves), h(b"\x01" + left + n45))

    def test_empty_rejected(self):
        with self.assertRaises(ValueError):
            canonical.merkle_root([])


def _tiny_census():
    return {
        "census_format": "0.1.0",
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
            {"id": "A", "kind": "neuron", "source_type": "sensory", "cell_class": None,
             "side": "L", "category": "olfactory", "neurotransmitter": None},
            {"id": "B", "kind": "muscle", "source_type": None, "cell_class": None,
             "side": None, "category": None, "neurotransmitter": None},
        ],
        "edges": [
            {"pre": "A", "post": "B", "kind": "chemical", "weight": 3, "polarity": None},
            {"pre": "A", "post": "B", "kind": "gap_junction", "weight": 1, "polarity": None},
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
        c["edges"][1] = {"pre": "B", "post": "A", "kind": "gap_junction",
                         "weight": 1, "polarity": None}
        c = canonical.attach_merkle(c)
        _, _, problems = canonical.verify(c)
        self.assertTrue(any("pre <= post" in p for p in problems))

    def test_category_free_string_on_neurons_only(self):
        # category is the source's own modality string, not a fixed vocabulary
        c = canonical.attach_merkle(_tiny_census())
        self.assertEqual(canonical.validate(c), [])
        c["nodes"][0]["category"] = ""
        self.assertTrue(any("category" in p for p in canonical.validate(c)))
        c["nodes"][0]["category"] = "olfactory"
        c["nodes"][1]["category"] = "gut"  # node B is a muscle
        self.assertTrue(any("non-neuron" in p for p in canonical.validate(c)))

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
        # first edge: pre=0 post=1 kind=0(chemical) weight=3
        e0 = blob[50:59]
        self.assertEqual(int.from_bytes(e0[0:2], "little"), 0)
        self.assertEqual(int.from_bytes(e0[2:4], "little"), 1)
        self.assertEqual(e0[4], 0)
        self.assertEqual(int.from_bytes(e0[5:9], "little"), 3)
        self.assertEqual(len(blob), 59 + 9)


if __name__ == "__main__":
    unittest.main()
