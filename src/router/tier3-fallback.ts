import type Database from 'better-sqlite3';
import type { ModelRecord, RankedCandidate, RoutingPolicy } from '../types.js';

/**
 * Tier 3: Return the configured fallback model as the last-resort candidate.
 * Returns empty array if the fallback model is unavailable or unhealthy.
 */
export function getFallbackCandidate(db: Database.Database): RankedCandidate[] {
  const policy = db.prepare('SELECT * FROM routing_policy WHERE id = 1').get() as RoutingPolicy;

  if (!policy.fallback_model_id) return [];

  const model = db.prepare(
    'SELECT * FROM models WHERE model_id = ? AND is_enabled = 1 AND is_healthy = 1'
  ).get(policy.fallback_model_id) as ModelRecord | undefined;

  if (!model) return [];

  return [{
    model,
    score: model.quality_score,
    rank: 1,
  }];
}
