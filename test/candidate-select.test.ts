import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { selectCandidates, type SelectionCriteria } from '../src/router/candidate-select.js';

let db: Database.Database;

beforeEach(() => {
  db = initDb(':memory:');
});

afterEach(() => {
  db.close();
});

function makeCriteria(overrides: Partial<SelectionCriteria> = {}): SelectionCriteria {
  return {
    quality_floor: 0,
    required_capability: null,
    sensitive: false,
    estimated_tokens: 1000,
    ...overrides,
  };
}

describe('candidate selection', () => {
  it('should return all models for simple request (floor=0, no capability)', () => {
    const candidates = selectCandidates(db, makeCriteria({ quality_floor: 0 }));
    expect(candidates.length).toBe(9);
    // First candidate should be local (preferred location order: local > lan > cloud)
    expect(candidates[0].model.location).toBe('local');
  });

  it('should select cheapest local model first for simple request', () => {
    const candidates = selectCandidates(db, makeCriteria({ quality_floor: 0 }));
    // Both local models cost 0, so higher quality should win tiebreak
    // local models come first, then LAN, then cloud
    expect(candidates[0].model.location).toBe('local');
    expect(candidates[1].model.location).toBe('local');
  });

  it('should select 7B for medium coding (floor=40) if healthy', () => {
    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 40,
      required_capability: 'coding',
    }));
    // 7B (quality 45, local) should be first
    expect(candidates[0].model.model_id).toBe('local/deepseek-r1-7b');
  });

  it('should select LAN models first for complex coding (floor=65)', () => {
    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 65,
      required_capability: 'coding',
    }));
    // Both LAN models (cost 0) come before cloud; within LAN, higher quality first
    expect(candidates[0].model.location).toBe('lan');
    expect(candidates[0].model.model_id).toBe('lan/dgx-spark-70b'); // quality 78
    expect(candidates[1].model.model_id).toBe('lan/mbp-m4-32b');    // quality 68
  });

  it('should allow DGX 70B for reasoning (floor=80) via quality tolerance when cloud unavailable', () => {
    // 70B has quality 78, floor is 80, tolerance is 5 → 78 >= (80-5)=75 ✓ and costs $0
    // Tolerance only activates when no strict matches exist, so exclude cloud via sensitive flag
    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 80,
      required_capability: 'complex_logic',
      sensitive: true, // excludes cloud → no strict matches → tolerance kicks in
    }));
    expect(candidates.length).toBeGreaterThan(0);
    const dgx = candidates.find(c => c.model.model_id === 'lan/dgx-spark-70b');
    expect(dgx).toBeTruthy();
  });

  it('should skip 70B for reasoning when tolerance=0', () => {
    // Set tolerance to 0
    db.prepare('UPDATE routing_policy SET quality_tolerance = 0 WHERE id = 1').run();

    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 80,
      required_capability: 'complex_logic',
    }));
    // 70B (quality 78) should NOT be included with tolerance=0
    const dgx = candidates.find(c => c.model.model_id === 'lan/dgx-spark-70b');
    expect(dgx).toBeUndefined();
    // Cloud models with quality >= 80 should be selected instead
    if (candidates.length > 0) {
      expect(candidates[0].model.quality_score).toBeGreaterThanOrEqual(80);
    }
  });

  it('should exclude cloud models when sensitive=true', () => {
    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 0,
      sensitive: true,
    }));
    const cloudModels = candidates.filter(c => c.model.location === 'cloud');
    expect(cloudModels.length).toBe(0);
    // Should still have local and LAN models
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('should exclude unhealthy models from candidates', () => {
    // Mark the 7B as unhealthy
    db.prepare("UPDATE models SET is_healthy = 0 WHERE model_id = 'local/deepseek-r1-7b'").run();

    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 40,
      required_capability: 'coding',
    }));
    const sevenB = candidates.find(c => c.model.model_id === 'local/deepseek-r1-7b');
    expect(sevenB).toBeUndefined();
  });

  it('should exclude rate-limited provider models', () => {
    // Mark anthropic as rate-limited
    db.prepare("UPDATE provider_rate_limits SET is_rate_limited = 1 WHERE provider = 'anthropic'").run();

    const candidates = selectCandidates(db, makeCriteria({ quality_floor: 0 }));
    const anthropicModels = candidates.filter(c => c.model.provider === 'anthropic');
    expect(anthropicModels.length).toBe(0);
  });

  it('should exclude cloud models when budget is exceeded', () => {
    // Set daily budget to something low and exceed it
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "UPDATE budget_tracking SET total_spend = 15.0 WHERE period_type = 'daily' AND period_key = ?"
    ).run(today);

    const candidates = selectCandidates(db, makeCriteria({ quality_floor: 0 }));
    const cloudModels = candidates.filter(c => c.model.location === 'cloud');
    expect(cloudModels.length).toBe(0);
    // Local and LAN should still be available
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('should exclude models whose context_window is less than estimated_tokens', () => {
    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 0,
      estimated_tokens: 150000, // exceeds local (32K) and LAN (64K) context windows
    }));
    // Only cloud models with 128K+ context should remain
    for (const c of candidates) {
      expect(c.model.context_window).toBeGreaterThanOrEqual(150000);
    }
    // Should only be Anthropic (200K) and GPT-5.2 (256K) models
    expect(candidates.every(c => c.model.location === 'cloud')).toBe(true);
  });

  it('should filter by required capability — math only on Opus and GPT-5.2', () => {
    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 0,
      required_capability: 'math',
    }));
    expect(candidates.length).toBe(2);
    const ids = candidates.map(c => c.model.model_id).sort();
    expect(ids).toEqual(['anthropic/claude-opus', 'openai/gpt-5.2']);
  });

  it('should sort by location preference, then cost, then quality', () => {
    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 65,
      required_capability: 'coding',
    }));
    // Expected order: LAN (zero cost) before cloud (has cost)
    // Within LAN: both are zero cost, so higher quality wins
    // Within cloud: cheaper first, then higher quality
    expect(candidates.length).toBeGreaterThan(0);

    // Verify location ordering
    let lastLocation = -1;
    const locationOrder = ['local', 'lan', 'cloud'];
    for (const c of candidates) {
      const loc = locationOrder.indexOf(c.model.location);
      expect(loc).toBeGreaterThanOrEqual(lastLocation);
      lastLocation = loc;
    }
  });

  it('should assign correct rank values (1-based)', () => {
    const candidates = selectCandidates(db, makeCriteria({ quality_floor: 0 }));
    for (let i = 0; i < candidates.length; i++) {
      expect(candidates[i].rank).toBe(i + 1);
    }
  });

  it('should return empty array when no models meet criteria', () => {
    // Set an impossibly high quality floor with tolerance=0
    db.prepare('UPDATE routing_policy SET quality_tolerance = 0 WHERE id = 1').run();

    const candidates = selectCandidates(db, makeCriteria({
      quality_floor: 100,
      required_capability: 'nonexistent_capability',
    }));
    expect(candidates.length).toBe(0);
  });
});
