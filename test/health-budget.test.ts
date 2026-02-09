import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import {
  markHealthy,
  markUnhealthyCheck,
  checkAllModels,
} from '../src/health/health-checker.js';
import {
  recordRequestCost,
  calculateCost,
  isBudgetExceeded,
  getBudgetStatus,
} from '../src/health/budget-tracker.js';
import { selectCandidates } from '../src/router/candidate-select.js';
import type { ModelRecord } from '../src/types.js';

let db: Database.Database;

beforeEach(() => {
  db = initDb(':memory:');
});

afterEach(() => {
  db.close();
});

function getModel(id: string): ModelRecord {
  return db.prepare('SELECT * FROM models WHERE model_id = ?').get(id) as ModelRecord;
}

// ── Health checker ──

describe('markHealthy', () => {
  it('should mark model as healthy with latency recorded', () => {
    markHealthy(db, 'local/deepseek-r1-1.5b', 42);

    const model = getModel('local/deepseek-r1-1.5b');
    expect(model.is_healthy).toBe(1);
    expect(model.last_health_check).toBeTruthy();

    const log = db.prepare(
      "SELECT * FROM model_health_log WHERE model_id = 'local/deepseek-r1-1.5b' ORDER BY id DESC LIMIT 1"
    ).get() as any;
    expect(log.is_healthy).toBe(1);
    expect(log.latency_ms).toBe(42);
    expect(log.consecutive_failures).toBe(0);
  });

  it('should reset consecutive failures on recovery', () => {
    // Simulate 2 failures then recovery
    markUnhealthyCheck(db, 'local/deepseek-r1-1.5b', 'err1');
    markUnhealthyCheck(db, 'local/deepseek-r1-1.5b', 'err2');
    markHealthy(db, 'local/deepseek-r1-1.5b', 50);

    const log = db.prepare(
      "SELECT * FROM model_health_log WHERE model_id = 'local/deepseek-r1-1.5b' ORDER BY id DESC LIMIT 1"
    ).get() as any;
    expect(log.consecutive_failures).toBe(0);
    expect(log.is_healthy).toBe(1);

    const model = getModel('local/deepseek-r1-1.5b');
    expect(model.is_healthy).toBe(1);
  });
});

describe('markUnhealthyCheck', () => {
  it('should increment consecutive_failures on each failure', () => {
    markUnhealthyCheck(db, 'local/deepseek-r1-1.5b', 'connection refused');

    const log = db.prepare(
      "SELECT * FROM model_health_log WHERE model_id = 'local/deepseek-r1-1.5b' ORDER BY id DESC LIMIT 1"
    ).get() as any;
    expect(log.consecutive_failures).toBe(1);
    expect(log.is_healthy).toBe(0);
    expect(log.error_msg).toBe('connection refused');
  });

  it('should keep model healthy until 3 consecutive failures', () => {
    // 1st failure
    markUnhealthyCheck(db, 'local/deepseek-r1-7b', 'err1');
    let model = getModel('local/deepseek-r1-7b');
    expect(model.is_healthy).toBe(1); // still healthy

    // 2nd failure
    markUnhealthyCheck(db, 'local/deepseek-r1-7b', 'err2');
    model = getModel('local/deepseek-r1-7b');
    expect(model.is_healthy).toBe(1); // still healthy

    // 3rd failure — should now be unhealthy
    markUnhealthyCheck(db, 'local/deepseek-r1-7b', 'err3');
    model = getModel('local/deepseek-r1-7b');
    expect(model.is_healthy).toBe(0);
  });

  it('should record error message in health log', () => {
    markUnhealthyCheck(db, 'lan/mbp-m4-32b', 'ECONNREFUSED');

    const log = db.prepare(
      "SELECT error_msg FROM model_health_log WHERE model_id = 'lan/mbp-m4-32b' ORDER BY id DESC LIMIT 1"
    ).get() as any;
    expect(log.error_msg).toBe('ECONNREFUSED');
  });
});

describe('checkAllModels', () => {
  it('should ping all enabled models and update health', async () => {
    // Mock fetch: succeed for local, fail for everything else
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('127.0.0.1')) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('connection refused'));
    });

    await checkAllModels(db);

    // Local models should be healthy (pinged 127.0.0.1)
    const local = getModel('local/deepseek-r1-1.5b');
    expect(local.is_healthy).toBe(1);

    // After 1 failure, LAN/cloud models still healthy (need 3 consecutive)
    const lan = getModel('lan/mbp-m4-32b');
    expect(lan.is_healthy).toBe(1);

    globalThis.fetch = originalFetch;
  });

  it('should mark model unhealthy after 3 consecutive failed checks', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    // Run 3 check cycles
    await checkAllModels(db);
    await checkAllModels(db);
    await checkAllModels(db);

    const model = getModel('local/deepseek-r1-1.5b');
    expect(model.is_healthy).toBe(0);

    const log = db.prepare(
      "SELECT consecutive_failures FROM model_health_log WHERE model_id = 'local/deepseek-r1-1.5b' ORDER BY id DESC LIMIT 1"
    ).get() as any;
    expect(log.consecutive_failures).toBe(3);

    globalThis.fetch = originalFetch;
  });

  it('should recover model health after successful ping', async () => {
    const originalFetch = globalThis.fetch;

    // Fail 3 times
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    await checkAllModels(db);
    await checkAllModels(db);
    await checkAllModels(db);

    let model = getModel('local/deepseek-r1-1.5b');
    expect(model.is_healthy).toBe(0);

    // Now succeed
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    await checkAllModels(db);

    model = getModel('local/deepseek-r1-1.5b');
    expect(model.is_healthy).toBe(1);

    globalThis.fetch = originalFetch;
  });
});

