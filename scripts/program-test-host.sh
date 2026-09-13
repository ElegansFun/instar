#!/bin/bash
# The mocha runner `anchor test` invokes ([scripts] test in program/Anchor.toml),
# with cwd = program/. The suite is plain ESM TypeScript loaded by Node's own
# type stripping, and @solana/web3.js 1.99 pulls in an ESM-only uuid, so it
# needs Node >= 22.18. On this machine WSL's node is 18: the suite runs on
# Windows Node 24 through WSL interop. The validator anchor started in WSL is
# reachable from Windows through localhost forwarding; the wallet path is
# translated to a Windows path. Anywhere with a modern node, it just runs.
set -eo pipefail
MOCHA="node_modules/mocha/bin/mocha.js"
ARGS=(-t 120000 "tests/**/*.ts")

modern() { node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a>22||(a===22&&b>=18))?0:1' ; }
if [ "$(modern)" = "0" ]; then
  exec node "$MOCHA" "${ARGS[@]}"
fi

WIN_NODE="/mnt/c/Program Files/nodejs/node.exe"
if [ ! -x "$WIN_NODE" ]; then
  echo "the test suite needs Node >= 22.18 (this node is $(node -v)) or Windows node at '$WIN_NODE'" >&2
  exit 1
fi
case "$ANCHOR_WALLET" in
  /mnt/?/*) ;;
  *) echo "ANCHOR_WALLET must live under /mnt/<drive>/ so Windows node can read it (got '$ANCHOR_WALLET'); set [provider] wallet in Anchor.toml" >&2; exit 1 ;;
esac
ANCHOR_WALLET="$(echo "$ANCHOR_WALLET" | sed -E 's#^/mnt/([a-z])/#\U\1:/#')"
export ANCHOR_WALLET ANCHOR_PROVIDER_URL
export WSLENV="ANCHOR_WALLET:ANCHOR_PROVIDER_URL"
# WSL2 forwards a new WSL listener to Windows localhost with a short delay;
# anchor already saw the RPC from inside WSL, so wait for the Windows side.
for _ in $(seq 1 30); do
  if "$WIN_NODE" -e 'fetch(process.env.ANCHOR_PROVIDER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
    exec "$WIN_NODE" "$MOCHA" "${ARGS[@]}"
  fi
  sleep 1
done
echo "validator at $ANCHOR_PROVIDER_URL is not reachable from Windows" >&2
exit 1
