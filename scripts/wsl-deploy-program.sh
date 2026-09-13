#!/bin/bash
# Deploy (or upgrade) the built program and publish its IDL on chain.
#   bash wsl-deploy-program.sh <cluster> <rpc-url> <deployer-keypair (WSL path)>
# Driven by scripts/deploy-program.mts; run it directly only when you know the
# artifact in program/target/deploy is the real-timer build.
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
CLUSTER="$1"; RPC="$2"; DEPLOYER="$3"
ROOT=/mnt/c/tech/connectomes
cd "$ROOT/program"
PROGRAM_ID="$(solana-keygen pubkey target/deploy/instar-keypair.json)"

echo "cluster:    $CLUSTER ($RPC)"
echo "program:    $PROGRAM_ID"
echo "deployer:   $(solana-keygen pubkey "$DEPLOYER") ($(solana balance --url "$RPC" --keypair "$DEPLOYER"))"

solana program deploy \
  --url "$RPC" --keypair "$DEPLOYER" \
  --program-id target/deploy/instar-keypair.json \
  --upgrade-authority "$DEPLOYER" \
  target/deploy/instar.so

# A program deployed in slot N is callable from slot N+1; anchor's IDL
# instructions retry too fast to notice, so wait for the slot to pass.
deployed_slot="$(solana program show "$PROGRAM_ID" --url "$RPC" | awk '/Last Deployed In Slot/ {print $5}')"
until [ "$(solana slot --url "$RPC")" -gt "$deployed_slot" ]; do sleep 1; done

# The IDL account lets explorers and any client decode the program's accounts
# and instructions without this repository. init the first time, upgrade after.
if anchor idl fetch "$PROGRAM_ID" --provider.cluster "$RPC" --provider.wallet "$DEPLOYER" >/dev/null 2>&1; then
  anchor idl upgrade "$PROGRAM_ID" -f target/idl/instar.json --provider.cluster "$RPC" --provider.wallet "$DEPLOYER"
else
  anchor idl init "$PROGRAM_ID" -f target/idl/instar.json --provider.cluster "$RPC" --provider.wallet "$DEPLOYER"
fi

solana program show "$PROGRAM_ID" --url "$RPC"
echo PROGRAM_DEPLOY_OK
