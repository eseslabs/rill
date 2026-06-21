import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { config } from './core/config';
import { errorHandler } from './core/errors';
import { apiRouter } from './http/routes/api.routes';
import { buildOpenApiDocument } from './http/openapi';

const app = new Hono();

// Global Middlewares
app.use('*', logger());
// Public, keyless API consumed by agents/MCP clients from anywhere → wildcard origin, NO credentials
// (wildcard + credentials is invalid per the CORS spec and rejected by browsers).
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 600,
}));
// Cap request bodies — flows/PTBs are small; reject oversized payloads early (DoS guard).
app.use('*', bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ success: false, error: 'Request body too large (max 512KB).' }, 413) }));

const swagger = swaggerUI({ url: '/api/openapi.json' });

app.get('/health', (c) =>
  c.json({
    name: 'Rill Bun-Hono API',
    status: 'healthy',
    version: '1.0.0',
    network: config.network,
    apiBase: `${config.publicBaseUrl}/api`,
    docs: config.publicBaseUrl,
    keyless: !config.devSignEnabled,
    devSignEnabled: config.devSignEnabled,
    agentWalletConfigured: Boolean(config.agentWallet),
    walrus: config.walrusEnabled,
    description:
      'Keyless Move flow compiler for Sui — builds unsigned PTBs, simulates, and serves MCP tools. Thiny signs.',
  }),
);

app.get('/', swagger);
app.get('/api/docs', swagger);

app.get('/api/openapi.json', (c) => c.json(buildOpenApiDocument(config.publicBaseUrl)));

app.route('/api', apiRouter);

// Global Error Handler
app.onError(errorHandler);

// Export app type for Hono RPC Client usage in Frontend
export type AppType = typeof app;

// Bun entry point configuration
export default {
  port: config.port,
  fetch: app.fetch,
};
