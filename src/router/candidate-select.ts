import type Database from 'better-sqlite3';
import type { ModelRecord, RoutingPolicy, RankedCandidate } from '../types.js';

export interface SelectionCriteria {
  quality_floor: number;
  required_capability: string | null;
  sensitive: boolean;
  estimated_tokens: number;
}

/**
 * Select and rank candidate models based on the classification result and current policy/state.
 *
 * Hard filters: quality floor, capability, health, enabled, rate limits, budget.
 * Soft filter: quality tolerance for zero-cost models (PDR Section 7.2).
 * Sort: prefer local > LAN > cloud, then cheapest, then highest quality.
 */
export function selectCandidates(
  db: Database.Database,
  criteria: SelectionCriteria
): RankedCandidate[] {
  const policy = db.prepare('SELECT * FROM routing_policy WHERE id = 1').get() as RoutingPolicy;
  const locationOrder = policy.prefer_location_order.split(',').map(s => s.trim());

  // Check if budget is exceeded (cloud models should be excluded)
  const budgetExceeded = isBudgetExceeded(db, policy);

  // Get all enabled, healthy models
  let models: ModelRecord[];
  if (criteria.required_capability) {
    models = db.prepare(`
      SELECT m.* FROM models m
      JOIN model_capabilities mc ON m.model_id = mc.model_id
      WHERE m.is_enabled = 1
        AND m.is_healthy = 1
        AND mc.capability = ?
    `).all(criteria.required_capability) as ModelRecord[];
  } else {
    models = db.prepare(`
      SELECT * FROM models
      WHERE is_enabled = 1
        AND is_healthy = 1
    `).all() as ModelRecord[];
  }

  // Filter out rate-limited providers
  const rateLimited = new Set(
    (db.prepare(
      "SELECT provider FROM provider_rate_limits WHERE is_rate_limited = 1"
    ).all() as { provider: string }[]).map(r => r.provider)
  );

  models = models.filter(m => !rateLimited.has(m.provider));

  // Filter: context window must accommodate estimated tokens
  models = models.filter(m => m.context_window >= criteria.estimated_tokens);

  // Filter: sensitive → exclude cloud
  if (criteria.sensitive) {
    models = models.filter(m => m.location !== 'cloud');
  }

  // Filter: budget exceeded → exclude cloud
  if (budgetExceeded) {
    models = models.filter(m => m.location !== 'cloud');
  }

  // Apply quality floor with tolerance (PDR Section 7.2)
  models = applyQualityTolerance(models, criteria.quality_floor, policy.quality_tolerance);

  // Sort by: location preference, then cost (cheapest), then quality (highest)
  models.sort((a, b) => {
    // 1. Location preference
    const locA = locationOrder.indexOf(a.location);
    const locB = locationOrder.indexOf(b.location);
    if (locA !== locB) return locA - locB;

    // 2. Cheapest first (total cost = cost_input + cost_output as proxy)
    const costA = a.cost_input + a.cost_output;
    const costB = b.cost_input + b.cost_output;
    if (costA !== costB) return costA - costB;

    // 3. Highest quality (tiebreak)
    return b.quality_score - a.quality_score;
  });

  // Build ranked result
  return models.map((model, index) => ({
    model,
    score: model.quality_score,
    rank: index + 1,
  }));
}

/**
 * Apply quality tolerance: prefer strict matches, but allow zero-cost models
 * within tolerance range if no strict matches exist (PDR Section 7.2).
 */
function applyQualityTolerance(
  candidates: ModelRecord[],
  qualityFloor: number,
  tolerance: number
): ModelRecord[] {
  const strict = candidates.filter(m => m.quality_score >= qualityFloor);
  if (strict.length > 0) return strict;

  // No strict matches — check if a zero-cost model is within tolerance
  const soft = candidates.filter(
    m => m.quality_score >= (qualityFloor - tolerance)
      && m.cost_output === 0
  );
  if (soft.length > 0) return soft;

  // Nothing within tolerance — return empty (triggers fallback)
  return strict;
}

/**
 * Check if the cloud budget has been exceeded for the current day or month.
 */
function isBudgetExceeded(db: Database.Database, policy: RoutingPolicy): boolean {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const month = today.slice(0, 7); // YYYY-MM

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
