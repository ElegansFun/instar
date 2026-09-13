#!/bin/bash
# A local validator with the built program preloaded at its real address, for
# the world process, verify.mts and journey.mts. Foreground; Ctrl-C stops it.
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-localnet.sh [port]
# RPC on http://127.0.0.1:<port> (default 8899), reachable from Windows through
# WSL2's localhost forwarding. Each port gets its own ledger, so a second
# validator (e.g. 8999 for verify.mts) never touches the world's chain. The
# operator keypair (.keys/operator.json) is created if absent and funded with
# 100 SOL once the RPC answers. Ledgers live in the WSL filesystem: RocksDB on
# /mnt/c is far too slow.
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
ROOT=/mnt/c/tech/connectomes
PORT="${1:-8899}"
URL="http://127.0.0.1:$PORT"
SO="$ROOT/program/target/deploy/instar.so"
CORE_SO="$ROOT/program/deps/mpl_core.so"
CORE_ID=CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
test -f "$SO" || { echo "no $SO: run npm run program:build first" >&2; exit 1; }
test -f "$CORE_SO" || { echo "no $CORE_SO: see program/deps/README.md" >&2; exit 1; }
PROGRAM_ID="$(node -e "console.log(require('$ROOT/program/target/idl/instar.json').address)")"
OPERATOR="$ROOT/.keys/operator.json"
mkdir -p "$ROOT/.keys"
test -f "$OPERATOR" || solana-keygen new --no-bip39-passphrase -s -o "$OPERATOR" >/dev/null
echo "program:  $PROGRAM_ID"
echo "operator: $(solana-keygen pubkey "$OPERATOR")"
echo "rpc:      $URL"

(
  until solana cluster-version --url "$URL" >/dev/null 2>&1; do sleep 1; done
  solana airdrop 100 "$(solana-keygen pubkey "$OPERATOR")" --url "$URL" >/dev/null
  echo "operator funded: $(solana balance "$OPERATOR" --url "$URL")"
) &

# The program is preloaded as an UPGRADEABLE program with the operator as
# upgrade authority: init_world checks that its signer is that authority, and a
# plain --bpf-program preload would set the authority to the default pubkey.
# Metaplex Core (program/deps/mpl_core.so, dumped from mainnet) is preloaded
# at its real address: every larva is a Core asset created by CPI.
# gossip/faucet/dynamic ports are derived so two validators can coexist on one host.
exec solana-test-validator --reset --quiet \
  --ledger "/root/instar-ledger-$PORT" \
  --rpc-port "$PORT" \
  --gossip-port "$((PORT + 3000))" \
  --faucet-port "$((PORT + 1000))" \
  --dynamic-port-range "$((PORT + 2000))-$((PORT + 2099))" \
  --bpf-program "$CORE_ID" "$CORE_SO" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$(solana-keygen pubkey "$OPERATOR")"
