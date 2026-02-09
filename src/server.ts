import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { RouterOptions } from './router/router.js';
import { registerChatCompletions } from './routes/chat-completions.js';
import { registerModels } from './routes/models.js';
import { registerHealth } from './routes/health.js';

export interface ServerOptions {
  db: Database.Database;
  routerOptions: RouterOptions;
  logger?: boolean;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const { db, routerOptions, logger = true } = options;

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
  });

  // Register routes
  registerChatCompletions(app, db, routerOptions);
  registerModels(app, db);
  registerHealth(app, db);

  // Global error handler
  app.setErrorHandler((error, _request, reply) => {
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
