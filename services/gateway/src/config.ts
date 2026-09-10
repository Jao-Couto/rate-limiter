export interface Rule {
  id: string;
  capacity: number;
  refillPerSec: number;
  cost: number;
}

export interface RedisNode {
  host: string;
  port: number;
}

export type FailMode = 'open' | 'closed';

export interface Config {
  gatewayId: string;
  port: number;
  upstreamUrl: string;
  redisNodes: RedisNode[];
  zookeeperConnect: string;
  zkRulesPath: string;
  failMode: FailMode;
  redisTimeoutMs: number;
  defaultRule: { capacity: number; refillPerSec: number };
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseNodes(raw: string | undefined): RedisNode[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [host, port] = entry.split(':');
      return { host: host ?? '127.0.0.1', port: int(port, 6379) };
    });
}

export const config: Config = {
  gatewayId: process.env.GATEWAY_ID ?? 'gateway',
  port: int(process.env.PORT, 3000),
  upstreamUrl: process.env.UPSTREAM_URL ?? 'http://server:4000',
  redisNodes: parseNodes(process.env.REDIS_CLUSTER_NODES),
  zookeeperConnect: process.env.ZOOKEEPER_CONNECT ?? 'zookeeper:2181',
  zkRulesPath: process.env.ZK_RULES_PATH ?? '/rate-limiter/rules',
  failMode: process.env.FAIL_MODE === 'open' ? 'open' : 'closed',
  redisTimeoutMs: int(process.env.REDIS_TIMEOUT_MS, 100),
  defaultRule: {
    capacity: int(process.env.DEFAULT_BUCKET_CAPACITY, 10),
    refillPerSec: int(process.env.DEFAULT_REFILL_PER_SEC, 5),
  },
};
