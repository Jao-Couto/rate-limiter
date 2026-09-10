# rate-limiter

Distributed rate limiter following the [HelloInterview final design](https://www.hellointerview.com/learn/system-design/problem-breakdowns/distributed-rate-limiter):
token bucket, Redis Cluster for bucket state, ZooKeeper for live rule
distribution, fail-closed on Redis outage. TypeScript throughout.

```
 client ──▶ gateway-1 ─┐
        ──▶ gateway-2 ─┼──▶ server
        ──▶ gateway-3 ─┘
              │    │
              │    └──▶ redis cluster (3 masters + 3 replicas)
              └──▶ zookeeper (rate limit rules)
```

## Running

```bash
cp .env.example .env
docker compose up -d --build
docker compose --profile load run --rm client
```

| Service | Host port | Role |
|---|---|---|
| `gateway-1/2/3` | 3001 / 3002 / 3003 | Fastify + token bucket limiter |
| `server` | 4000 | Fastify backend behind the limiter |
| `zookeeper` | 2181 | Rate limit rules at `/rate-limiter/rules` |
| `redis-1..6` | — | Cluster, 16384 slots, reachable in-network only |

```bash
curl -H 'x-client-id: alice' http://localhost:3002/api/resource
curl http://localhost:3001/rules
curl http://localhost:3001/metrics
curl http://localhost:3001/ready
```

## How the limiter works

**Atomicity.** [token-bucket.lua](services/gateway/src/token-bucket.lua) does the
whole read-refill-decide-write sequence inside one Redis command, so N gateways
racing on the same client cannot interleave and over-admit. `ioredis`
`defineCommand` caches the SHA and replays the body on `NOSCRIPT`, so a
restarted shard re-learns the script without failing a request.

**Redis owns the clock.** The script reads `TIME` from the shard rather than
taking `now` from the gateway. With N gateways, clock skew between them would
move a bucket's timestamp backwards, and a backwards jump mints free tokens.
Elapsed time is also clamped at 0 so an NTP step on the Redis node cannot do
the same.

**One shard per client.** Bucket keys are `rl:{<clientId>}:<ruleId>`. The hash
tag pins every bucket for a client to a single shard, which is what keeps the
script single-slot and a client's decisions serialised in one place.

**Bucket TTL is derived, not fixed.** `capacity / refillPerSec + 60s` — a bucket
can only be reclaimed once it would have refilled to full anyway, because an
early eviction is indistinguishable from a fresh full bucket and silently
raises the limit. Redis runs `volatile-lru` for the same reason.

**Rule ids are part of the key**, so editing a rule in ZooKeeper does not let
the new limit inherit the old rule's token balance.

**Fail-closed applies to Redis, not ZooKeeper.** Losing the data plane means the
limiter cannot verify a budget, so it rejects with 503 — admitting traffic
blind is how a spike becomes an outage. Losing the config plane is different:
gateways keep serving the last known rules, and a malformed JSON push is
ignored rather than allowed to wipe a working rule set. `FAIL_MODE=open` is an
explicit operator override that admits traffic with
`x-ratelimit-degraded: fail-open`.

Rate limit responses carry `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-rule`, `x-ratelimit-gateway`, and `retry-after` on a 429.

## Rules

Held in the `/rate-limiter/rules` znode; every gateway watches it and picks up
changes without a restart. First match wins, so order matters.

```json
{
  "version": 1,
  "default": { "capacity": 10, "refillPerSec": 5 },
  "rules": [
    { "match": { "path": "/api/resource" }, "capacity": 10, "refillPerSec": 5 },
    { "match": { "path": "/api/expensive" }, "capacity": 2, "refillPerSec": 1 }
  ]
}
```

`match` takes `path` (exact, or a `*` suffix for prefix) and `method`; a rule
may also set `cost` to charge a request more than one token.

```bash
docker exec rl-zookeeper zkCli.sh -server localhost:2181 \
  set /rate-limiter/rules '{"version":2,"default":{"capacity":3,"refillPerSec":1},"rules":[]}'
```

## Notes on the compose topology

- **Static IPs (`172.28.0.11-16`) are mandatory.** Redis Cluster gossips the
  address each node announces (`--cluster-announce-ip`); with DHCP addresses a
  restart hands a node a new IP and the cluster splits.
- **Gateways are declared individually**, not via `deploy.replicas`, so each
  keeps a stable host port and a distinct `GATEWAY_ID` — you can kill exactly
  one and watch buckets stay consistent across the survivors.
- **`redis-cluster-init` waits for `cluster_state:ok` on every node**, not just
  slot coverage. Right after `CLUSTER CREATE` the slots are assigned while the
  state is still `fail`; starting gateways there gets `CLUSTERDOWN`.
- **`enableOfflineQueue: false`** with a 100ms command timeout: a bucket is
  worthless a second after it goes stale, so a request must never queue behind
  a reconnect. It fails, and `FAIL_MODE` decides what that means.
- **The client does its own round-robin** across the gateways, so no extra load
  balancer sits in the diagram.
- Both init containers are idempotent — re-running them never rewrites an
  existing cluster or existing rules.
- `/ready` actively PINGs Redis instead of trusting the client's cached status,
  which reports `ready` long after the shards stop answering.
- `zookeeperState` comes from the ZooKeeper client's own `getState()`. Note it
  detects a *killed* peer in a few seconds but not a *frozen* one
  (`docker pause`), where the TCP connection stays open.

## Layout

```
services/gateway/src/  config.ts  redis.ts  rules.ts  limiter.ts  index.ts
                       token-bucket.lua
services/server/src/   index.ts
services/client/src/   index.ts
scripts/               redis-cluster-init.sh  zookeeper-init.sh
```

`tsconfig.base.json` is shared; each service extends it and builds to `dist/`
in a multi-stage image, so devDependencies never reach the runtime layer.

```bash
cd services/gateway && npm install && npm run typecheck
```
