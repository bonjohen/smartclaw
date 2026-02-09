import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

export function registerStats(app: FastifyInstance, db: Database.Database): void {
  app.get('/stats', async (_request, reply) => {
    // Routing distribution by tier
    const tierDistribution = db.prepare(`
      SELECT tier_used, COUNT(*) as count
      FROM request_log
      GROUP BY tier_used
      ORDER BY tier_used
    `).all() as { tier_used: number; count: number }[];

    // Model usage stats
    const modelUsage = db.prepare(`
      SELECT
        selected_model,
        COUNT(*) as request_count,
        AVG(latency_ms) as avg_latency_ms,
        SUM(cost_usd) as total_cost_usd,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens
      FROM request_log
      GROUP BY selected_model
      ORDER BY request_count DESC
    `).all() as {
      selected_model: string;
      request_count: number;
      avg_latency_ms: number | null;
      total_cost_usd: number | null;
      total_input_tokens: number | null;
      total_output_tokens: number | null;
    }[];

    // Budget summary
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    const dailyBudget = db.prepare(
      "SELECT * FROM budget_tracking WHERE period_type = 'daily' AND period_key = ?"
    ).get(today) as any;

    const monthlyBudget = db.prepare(
      "SELECT * FROM budget_tracking WHERE period_type = 'monthly' AND period_key = ?"
    ).get(month) as any;

    const policy = db.prepare(
      'SELECT budget_daily_usd, budget_monthly_usd FROM routing_policy WHERE id = 1'
    ).get() as any;

    // Recent requests
    const recentRequests = db.prepare(`
      SELECT request_at, selected_model, tier_used, latency_ms, cost_usd, success
      FROM request_log
      ORDER BY request_at DESC
      LIMIT 20
    `).all();

    // Overall totals
    const totals = db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_requests,
        SUM(cost_usd) as total_cost_usd,
        AVG(latency_ms) as avg_latency_ms
      FROM request_log
    `).get() as any;

    return reply.send({
      routing_distribution: tierDistribution,
      model_usage: modelUsage,
      budget: {
        daily: {
          spend: dailyBudget?.total_spend ?? 0,
          limit: policy?.budget_daily_usd ?? 0,
          requests: dailyBudget?.request_count ?? 0,
        },
        monthly: {
          spend: monthlyBudget?.total_spend ?? 0,
          limit: policy?.budget_monthly_usd ?? 0,
          requests: monthlyBudget?.request_count ?? 0,
        },
      },
      totals: {
        requests: totals?.total_requests ?? 0,
        successful: totals?.successful_requests ?? 0,
        total_cost_usd: totals?.total_cost_usd ?? 0,
        avg_latency_ms: totals?.avg_latency_ms ?? 0,
      },
      recent_requests: recentRequests,
    });
  });
}
