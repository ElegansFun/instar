"""Census converter + verifier. Verification is Python standard library only,
by design: anyone can re-verify a registered Merkle root with a bare Python
install. Only the MaleCNS converter needs pyarrow (feather input)."""

CONVERTER_VERSION = "census-converter/0.2.0"
FORMAT_VERSION = "0.2.0"
