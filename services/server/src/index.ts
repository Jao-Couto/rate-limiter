import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const port = Number(process.env.PORT ?? 4000);

app.get('/health', async () => ({ status: 'ok', service: 'server' }));

app.all('/api/*', async (req: FastifyRequest) => ({
  service: 'server',
  path: req.url,
  clientId: req.headers['x-client-id'] ?? null,
  via: req.headers['x-gateway-id'] ?? null,
  servedAt: new Date().toISOString(),
}));

await app.listen({ host: '0.0.0.0', port });
