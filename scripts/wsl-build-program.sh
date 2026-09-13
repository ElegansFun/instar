#!/bin/bash
# Build the on-chain program and run its test suite against a local validator.
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-build-program.sh [build|test]
# Default is both. `build` produces the deployable artifact (real timers) and
# copies the IDL + TS types to services/chain/idl/ (program/target is
# gitignored, so the runtime never reads from there). `test` rebuilds with the
# short-timers feature so the recovery drills can wait their timers out in
# real time, runs `anchor test`, then restores the real-timer build.
# target/deploy/instar.features records what the artifact on disk was built
# with; deploy-program.mts refuses anything but "default".
set -eo pipefail
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:$PATH"
ROOT=/mnt/c/tech/connectomes
MODE="${1:-all}"

bash "$ROOT/scripts/wsl-program-keys.sh"
cd "$ROOT/program"

# Print a build log without cargo's per-crate noise; keep the exit status.
quiet() {
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    grep -vE "^\s*(Compiling|Finished|Running|warning: unused manifest key)|^\s*$" "$log" || true
    rm -f "$log"
  else
    cat "$log"; rm -f "$log"
    echo "FAILED: $*" >&2
    return 1
  fi
}

build() {
  # $1 = feature list for cargo, or "default".
  # sBPF v3 via cargo build-sbf directly: `anchor build` cannot pass --arch
  # (it forwards extra args to the IDL's cargo test as well). The build-sbf
  # default (v0) cannot be deployed to a validator with SIMD-0500 active, which
  # a local test validator already is; v3 deployment is live on mainnet-beta
  # and devnet. The IDL is built separately; it does not depend on either.
  local args=(--arch v3)
  [ "$1" = "default" ] || args+=(--features "$1")
  quiet cargo build-sbf "${args[@]}"
  quiet anchor idl build -o target/idl/instar.json -t target/types/instar.ts
  test -f target/deploy/instar.so
  echo "$1" > target/deploy/instar.features
}

publish_idl() {
  mkdir -p "$ROOT/services/chain/idl"
  cp target/idl/instar.json "$ROOT/services/chain/idl/instar.json"
  cp target/types/instar.ts "$ROOT/services/chain/idl/instar.ts"
  echo "idl -> services/chain/idl/instar.json (address $(node -e 'console.log(require("./target/idl/instar.json").address)'))"
}

if [ "$MODE" = "build" ] || [ "$MODE" = "all" ]; then
  echo "== anchor build (real timers) =="
  build default
  publish_idl
fi

# The suite runs against our own validator (wsl-localnet.sh on port 8999),
# not anchor's: anchor preloads workspace programs with --bpf-program, which
# leaves the upgrade authority unset, and init_world requires its signer to
# BE the upgrade authority. wsl-localnet.sh preloads the program as
# upgradeable with the operator (Anchor.toml's wallet) as that authority.
TEST_RPC=http://127.0.0.1:8999
run_suite() {
  bash "$ROOT/scripts/wsl-localnet.sh" 8999 &
  local vpid=$!
  trap 'kill $vpid 2>/dev/null; wait $vpid 2>/dev/null' EXIT
  until solana cluster-version --url "$TEST_RPC" >/dev/null 2>&1; do sleep 1; done
  sleep 2
  anchor test --skip-build --skip-local-validator --skip-deploy --provider.cluster "$TEST_RPC"
  kill $vpid 2>/dev/null; wait $vpid 2>/dev/null || true
  trap - EXIT
}

if [ "$MODE" = "retest" ]; then
  # iterate on the TS suite without rebuilding: the artifact on disk must be
  # the short-timers build from a previous `test` run
  test "$(cat target/deploy/instar.features)" = "short-timers" || { echo "artifact is not a short-timers build; run test" >&2; exit 1; }
  run_suite
  exit 0
fi

if [ "$MODE" = "test" ] || [ "$MODE" = "all" ]; then
  if [ ! -d node_modules ]; then
    echo "program/node_modules missing: run 'npm install' in program/ (Windows node) first" >&2
    exit 1
  fi
  echo "== anchor test (short timers) =="
  build short-timers
  run_suite
  echo "== restore real-timer artifact =="
  build default
  publish_idl
fi

echo PROGRAM_BUILD_OK
