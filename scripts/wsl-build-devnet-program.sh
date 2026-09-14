#!/bin/bash
# Build and deploy the program under a THROWAWAY devnet identity without
# touching the mainnet identity in the repo: swap declare_id!/Anchor.toml and
# the deploy keypair to .keys/instar-program.devnet.json, build (real timers),
# deploy to devnet with the operator, publish the IDL, then restore the mainnet
# id in the source and rebuild so target/ and services/chain/idl are mainnet
# again. The devnet IDL is kept at services/chain/idl/instar.devnet.json.
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-build-devnet-program.sh <rpc-url>
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
ROOT=/mnt/c/tech/connectomes
RPC="$1"; test -n "$RPC" || { echo "rpc url required" >&2; exit 1; }
DEV="$ROOT/.keys/instar-program.devnet.json"
MAIN="$ROOT/.keys/instar-program.json"
OPERATOR="$ROOT/.keys/mainnet/operator.json"
LIB="$ROOT/program/programs/instar/src/lib.rs"
TOML="$ROOT/program/Anchor.toml"
DEV_ID="$(solana-keygen pubkey "$DEV")"
MAIN_ID="$(solana-keygen pubkey "$MAIN")"
cd "$ROOT/program"

swap_id() { sed -i "s/$1/$2/g" "$LIB" "$TOML"; }
restore() {
  swap_id "$DEV_ID" "$MAIN_ID"
  cp "$MAIN" target/deploy/instar-keypair.json
  echo "== restoring the mainnet artifact =="
  cargo build-sbf --arch v3 >/dev/null 2>&1
  anchor idl build -o target/idl/instar.json -t target/types/instar.ts >/dev/null 2>&1
  echo default > target/deploy/instar.features
  cp target/idl/instar.json "$ROOT/services/chain/idl/instar.json"
  cp target/types/instar.ts "$ROOT/services/chain/idl/instar.ts"
  echo "mainnet id restored: $(grep -o 'declare_id!("[^"]*")' "$LIB")"
}
trap restore EXIT

swap_id "$MAIN_ID" "$DEV_ID"
cp "$DEV" target/deploy/instar-keypair.json
echo "== building for devnet id $DEV_ID =="
cargo build-sbf --arch v3 2>&1 | grep -E "error|warning: unused" || true
anchor idl build -o target/idl/instar.json -t target/types/instar.ts
cp target/idl/instar.json "$ROOT/services/chain/idl/instar.devnet.json"
echo "== deploying to devnet =="
solana program close --buffers --url "$RPC" --keypair "$OPERATOR" --recipient "$(solana-keygen pubkey "$OPERATOR")" 2>/dev/null || true
solana program deploy --url "$RPC" --keypair "$OPERATOR" --program-id "$DEV" --upgrade-authority "$OPERATOR" \
  --use-rpc --max-sign-attempts 200 --with-compute-unit-price 20000 target/deploy/instar.so
deployed_slot="$(solana program show "$DEV_ID" --url "$RPC" | awk '/Last Deployed In Slot/ {print $5}')"
until [ "$(solana slot --url "$RPC")" -gt "$deployed_slot" ]; do sleep 1; done
anchor idl init "$DEV_ID" -f target/idl/instar.json --provider.cluster "$RPC" --provider.wallet "$OPERATOR" || \
anchor idl upgrade "$DEV_ID" -f target/idl/instar.json --provider.cluster "$RPC" --provider.wallet "$OPERATOR"
echo "DEVNET_PROGRAM_DEPLOY_OK $DEV_ID"
