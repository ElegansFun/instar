#!/bin/bash
# Program keypair + local operator wallet bootstrap for the Anchor workspace.
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-program-keys.sh
# The program keypair is the program's identity on every cluster, so it lives in
# .keys/ (gitignored, kept by the human) and is copied into target/deploy where
# anchor expects it. `anchor clean` cannot lose it that way. The operator key
# is the [provider] wallet of Anchor.toml and the world process's operator on
# localnet.
#
# The keypair MUST match the id compiled into the program (`declare_id!` in
# program/programs/instar/src/lib.rs). A fresh clone without .keys/ must not
# silently mint a new identity: local runs would pass (the validator preloads
# the .so at the declared id) and a public deploy would then publish the
# program at the wrong address, costing the deploy rent to unwind.
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
ROOT=/mnt/c/tech/connectomes
KEEP="$ROOT/.keys/instar-program.json"
DEPLOY="$ROOT/program/target/deploy/instar-keypair.json"
DECLARED="$(sed -nE 's/^declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\);/\1/p' "$ROOT/program/programs/instar/src/lib.rs")"
test -n "$DECLARED" || { echo "could not read declare_id! from lib.rs" >&2; exit 1; }
mkdir -p "$ROOT/.keys" "$ROOT/program/target/deploy"
if [ ! -f "$KEEP" ]; then
  cat >&2 <<EOF
no program keypair at $KEEP
The program is compiled with id $DECLARED; restore the keypair for that id
from your backup. To start a NEW program identity instead (a fresh id, never
deployed anywhere): run
  solana-keygen new --no-bip39-passphrase -s -o $KEEP
and then set declare_id! in program/programs/instar/src/lib.rs and every
[programs.*] entry in program/Anchor.toml to its pubkey before building.
EOF
  exit 1
fi
ACTUAL="$(solana-keygen pubkey "$KEEP")"
if [ "$ACTUAL" != "$DECLARED" ]; then
  echo "program keypair $KEEP is $ACTUAL but the program declares $DECLARED; fix one of them" >&2
  exit 1
fi
cp "$KEEP" "$DEPLOY"
if [ ! -f "$ROOT/.keys/operator.json" ]; then
  solana-keygen new --no-bip39-passphrase -s -o "$ROOT/.keys/operator.json" >/dev/null
fi
echo "program id: $ACTUAL"
echo "operator:   $(solana-keygen pubkey "$ROOT/.keys/operator.json")"
