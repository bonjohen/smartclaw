import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { getFallbackCandidate } from '../src/router/tier3-fallback.js';

let db: Database.Database;

beforeEach(() => {
  db = initDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('getFallbackCandidate', () => {
  it('should return the configured fallback model', () => {
    const result = getFallbackCandidate(db);

    expect(result).toHaveLength(1);
    expect(result[0].model.model_id).toBe('anthropic/claude-sonnet');
    expect(result[0].rank).toBe(1);
    expect(result[0].score).toBe(82); // claude-sonnet quality_score
  });

  it('should return empty array when fallback model is unhealthy', () => {
    db.prepare("UPDATE models SET is_healthy = 0 WHERE model_id = 'anthropic/claude-sonnet'").run();

    const result = getFallbackCandidate(db);
    expect(result).toHaveLength(0);
  });

  it('should return empty array when fallback model is disabled', () => {
    db.prepare("UPDATE models SET is_enabled = 0 WHERE model_id = 'anthropic/claude-sonnet'").run();

    const result = getFallbackCandidate(db);
    expect(result).toHaveLength(0);
  });

  it('should return empty array when fallback_model_id is null', () => {
    db.prepare('UPDATE routing_policy SET fallback_model_id = NULL WHERE id = 1').run();

    const result = getFallbackCandidate(db);
    expect(result).toHaveLength(0);
  });

  it('should return empty array when fallback model is both disabled and unhealthy', () => {
    db.prepare(
      "UPDATE models SET is_enabled = 0, is_healthy = 0 WHERE model_id = 'anthropic/claude-sonnet'"
    ).run();

    const result = getFallbackCandidate(db);
    expect(result).toHaveLength(0);
  });

  it('should return the model with correct score matching quality_score', () => {
    // Change fallback to a different model
    db.prepare("UPDATE routing_policy SET fallback_model_id = 'anthropic/claude-opus' WHERE id = 1").run();

    const result = getFallbackCandidate(db);

    expect(result).toHaveLength(1);
    expect(result[0].model.model_id).toBe('anthropic/claude-opus');
    expect(result[0].score).toBe(95); // opus quality_score
  });
});
