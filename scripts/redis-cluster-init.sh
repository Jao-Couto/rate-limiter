#!/bin/sh
# Forms the Redis Cluster once every node answers PING. Safe to re-run.
set -eu

NODES="172.28.0.11 172.28.0.12 172.28.0.13 172.28.0.14 172.28.0.15 172.28.0.16"
PORT=6379

echo "waiting for redis nodes..."
for ip in $NODES; do
  until redis-cli -h "$ip" -p "$PORT" ping 2>/dev/null | grep -q PONG; do
    sleep 1
  done
  echo "  $ip up"
done

state=$(redis-cli -h 172.28.0.11 -p "$PORT" cluster info | tr -d '\r' | awk -F: '/^cluster_state:/{print $2}')
if [ "$state" = "ok" ]; then
  echo "cluster already formed, nothing to do"
  redis-cli -h 172.28.0.11 -p "$PORT" cluster info | tr -d '\r' | grep -E 'cluster_(state|known_nodes|slots_assigned)'
  exit 0
fi

addrs=""
for ip in $NODES; do
  addrs="$addrs $ip:$PORT"
done

echo "creating cluster (3 masters + 1 replica each)..."
# shellcheck disable=SC2086
redis-cli --cluster create $addrs --cluster-replicas 1 --cluster-yes

# Slot coverage alone is not readiness: right after CLUSTER CREATE the nodes
# still report cluster_state:fail until gossip converges. Wait until *every*
# node agrees the cluster is ok, otherwise gateways start against a cluster
# that rejects their commands with CLUSTERDOWN.
echo "waiting for every node to report cluster_state:ok..."
for ip in $NODES; do
  until [ "$(redis-cli -h "$ip" -p "$PORT" cluster info | tr -d '\r' | awk -F: '/^cluster_state:/{print $2}')" = "ok" ]; do
    sleep 1
  done
  echo "  $ip ok"
done

redis-cli -h 172.28.0.11 -p "$PORT" cluster info | tr -d '\r' | grep -E 'cluster_(state|known_nodes|slots_assigned)'
echo "cluster ready"
