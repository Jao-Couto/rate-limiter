import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { createRedis } from './redis.js';
import { RuleStore } from './rules.js';
import { createLimiter, metrics } from './limiter.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: true,
});

const cluster = createRedis(config, app.log);
const rules = new RuleStore(config, app.log);
rules.start();

const BYPASS = new Set(['/health', '/ready', '/config', '/metrics', '/rules']);

app.get('/health', async () => ({ status: 'ok', gatewayId: config.gatewayId }));

app.get('/ready', async (_req: FastifyRequest, reply: FastifyReply) => {
  let redis = 'unavailable';
  try {
    await cluster.ping();
    redis = 'ready';
  } catch (err) {
    redis = (err as Error).message;
  }
  const ready = redis === 'ready' || config.failMode === 'open';
  return reply.code(ready ? 200 : 503).send({
    ready,
    redis,
    zookeeper: rules.snapshot.zookeeperState,
    failMode: config.failMode,
  });
});

app.get('/config', async () => ({ ...config, redisNodes: config.redisNodes.length }));
app.get('/rules', async () => rules.snapshot);
app.get('/metrics', async () => ({ gatewayId: config.gatewayId, ...metrics }));

const limit = createLimiter({ cluster, rules, config, logger: app.log });

app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  const path = req.url.split('?')[0] ?? req.url;
  if (BYPASS.has(path)) return;
  await limit(req, reply);
});

app.all('/api/*', async (req: FastifyRequest, reply: FastifyReply) => {
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const clientId = req.headers['x-client-id'];
  const upstream = await fetch(`${config.upstreamUrl}${req.url}`, {
    method: req.method,
    headers: {
      'x-gateway-id': config.gatewayId,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(typeof clientId === 'string' ? { 'x-client-id': clientId } : {}),
    },
    body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
  });
  return reply.code(upstream.status).send(await upstream.json());
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info({ signal }, 'shutting down');
      await app.close();
      rules.close();
      cluster.disconnect();
      process.exit(0);
    })();
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
