#!/bin/bash
# Quick native check of the world engine while developing: compile errors and
# warnings, then the native tests (ci profile), optionally one test by name
# with extra harness args (e.g. --nocapture).
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-check-sim.sh [test-name [harness args...]]
set -o pipefail
export PATH="/root/.cargo/bin:$PATH"
cd /mnt/c/tech/connectomes/sim
export CARGO_TARGET_DIR=/root/instar-sim-target
cargo build --profile ci 2>&1 | grep -E "^(error|warning)|^ +--> |^[0-9]+ +\|" | head -120
cargo test --profile ci -- --test-threads=1 "$@" 2>&1 | grep -E "^test |^test result|panicked|error|assert|^t[0-9]" | grep -v "0 passed; 0 failed"
