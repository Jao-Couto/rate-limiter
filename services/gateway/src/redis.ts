import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis, { Cluster } from 'ioredis';
import type { Config, Rule } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const tokenBucketLua = readFileSync(join(here, 'token-bucket.lua'), 'utf8');

export type TokenBucketResult = [
  allowed: number,
  milliTokens: number,
  retryAfterMs: number,
  capacity: number,
];

export interface TokenBucketCluster extends Cluster {
  tokenBucket(
    key: string,
    capacity: number,
    refillPerSec: number,
    cost: number,
  ): Promise<TokenBucketResult>;
}

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Decision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
}

export function createRedis(config: Config, logger: Logger): TokenBucketCluster {
  const cluster = new Redis.Cluster(config.redisNodes, {
    enableOfflineQueue: false,
    clusterRetryStrategy: (attempt: number) => Math.min(attempt * 100, 2000),
    redisOptions: {
      commandTimeout: config.redisTimeoutMs,
      maxRetriesPerRequest: 1,
    },
  });

  cluster.defineCommand('tokenBucket', { numberOfKeys: 1, lua: tokenBucketLua });

  cluster.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis cluster error'));
  cluster.on('ready', () => logger.info({}, 'redis cluster ready'));

  return cluster as TokenBucketCluster;
}

export async function consume(
  cluster: TokenBucketCluster,
  key: string,
  rule: Rule,
  cost = 1,
): Promise<Decision> {
  const [allowed, milliTokens, retryAfterMs, capacity] = await cluster.tokenBucket(
    key,
    rule.capacity,
    rule.refillPerSec,
    cost,
  );

  return {
    allowed: allowed === 1,
    remaining: Math.floor(milliTokens / 1000),
    retryAfterMs,
    limit: capacity,
  };
}
