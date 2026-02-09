import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

export function registerHealth(app: FastifyInstance, db: Database.Database): void {
  app.get('/health', async (_request, reply) => {
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      // DB not accessible
    }

    const totalModels = (db.prepare('SELECT COUNT(*) as cnt FROM models WHERE is_enabled = 1').get() as any)?.cnt ?? 0;
    const healthyModels = (db.prepare('SELECT COUNT(*) as cnt FROM models WHERE is_enabled = 1 AND is_healthy = 1').get() as any)?.cnt ?? 0;
    const unhealthyModels = totalModels - healthyModels;

    const policy = db.prepare('SELECT budget_daily_usd, budget_monthly_usd FROM routing_policy WHERE id = 1').get() as any;

    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const dailySpend = (db.prepare("SELECT total_spend FROM budget_tracking WHERE period_type = 'daily' AND period_key = ?").get(today) as any)?.total_spend ?? 0;
    const monthlySpend = (db.prepare("SELECT total_spend FROM budget_tracking WHERE period_type = 'monthly' AND period_key = ?").get(month) as any)?.total_spend ?? 0;

    const status = dbOk && healthyModels > 0 ? 'ok' : 'degraded';

    return reply.status(status === 'ok' ? 200 : 503).send({
      status,
      database: dbOk ? 'connected' : 'disconnected',
      models: {
        total: totalModels,
        healthy: healthyModels,
        unhealthy: unhealthyModels,
      },
      budget: {
        daily_spend: dailySpend,
        daily_limit: policy?.budget_daily_usd ?? 0,
        monthly_spend: monthlySpend,
        monthly_limit: policy?.budget_monthly_usd ?? 0,
      },
    });
  });
}
