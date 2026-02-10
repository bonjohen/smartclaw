import type Database from 'better-sqlite3';
import type { ModelRecord, RoutingPolicy, RankedCandidate } from '../types.js';
import { isBudgetExceeded } from '../health/budget-tracker.js';

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
  const budgetExceeded = isBudgetExceeded(db);

  // Clear expired rate limits before checking
  clearExpiredRateLimits(db);

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

  // Pre-compute sort keys to avoid recomputation during comparisons
  const sortKeys = new Map(models.map(m => [
    m.model_id,
    { loc: locationOrder.indexOf(m.location), cost: m.cost_input + m.cost_output },
  ]));

  // Sort by: location preference, then cost (cheapest), then quality (highest)
  models.sort((a, b) => {
    const ka = sortKeys.get(a.model_id)!;
    const kb = sortKeys.get(b.model_id)!;

    // 1. Location preference
    if (ka.loc !== kb.loc) return ka.loc - kb.loc;
    // 2. Cheapest first
    if (ka.cost !== kb.cost) return ka.cost - kb.cost;
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
  return [];
}

/**
 * Clear rate-limit flags for providers whose retry_after has expired.
 */
export function clearExpiredRateLimits(db: Database.Database): void {
  db.prepare(`
    UPDATE provider_rate_limits
    SET is_rate_limited = 0,
        limited_since = NULL,
        retry_after = NULL
    WHERE is_rate_limited = 1
      AND retry_after IS NOT NULL
      AND retry_after <= datetime('now')
  `).run();
}
