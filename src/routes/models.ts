import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { ModelRecord } from '../types.js';

export function registerModels(app: FastifyInstance, db: Database.Database): void {
  app.get('/v1/models', async (_request, reply) => {
    const models = db.prepare(
      'SELECT * FROM models WHERE is_enabled = 1 ORDER BY location, quality_score DESC'
    ).all() as ModelRecord[];

    return reply.send({
      object: 'list',
      data: models.map(m => ({
        id: m.model_id,
        object: 'model',
        created: Math.floor(new Date(m.created_at).getTime() / 1000),
        owned_by: m.provider,
        // Extra metadata useful for clients
        permission: [],
        root: m.model_id,
        parent: null,
      })),
    });
  });
}
