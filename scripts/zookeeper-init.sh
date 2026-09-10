#!/usr/bin/env bash
# Seeds the rate limit rules znode so gateways have config to watch on boot.
set -euo pipefail

ZK="zookeeper:2181"
PATH_RULES="${ZK_RULES_PATH:-/rate-limiter/rules}"
CAPACITY="${DEFAULT_BUCKET_CAPACITY:-10}"
REFILL="${DEFAULT_REFILL_PER_SEC:-5}"

RULES=$(cat <<JSON
{"version":1,"default":{"capacity":${CAPACITY},"refillPerSec":${REFILL}},"rules":[{"match":{"path":"/api/resource"},"capacity":${CAPACITY},"refillPerSec":${REFILL}},{"match":{"path":"/api/expensive"},"capacity":2,"refillPerSec":1}]}
JSON
)

zk() { zkCli.sh -server "$ZK" "$@" 2>&1; }

echo "waiting for zookeeper at $ZK..."
until zk ls / | grep -q 'zookeeper'; do sleep 1; done

# Create every parent in the path — ZooKeeper has no mkdir -p.
parent=""
IFS='/' read -ra parts <<< "${PATH_RULES#/}"
for i in "${!parts[@]}"; do
  parent="$parent/${parts[$i]}"
  if [ "$i" -lt "$((${#parts[@]} - 1))" ]; then
    zk create "$parent" "" >/dev/null || true
  fi
done

if zk stat "$PATH_RULES" | grep -q 'cZxid'; then
  echo "$PATH_RULES already exists — leaving current rules untouched"
else
  zk create "$PATH_RULES" "$RULES" >/dev/null
  echo "created $PATH_RULES"
fi

echo "current rules:"
zk get "$PATH_RULES" | grep -F '"version"'
echo "zookeeper ready"
