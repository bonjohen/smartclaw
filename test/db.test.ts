import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, runMigrations } from '../src/db.js';
import type {
  ModelRecord,
  RoutingRule,
  RoutingPolicy,
  BudgetTrackingRow,
  ProviderRateLimitRow,
} from '../src/types.js';

let db: Database.Database;

beforeEach(() => {
  db = initDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('migrations', () => {
  it('should run without error on in-memory DB', () => {
    // If we got here, initDb succeeded
    expect(db.open).toBe(true);
  });

  it('should track applied migrations in _migrations table', () => {
    const rows = db.prepare('SELECT filename FROM _migrations ORDER BY filename').all() as { filename: string }[];
    expect(rows.length).toBe(2);
    expect(rows[0].filename).toBe('001_initial.sql');
    expect(rows[1].filename).toBe('002_seed.sql');
  });

  it('should not re-apply migrations on second init', () => {
    // Running migrations again should be a no-op (no duplicate insert errors)
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('models seed data', () => {
  it('should contain all 9 models', () => {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM models').get() as { cnt: number };
    expect(count.cnt).toBe(9);
  });

  it('should have 2 local models', () => {
    const rows = db.prepare("SELECT model_id FROM models WHERE location = 'local' ORDER BY model_id").all() as ModelRecord[];
    expect(rows.length).toBe(2);
    expect(rows[0].model_id).toBe('local/deepseek-r1-1.5b');
    expect(rows[1].model_id).toBe('local/deepseek-r1-7b');
  });

  it('should have 2 LAN models', () => {
    const rows = db.prepare("SELECT model_id FROM models WHERE location = 'lan' ORDER BY model_id").all() as ModelRecord[];
    expect(rows.length).toBe(2);
    expect(rows[0].model_id).toBe('lan/dgx-spark-70b');
    expect(rows[1].model_id).toBe('lan/mbp-m4-32b');
  });

  it('should have 5 cloud models', () => {
    const rows = db.prepare("SELECT model_id FROM models WHERE location = 'cloud' ORDER BY model_id").all() as ModelRecord[];
    expect(rows.length).toBe(5);
  });

  it('should have correct quality scores for key models', () => {
    const get = (id: string) =>
      db.prepare('SELECT quality_score FROM models WHERE model_id = ?').get(id) as { quality_score: number };

    expect(get('local/deepseek-r1-1.5b').quality_score).toBe(25);
    expect(get('local/deepseek-r1-7b').quality_score).toBe(45);
    expect(get('lan/mbp-m4-32b').quality_score).toBe(68);
    expect(get('lan/dgx-spark-70b').quality_score).toBe(78);
    expect(get('anthropic/claude-sonnet').quality_score).toBe(82);
    expect(get('anthropic/claude-opus').quality_score).toBe(95);
  });

  it('should have all models enabled and healthy by default', () => {
    const rows = db.prepare('SELECT model_id FROM models WHERE is_enabled = 0 OR is_healthy = 0').all();
    expect(rows.length).toBe(0);
  });

  it('should have zero cost for local and LAN models', () => {
    const rows = db.prepare(
      "SELECT model_id FROM models WHERE location IN ('local','lan') AND (cost_input > 0 OR cost_output > 0)"
    ).all();
    expect(rows.length).toBe(0);
  });

  it('should have non-zero cost for cloud models', () => {
    const rows = db.prepare(
      "SELECT model_id FROM models WHERE location = 'cloud' AND cost_output = 0"
    ).all();
    expect(rows.length).toBe(0);
  });
});

describe('model capabilities', () => {
  it('should have capabilities linked to all models', () => {
    const modelsWithCaps = db.prepare(
      'SELECT DISTINCT model_id FROM model_capabilities'
    ).all() as { model_id: string }[];
    expect(modelsWithCaps.length).toBe(9);
  });

  it('should have 1.5B with classification capability', () => {
    const row = db.prepare(
      "SELECT 1 as ok FROM model_capabilities WHERE model_id = 'local/deepseek-r1-1.5b' AND capability = 'classification'"
    ).get();
    expect(row).toBeTruthy();
  });

  it('should have coding capability on 7B, 32B, 70B, and all cloud models', () => {
    const rows = db.prepare(
      "SELECT model_id FROM model_capabilities WHERE capability = 'coding' ORDER BY model_id"
    ).all() as { model_id: string }[];
    // 7B, 32B, 70B, Haiku, Sonnet, Opus, GPT-4o, GPT-5.2 = 8
    expect(rows.length).toBe(8);
    expect(rows.map(r => r.model_id)).toContain('local/deepseek-r1-7b');
    expect(rows.map(r => r.model_id)).toContain('lan/mbp-m4-32b');
    expect(rows.map(r => r.model_id)).toContain('lan/dgx-spark-70b');
  });

  it('should have math capability only on Opus and GPT-5.2', () => {
    const rows = db.prepare(
      "SELECT model_id FROM model_capabilities WHERE capability = 'math' ORDER BY model_id"
    ).all() as { model_id: string }[];
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.model_id)).toEqual(['anthropic/claude-opus', 'openai/gpt-5.2']);
  });
});

describe('routing rules', () => {
  it('should have all seeded rules', () => {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM routing_rules').get() as { cnt: number };
    expect(count.cnt).toBe(10);
  });

  it('should have rules in correct priority order', () => {
    const rows = db.prepare(
      'SELECT rule_name, priority FROM routing_rules ORDER BY priority'
    ).all() as { rule_name: string; priority: number }[];

    expect(rows[0].priority).toBe(10);
    expect(rows[0].rule_name).toBe('Heartbeat → self');
    expect(rows[rows.length - 1].priority).toBe(99);
    expect(rows[rows.length - 1].rule_name).toBe('Catch-all → classify');
  });

  it('should have heartbeat rule targeting 1.5B with route_self', () => {
    const row = db.prepare(
      "SELECT target_model_id, target_action FROM routing_rules WHERE match_source = 'heartbeat'"
    ).get() as RoutingRule;
    expect(row.target_model_id).toBe('local/deepseek-r1-1.5b');
    expect(row.target_action).toBe('route_self');
  });

  it('should have all rules enabled by default', () => {
    const disabled = db.prepare('SELECT COUNT(*) as cnt FROM routing_rules WHERE is_enabled = 0').get() as { cnt: number };
    expect(disabled.cnt).toBe(0);
  });
});

describe('routing policy', () => {
  it('should have a singleton policy row', () => {
    const row = db.prepare('SELECT * FROM routing_policy').get() as RoutingPolicy;
    expect(row).toBeTruthy();
    expect(row.id).toBe(1);
  });

  it('should have expected default values', () => {
    const row = db.prepare('SELECT * FROM routing_policy').get() as RoutingPolicy;
    expect(row.min_quality_score).toBe(0);
    expect(row.quality_tolerance).toBe(5);
    expect(row.prefer_location_order).toBe('local,lan,cloud');
    expect(row.budget_daily_usd).toBe(10.0);
    expect(row.budget_monthly_usd).toBe(200.0);
    expect(row.fallback_model_id).toBe('anthropic/claude-sonnet');
    expect(row.router_model_id).toBe('local/deepseek-r1-1.5b');
  });
});

describe('budget tracking', () => {
  it('should have daily and monthly seed rows', () => {
    const rows = db.prepare('SELECT * FROM budget_tracking ORDER BY period_type').all() as BudgetTrackingRow[];
    expect(rows.length).toBe(2);
    expect(rows[0].period_type).toBe('daily');
    expect(rows[1].period_type).toBe('monthly');
  });

  it('should start with zero spend', () => {
    const rows = db.prepare('SELECT * FROM budget_tracking').all() as BudgetTrackingRow[];
    for (const row of rows) {
      expect(row.total_spend).toBe(0);
      expect(row.total_input_tokens).toBe(0);
      expect(row.total_output_tokens).toBe(0);
      expect(row.request_count).toBe(0);
    }
  });
});

describe('lookup tables', () => {
  it('should have complexity_quality_map with 4 entries', () => {
    const rows = db.prepare('SELECT * FROM complexity_quality_map ORDER BY quality_floor').all() as { complexity: string; quality_floor: number }[];
    expect(rows.length).toBe(4);
    expect(rows[0]).toEqual({ complexity: 'simple', quality_floor: 0 });
    expect(rows[1]).toEqual({ complexity: 'medium', quality_floor: 40 });
    expect(rows[2]).toEqual({ complexity: 'complex', quality_floor: 65 });
    expect(rows[3]).toEqual({ complexity: 'reasoning', quality_floor: 80 });
  });

  it('should have task_capability_map with 12 entries', () => {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM task_capability_map').get() as { cnt: number };
    expect(count.cnt).toBe(12);
  });

  it('should map coding task to coding capability', () => {
    const row = db.prepare("SELECT capability FROM task_capability_map WHERE task_type = 'coding'").get() as { capability: string };
    expect(row.capability).toBe('coding');
  });

  it('should map reasoning task to complex_logic capability', () => {
    const row = db.prepare("SELECT capability FROM task_capability_map WHERE task_type = 'reasoning'").get() as { capability: string };
    expect(row.capability).toBe('complex_logic');
  });
});

describe('provider rate limits', () => {
  it('should have entries for all 3 providers', () => {
    const rows = db.prepare('SELECT provider FROM provider_rate_limits ORDER BY provider').all() as ProviderRateLimitRow[];
    expect(rows.length).toBe(3);
    expect(rows.map(r => r.provider)).toEqual(['anthropic', 'deepseek', 'openai']);
  });

  it('should start with no rate limits active', () => {
    const limited = db.prepare('SELECT COUNT(*) as cnt FROM provider_rate_limits WHERE is_rate_limited = 1').get() as { cnt: number };
    expect(limited.cnt).toBe(0);
  });
});
