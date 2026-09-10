import type { FastifyReply, FastifyRequest } from 'fastify';
import { consume } from './redis.js';
import type { Decision, Logger, TokenBucketCluster } from './redis.js';
import type { Config } from './config.js';
import type { RuleStore } from './rules.js';

export interface Metrics {
  allowed: number;
  throttled: number;
  redisErrors: number;
  failedOpen: number;
  failedClosed: number;
}

export const metrics: Metrics = {
  allowed: 0,
  throttled: 0,
  redisErrors: 0,
  failedOpen: 0,
  failedClosed: 0,
};

export function resolveClientId(req: FastifyRequest): string {
  const header = req.headers['x-client-id'] ?? req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  return req.ip;
}

export const bucketKey = (clientId: string, ruleId: string): string => `rl:{${clientId}}:${ruleId}`;

export interface LimiterDeps {
  cluster: TokenBucketCluster;
  rules: RuleStore;
  config: Config;
  logger: Logger;
}

export type Limiter = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function createLimiter({ cluster, rules, config, logger }: LimiterDeps): Limiter {
  return async function limit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const clientId = resolveClientId(req);
    const path = req.url.split('?')[0] ?? req.url;
    const rule = rules.resolve({ path, method: req.method });
    const key = bucketKey(clientId, rule.id);

    let decision: Decision;
    try {
      decision = await consume(cluster, key, rule, rule.cost);
    } catch (err) {
      metrics.redisErrors += 1;
      const message = (err as Error).message;

      if (config.failMode === 'open') {
        metrics.failedOpen += 1;
        logger.warn({ err: message, clientId }, 'redis unavailable -- failing open');
        reply.header('x-ratelimit-degraded', 'fail-open');
        return;
      }

      metrics.failedClosed += 1;
      logger.error({ err: message, clientId }, 'redis unavailable -- failing closed');
      await reply.code(503).send({
        error: 'rate_limiter_unavailable',
        message: 'Rate limiter cannot verify the request budget; try again shortly.',
        gatewayId: config.gatewayId,
      });
      return;
    }

    reply.headers({
      'x-ratelimit-limit': String(decision.limit),
      'x-ratelimit-remaining': String(Math.max(0, decision.remaining)),
      'x-ratelimit-rule': rule.id,
      'x-ratelimit-gateway': config.gatewayId,
    });

    if (decision.allowed) {
      metrics.allowed += 1;
      return;
    }

    metrics.throttled += 1;
    const retryAfterSec =
      decision.retryAfterMs < 0 ? null : Math.max(1, Math.ceil(decision.retryAfterMs / 1000));

    if (retryAfterSec !== null) reply.header('retry-after', String(retryAfterSec));

    await reply.code(429).send({
      error: 'rate_limit_exceeded',
      message: 'Too many requests.',
      limit: decision.limit,
      retryAfterMs: decision.retryAfterMs < 0 ? null : decision.retryAfterMs,
      rule: rule.id,
      gatewayId: config.gatewayId,
    });
  };
}
