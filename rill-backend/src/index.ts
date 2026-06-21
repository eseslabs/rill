import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config } from './core/config';
import { errorHandler } from './core/errors';
import { apiRouter } from './http/routes/api.routes';
import { buildOpenApiDocument } from './http/openapi';

const app = new Hono();

// Global Middlewares
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

const swagger = swaggerUI({ url: '/api/openapi.json' });

app.get('/health', (c) =>
  c.json({
    name: 'Rill Bun-Hono API',
    status: 'healthy',
    version: '1.0.0',
    network: config.network,
    apiBase: `${config.publicBaseUrl}/api`,
    docs: config.publicBaseUrl,
    description: 'Autonomous Move package semantic resolver and visual flow compilation engine for Sui.',
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
