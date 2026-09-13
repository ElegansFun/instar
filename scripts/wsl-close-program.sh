#!/bin/bash
# The last step of the world's end: close the program itself and send its
# rent (the program-data account, about 4.8 SOL for this artifact) to the
# recovery address. FINAL: the program id can never be deployed to again.
#   bash wsl-close-program.sh <cluster> <recovery> [rpc-url] [deployer-keypair (WSL path)]
# scripts/operator.mts recover-all prints the exact invocation once the World
# PDA is closed; this script refuses while it still exists, because a closed
# program leaves every account it owns unreadable and unclosable.
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
ROOT=/mnt/c/tech/connectomes
CLUSTER="$1"; RECOVERY="$2"; RPC="${3:-}"; DEPLOYER="${4:-$ROOT/.keys/operator.json}"
case "$CLUSTER" in
  localnet) RPC="${RPC:-http://127.0.0.1:8899}" ;;
  devnet) RPC="${RPC:-https://api.devnet.solana.com}" ;;
  mainnet-beta) RPC="${RPC:-https://api.mainnet-beta.solana.com}" ;;
  *) echo "usage: wsl-close-program.sh <localnet|devnet|mainnet-beta> <recovery> [rpc-url] [deployer-keypair]" >&2; exit 2 ;;
esac
test -n "$RECOVERY" || { echo "recovery address missing" >&2; exit 2; }
test -f "$DEPLOYER" || { echo "deployer keypair not found: $DEPLOYER" >&2; exit 2; }

PROGRAM_ID="$(node -e "console.log(require('$ROOT/services/chain/idl/instar.json').address)")"
WORLD="$(solana find-program-derived-address "$PROGRAM_ID" string:world)"
echo "cluster:    $CLUSTER ($RPC)"
echo "program:    $PROGRAM_ID"
echo "world pda:  $WORLD"
echo "deployer:   $(solana-keygen pubkey "$DEPLOYER") ($(solana balance --url "$RPC" "$DEPLOYER"))"
echo "recovery:   $RECOVERY"

if ! solana program show "$PROGRAM_ID" --url "$RPC" >/dev/null 2>&1; then
  echo "the program is already closed (or never deployed here); nothing to do"
  exit 0
fi
if solana account "$WORLD" --url "$RPC" >/dev/null 2>&1; then
  echo "REFUSING: the World PDA $WORLD still exists. Closing the program would strand it and every" >&2
  echo "record it owns; run 'npx tsx scripts/operator.mts recover-all --to $RECOVERY --yes' through close_world first." >&2
  exit 1
fi

before="$(solana balance --url "$RPC" --lamports "$RECOVERY" | awk '{print $1}')"
echo "recovery holds $before lamports before"
solana program show "$PROGRAM_ID" --url "$RPC"
solana program close "$PROGRAM_ID" \
  --url "$RPC" --keypair "$DEPLOYER" --authority "$DEPLOYER" \
  --recipient "$RECOVERY" --bypass-warning
after="$(solana balance --url "$RPC" --lamports "$RECOVERY" | awk '{print $1}')"
echo "recovery holds $after lamports after: +$((after - before)) lamports from the program's rent"
echo PROGRAM_CLOSE_OK
