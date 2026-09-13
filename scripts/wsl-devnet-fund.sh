#!/bin/bash
# Fund the deployer/operator on devnet from the public faucet, up to a target
# balance. The faucet rate-limits per address and per IP, so this retries with
# a pause and gives up after a bounded number of attempts.
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-devnet-fund.sh [target_sol] [keypair]
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
ROOT=/mnt/c/tech/connectomes
TARGET="${1:-4}"
KEY="${2:-$ROOT/.keys/operator.json}"
URL="${INSTAR_RPC:-https://api.devnet.solana.com}"
PUB="$(solana-keygen pubkey "$KEY")"
bal() { solana balance "$PUB" --url "$URL" 2>/dev/null | awk '{print $1}'; }
echo "address $PUB  balance $(bal) SOL  target $TARGET SOL"
for i in $(seq 1 12); do
  have="$(bal)"
  if [ "$(echo "$have >= $TARGET" | bc)" = 1 ]; then echo "funded: $have SOL"; exit 0; fi
  if solana airdrop 2 "$PUB" --url "$URL" >/dev/null 2>&1; then
    echo "airdrop ok -> $(bal) SOL"
  else
    echo "airdrop refused (attempt $i); waiting 20 s"
    sleep 20
  fi
done
echo "could not reach $TARGET SOL (have $(bal)); use https://faucet.solana.com for $PUB" >&2
exit 1
