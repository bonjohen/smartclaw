import type Database from 'better-sqlite3';
import type { ModelRecord, BudgetStatus, RoutingPolicy } from '../types.js';

/**
 * Record cost after a completed request.
 * Calculates cost from token counts and model pricing, then upserts
 * into budget_tracking for both daily and monthly periods.
 */
export function recordRequestCost(
  db: Database.Database,
  model: ModelRecord,
  inputTokens: number,
  outputTokens: number
): number {
  const costUsd = calculateCost(model, inputTokens, outputTokens);
  if (costUsd <= 0) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const upsert = db.prepare(`
    INSERT INTO budget_tracking (period_type, period_key, total_spend, total_input_tokens, total_output_tokens, request_count)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(period_type, period_key) DO UPDATE SET
      total_spend = total_spend + excluded.total_spend,
      total_input_tokens = total_input_tokens + excluded.total_input_tokens,
      total_output_tokens = total_output_tokens + excluded.total_output_tokens,
      request_count = request_count + 1
  `);

  upsert.run('daily', today, costUsd, inputTokens, outputTokens);
  upsert.run('monthly', month, costUsd, inputTokens, outputTokens);

  return costUsd;
}

/**
 * Calculate cost in USD for a request given token counts and model pricing.
 * Pricing is per million tokens.
 */
export function calculateCost(
  model: ModelRecord,
  inputTokens: number,
  outputTokens: number
): number {
  return (inputTokens * model.cost_input + outputTokens * model.cost_output) / 1_000_000;
}

/**
 * Check if the cloud budget has been exceeded for the current day or month.
 */
export function isBudgetExceeded(db: Database.Database): boolean {
  const policy = db.prepare(
    'SELECT budget_daily_usd, budget_monthly_usd FROM routing_policy WHERE id = 1'
  ).get() as Pick<RoutingPolicy, 'budget_daily_usd' | 'budget_monthly_usd'> | undefined;

  if (!policy) return false;

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const daily = db.prepare(
    "SELECT total_spend FROM budget_tracking WHERE period_type = 'daily' AND period_key = ?"
  ).get(today) as { total_spend: number } | undefined;

  const monthly = db.prepare(
    "SELECT total_spend FROM budget_tracking WHERE period_type = 'monthly' AND period_key = ?"
  ).get(month) as { total_spend: number } | undefined;

  if (daily && daily.total_spend >= policy.budget_daily_usd) return true;
  if (monthly && monthly.total_spend >= policy.budget_monthly_usd) return true;

  return false;
}

/**
 * Get a full budget status summary.
 */
export function getBudgetStatus(db: Database.Database): BudgetStatus {
  const policy = db.prepare(
    'SELECT budget_daily_usd, budget_monthly_usd FROM routing_policy WHERE id = 1'
  ).get() as Pick<RoutingPolicy, 'budget_daily_usd' | 'budget_monthly_usd'>;

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const daily = db.prepare(
    "SELECT total_spend FROM budget_tracking WHERE period_type = 'daily' AND period_key = ?"
  ).get(today) as { total_spend: number } | undefined;

  const monthly = db.prepare(
    "SELECT total_spend FROM budget_tracking WHERE period_type = 'monthly' AND period_key = ?"
  ).get(month) as { total_spend: number } | undefined;

  const dailySpend = daily?.total_spend ?? 0;
  const monthlySpend = monthly?.total_spend ?? 0;

  return {
    daily_spend: dailySpend,
    daily_limit: policy.budget_daily_usd,
    monthly_spend: monthlySpend,
    monthly_limit: policy.budget_monthly_usd,
    is_exceeded: dailySpend >= policy.budget_daily_usd || monthlySpend >= policy.budget_monthly_usd,
  };
}
