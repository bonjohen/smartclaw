import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import type Database from 'better-sqlite3';
import type { RouterOptions } from './router/router.js';
import { registerChatCompletions } from './routes/chat-completions.js';
import { registerModels } from './routes/models.js';
import { registerHealth } from './routes/health.js';

/** Trusted sources that may appear in x-router-source header. */
const TRUSTED_SOURCES = new Set(['heartbeat', 'cron', 'webhook']);

export interface ServerOptions {
  db: Database.Database;
  routerOptions: RouterOptions;
  apiKey?: string;
  logger?: boolean;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const { db, routerOptions, apiKey, logger = true } = options;

  const app = Fastify({
    logger,
  });

  // CORS for local development
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Router-Source, X-Router-Channel');

    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }

    // Bearer token authentication (skip health endpoint for uptime monitors)
    if (apiKey && request.url !== '/health') {
      const auth = request.headers.authorization;
      if (!auth || auth !== `Bearer ${apiKey}`) {
        return reply.status(401).send({
          error: { message: 'Invalid or missing API key', type: 'authentication_error' },
        });
      }
    }

    // Strip untrusted x-router-source/channel headers to prevent routing bypass
    const source = request.headers['x-router-source'] as string | undefined;
    if (source && !TRUSTED_SOURCES.has(source)) {
      delete request.headers['x-router-source'];
    }
  });

  // Register routes
  registerChatCompletions(app, db, routerOptions);
  registerModels(app, db);
  registerHealth(app, db);

  // Global error handler
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        message: error.message,
        type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
      },
    });
  });

  return app;
}
