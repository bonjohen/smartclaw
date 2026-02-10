import type Database from 'better-sqlite3';
import type { RoutingRule, RequestMetadata, TargetAction } from '../types.js';

/** Max characters of text_preview tested against regex to bound ReDoS exposure. */
const MAX_REGEX_INPUT_LENGTH = 500;

/** TTL for cached rules in milliseconds (5 seconds). */
const RULES_CACHE_TTL_MS = 5000;

let cachedRules: RoutingRule[] | null = null;
let cacheTimestamp = 0;

/** Invalidate the rule cache (e.g., after admin changes). */
export function invalidateRulesCache(): void {
  cachedRules = null;
  cacheTimestamp = 0;
}

function loadRules(db: Database.Database): RoutingRule[] {
  const now = Date.now();
  if (cachedRules && now - cacheTimestamp < RULES_CACHE_TTL_MS) {
    return cachedRules;
  }
  cachedRules = db.prepare(
    `SELECT * FROM routing_rules
     WHERE is_enabled = 1
     ORDER BY priority ASC`
  ).all() as RoutingRule[];
  cacheTimestamp = now;
  return cachedRules;
}

export interface Tier1Result {
  matched: true;
  rule: RoutingRule;
  action: TargetAction;
  target_model_id: string | null;
}

export interface Tier1NoMatch {
  matched: false;
}

export type Tier1Outcome = Tier1Result | Tier1NoMatch;

/**
 * Tier 1: Deterministic SQL rule matching.
 * Queries enabled routing_rules ordered by priority and returns the first match.
 */
export function matchTier1Rules(
  db: Database.Database,
  metadata: RequestMetadata
): Tier1Outcome {
  const rules = loadRules(db);

  for (const rule of rules) {
    if (ruleMatches(rule, metadata)) {
      return {
        matched: true,
        rule,
        action: rule.target_action,
        target_model_id: rule.target_model_id,
      };
    }
  }

  return { matched: false };
}

function ruleMatches(rule: RoutingRule, metadata: RequestMetadata): boolean {
  // match_source: exact match on source field
  if (rule.match_source !== null) {
    if (metadata.source !== rule.match_source) return false;
  }

  // match_channel: exact match on channel field
  if (rule.match_channel !== null) {
    if (metadata.channel !== rule.match_channel) return false;
  }

  // match_pattern: regex match on text_preview (with safety limit)
  if (rule.match_pattern !== null) {
    try {
      const regex = new RegExp(rule.match_pattern, 'i');
      // Test against a truncated preview to bound worst-case execution time
      const preview = metadata.text_preview.slice(0, MAX_REGEX_INPUT_LENGTH);
      if (!regex.test(preview)) return false;
    } catch {
      // Invalid regex — skip this rule
      return false;
    }
  }

  // match_has_media: boolean match
  if (rule.match_has_media !== null) {
    const ruleExpectsMedia = rule.match_has_media === 1;
    if (metadata.has_media !== ruleExpectsMedia) return false;
  }

  // match_token_max: estimated tokens must be at or below this limit
  if (rule.match_token_max !== null) {
    if (metadata.estimated_tokens > rule.match_token_max) return false;
  }

  // All specified conditions passed (unspecified conditions are wildcards)
  // But a rule with NO conditions at all is a catch-all — it always matches
  return true;
}