// ── Budget tracker ──

describe('calculateCost', () => {
  it('should calculate correct cost for known token counts', () => {
    const sonnet = getModel('anthropic/claude-sonnet');
    // cost_input=3.0, cost_output=15.0 per million tokens
    const cost = calculateCost(sonnet, 1000, 500);
    // (1000 * 3.0 + 500 * 15.0) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
    expect(cost).toBeCloseTo(0.0105);
  });

  it('should return 0 for zero-cost models', () => {
    const local = getModel('local/deepseek-r1-1.5b');
    const cost = calculateCost(local, 5000, 2000);
    expect(cost).toBe(0);
  });

  it('should handle large token counts', () => {
    const opus = getModel('anthropic/claude-opus');
    // cost_input=15.0, cost_output=75.0 per million tokens
    const cost = calculateCost(opus, 100000, 50000);
    // (100000 * 15.0 + 50000 * 75.0) / 1_000_000 = (1500000 + 3750000) / 1_000_000 = 5.25
    expect(cost).toBeCloseTo(5.25);
  });
});

describe('recordRequestCost', () => {
  it('should accumulate cost across multiple requests', () => {
    const sonnet = getModel('anthropic/claude-sonnet');

    recordRequestCost(db, sonnet, 1000, 500);
    recordRequestCost(db, sonnet, 2000, 1000);

    const today = new Date().toISOString().slice(0, 10);
    const daily = db.prepare(
      "SELECT * FROM budget_tracking WHERE period_type = 'daily' AND period_key = ?"
    ).get(today) as any;

    expect(daily.request_count).toBeGreaterThanOrEqual(2);
    expect(daily.total_input_tokens).toBeGreaterThanOrEqual(3000);
    expect(daily.total_output_tokens).toBeGreaterThanOrEqual(1500);
    expect(daily.total_spend).toBeGreaterThan(0);
  });

  it('should update both daily and monthly tracking', () => {
    const sonnet = getModel('anthropic/claude-sonnet');
    recordRequestCost(db, sonnet, 1000, 500);

    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    const daily = db.prepare(
      "SELECT total_spend FROM budget_tracking WHERE period_type = 'daily' AND period_key = ?"
    ).get(today) as any;
    const monthly = db.prepare(
      "SELECT total_spend FROM budget_tracking WHERE period_type = 'monthly' AND period_key = ?"
    ).get(month) as any;

    expect(daily.total_spend).toBeGreaterThan(0);
    expect(monthly.total_spend).toBeGreaterThan(0);
  });

  it('should return 0 cost for free models without updating budget', () => {
    const local = getModel('local/deepseek-r1-1.5b');
    const cost = recordRequestCost(db, local, 5000, 2000);
    expect(cost).toBe(0);
  });
});

describe('isBudgetExceeded', () => {
  it('should return false when under budget', () => {
    expect(isBudgetExceeded(db)).toBe(false);
  });

  it('should return true when daily limit exceeded', () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "UPDATE budget_tracking SET total_spend = 15.0 WHERE period_type = 'daily' AND period_key = ?"
    ).run(today);

    expect(isBudgetExceeded(db)).toBe(true);
  });

  it('should return true when monthly limit exceeded', () => {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    db.prepare(
      "UPDATE budget_tracking SET total_spend = 250.0 WHERE period_type = 'monthly' AND period_key = ?"
    ).run(month);

    expect(isBudgetExceeded(db)).toBe(true);
  });
});

describe('getBudgetStatus', () => {
  it('should return complete budget summary', () => {
    const status = getBudgetStatus(db);
    expect(status.daily_limit).toBe(10.0);
    expect(status.monthly_limit).toBe(200.0);
    expect(status.daily_spend).toBe(0);
    expect(status.monthly_spend).toBe(0);
    expect(status.is_exceeded).toBe(false);
  });

  it('should reflect accumulated spend', () => {
    const sonnet = getModel('anthropic/claude-sonnet');
    recordRequestCost(db, sonnet, 100000, 50000);

    const status = getBudgetStatus(db);
    expect(status.daily_spend).toBeGreaterThan(0);
    expect(status.monthly_spend).toBeGreaterThan(0);
  });
});

// ── Integration: budget gating in candidate selection ──

describe('budget gating integration', () => {
  it('should exclude cloud models from candidates when budget exceeded', () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "UPDATE budget_tracking SET total_spend = 15.0 WHERE period_type = 'daily' AND period_key = ?"
    ).run(today);

    const candidates = selectCandidates(db, {
      quality_floor: 0,
      required_capability: null,
      sensitive: false,
      estimated_tokens: 1000,
    });

    const cloud = candidates.filter(c => c.model.location === 'cloud');
    expect(cloud.length).toBe(0);
    expect(candidates.length).toBeGreaterThan(0); // local/LAN still available
  });
});
