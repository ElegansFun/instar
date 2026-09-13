#!/bin/bash
# Dump the Metaplex Core program from mainnet-beta into program/deps/ so the
# local validators can preload it, and print the provenance that
# program/deps/README.md records (dump date, deploy slot, sha256).
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-dump-mpl-core.sh
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
ROOT=/mnt/c/tech/connectomes
CORE=CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
mkdir -p "$ROOT/program/deps"
solana program dump -u m "$CORE" "$ROOT/program/deps/mpl_core.so"
echo "dumped: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
solana program show -u m "$CORE"
sha256sum "$ROOT/program/deps/mpl_core.so"
