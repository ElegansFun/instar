#!/bin/bash
# Build the world's container image and smoke-run it against the localnet
# validator, from WSL (Docker is not installed on the Windows side).
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-docker.sh [build|run|stop]
# Installs docker.io on first use and starts dockerd if it is not running.
set -eo pipefail
ROOT=/mnt/c/tech/connectomes
MODE="${1:-build}"
if ! command -v docker >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq docker.io >/dev/null
fi
if ! docker info >/dev/null 2>&1; then
  nohup dockerd >/var/log/dockerd.log 2>&1 &
  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || { echo "dockerd did not start; see /var/log/dockerd.log" >&2; exit 1; }
fi
case "$MODE" in
  build)
    # /mnt/c is slow for a build context: stage a copy in the Linux fs honouring .dockerignore
    STAGE=/root/instar-build
    rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude-from="$ROOT/.dockerignore" "$ROOT/" "$STAGE/"
    docker build -t instar:local "$STAGE"
    docker image inspect instar:local --format 'image instar:local {{.Size}} bytes, node base {{index .Config.Env 0}}'
    ;;
  run)
    docker rm -f instar-smoke >/dev/null 2>&1 || true
    mkdir -p /root/instar-data/keys
    cp "$ROOT/.keys/operator.json" /root/instar-data/keys/operator.json
    # host networking: the validator listens on the WSL loopback (8899)
    docker run -d --name instar-smoke --network host \
      -e INSTAR_CLUSTER=localnet -e INSTAR_RPC=http://127.0.0.1:8899 \
      -e INSTAR_OPERATOR_KEYPAIR=/data/keys/operator.json -e DATA_DIR=/data -e PORT=8788 -e PUBLIC_URL=http://localhost:8787 \
      -v /root/instar-data:/data instar:local >/dev/null
    for i in $(seq 1 90); do
      code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/api/health || true)
      [ "$code" = "200" ] && break
      sleep 2
    done
    echo "health $code"
    curl -s http://127.0.0.1:8788/api/health; echo
    docker logs --tail 12 instar-smoke
    ;;
  stop)
    docker rm -f instar-smoke >/dev/null 2>&1 || true
    echo stopped
    ;;
esac
