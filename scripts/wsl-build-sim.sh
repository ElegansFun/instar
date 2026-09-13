#!/bin/bash
# Build the world engine: native tests (ci profile = release speed with
# overflow checks ON), then the WASM module the site and the world process load.
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-build-sim.sh
# Tests MUST run --test-threads=1: they share the static world.
# The probe gates run on Windows node afterwards: `node scripts/sim-gates.mjs`.
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
cd /mnt/c/tech/connectomes/sim
export CARGO_TARGET_DIR=/root/instar-sim-target

echo "== native tests (determinism, CSR equivalence, overflow checks) =="
# grep, not tail: the last lines of cargo test are the empty doc-test summary,
# so tailing prints "0 passed" and looks like a proof while proving nothing
cargo test --profile ci -- --test-threads=1 2>&1 | grep -E "^test |^test result|panicked|error" | grep -v "0 passed; 0 failed"

echo "== wasm build =="
rustup target add wasm32-unknown-unknown 2>&1 | tail -1
cargo build --release --target wasm32-unknown-unknown 2>&1 | tail -1
mkdir -p /mnt/c/tech/connectomes/site
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/instar_sim.wasm" /mnt/c/tech/connectomes/site/instar_sim.wasm
ls -la /mnt/c/tech/connectomes/site/instar_sim.wasm

echo SIM_BUILD_OK
