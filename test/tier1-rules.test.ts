import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { matchTier1Rules, invalidateRulesCache } from '../src/router/tier1-rules.js';
import type { RequestMetadata } from '../src/types.js';

let db: Database.Database;

beforeEach(() => {
  invalidateRulesCache();
  db = initDb(':memory:');
});

afterEach(() => {
  db.close();
});

function makeMetadata(overrides: Partial<RequestMetadata> = {}): RequestMetadata {
  return {
    text_preview: '',
    estimated_tokens: 100,
    has_media: false,
    source: null,
    channel: null,
    ...overrides,
  };
}

describe('Tier 1 rule matching', () => {
  it('should match heartbeat source → route_self to 1.5B (priority 10)', () => {
    const result = matchTier1Rules(db, makeMetadata({ source: 'heartbeat' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.target_model_id).toBe('local/deepseek-r1-1.5b');
      expect(result.rule.priority).toBe(10);
    }
  });

  it('should match cron source → route_self to 1.5B (priority 20)', () => {
    const result = matchTier1Rules(db, makeMetadata({ source: 'cron' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.target_model_id).toBe('local/deepseek-r1-1.5b');
      expect(result.rule.priority).toBe(20);
    }
  });

  it('should match webhook source → route_self (priority 25)', () => {
    const result = matchTier1Rules(db, makeMetadata({ source: 'webhook' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.rule.priority).toBe(25);
    }
  });

  it('should match /status command → route_self (priority 30)', () => {
    const result = matchTier1Rules(db, makeMetadata({ text_preview: '/status' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.target_model_id).toBe('local/deepseek-r1-1.5b');
      expect(result.rule.priority).toBe(30);
    }
  });

  it('should match /model command → route_self (priority 31)', () => {
    const result = matchTier1Rules(db, makeMetadata({ text_preview: '/model' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.rule.priority).toBe(31);
    }
  });

  it('should match /new command → route_self (priority 32)', () => {
    const result = matchTier1Rules(db, makeMetadata({ text_preview: '/new' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.rule.priority).toBe(32);
    }
  });

  it('should match /reset command → route_self (priority 32)', () => {
    const result = matchTier1Rules(db, makeMetadata({ text_preview: '/reset' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.rule.priority).toBe(32);
    }
  });

  it('should match simple greeting "hello" → route_self (priority 40)', () => {
    const result = matchTier1Rules(db, makeMetadata({ text_preview: 'hello' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.target_model_id).toBe('local/deepseek-r1-1.5b');
      expect(result.rule.priority).toBe(40);
    }
  });

  it('should match greeting variants: hi, hey, bye, thanks', () => {
    for (const greeting of ['hi', 'hey', 'bye', 'thanks', 'thank you', 'ok', 'gm', 'gn']) {
      const result = matchTier1Rules(db, makeMetadata({ text_preview: greeting }));
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.action).toBe('route_self');
        expect(result.rule.priority).toBe(40);
      }
    }
  });

  it('should match greeting with punctuation: "hello!"', () => {
    const result = matchTier1Rules(db, makeMetadata({ text_preview: 'hello!' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.rule.priority).toBe(40);
    }
  });

  it('should match "good morning" as greeting', () => {
    const result = matchTier1Rules(db, makeMetadata({ text_preview: 'good morning' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('route_self');
      expect(result.rule.priority).toBe(40);
    }
  });

  it('should match message with media → classify (priority 50)', () => {
    const result = matchTier1Rules(db, makeMetadata({ has_media: true, text_preview: 'check this image' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('classify');
      expect(result.rule.priority).toBe(50);
    }
  });

  it('should match code keywords → classify (priority 60)', () => {
    const keywords = [
      'function doSomething()',
      'class MyClass extends Base',
      'import React from "react"',
      'def my_function():',
      'SELECT * FROM users',
      'async function fetch()',
      'const x = 5',
      'npm install express',
      'docker compose up',
    ];
    for (const text of keywords) {
      const result = matchTier1Rules(db, makeMetadata({ text_preview: text }));
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.action).toBe('classify');
        expect(result.rule.priority).toBe(60);
      }
    }
  });

  it('should fall through to catch-all → classify (priority 99) for generic messages', () => {
    const result = matchTier1Rules(db, makeMetadata({ text_preview: 'What is the capital of France?' }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.action).toBe('classify');
      expect(result.rule.priority).toBe(99);
    }
  });

  it('should skip disabled rules', () => {
    // Disable the heartbeat rule
    db.prepare("UPDATE routing_rules SET is_enabled = 0 WHERE match_source = 'heartbeat'").run();
    invalidateRulesCache();

    const result = matchTier1Rules(db, makeMetadata({ source: 'heartbeat' }));
    // Should still match — but via catch-all, not the heartbeat rule
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.rule.priority).toBe(99); // catch-all
    }
  });

  it('should respect priority ordering (lower number = higher priority)', () => {
    // A heartbeat source with code keywords should match heartbeat rule (priority 10),
    // not code keywords rule (priority 60)
    const result = matchTier1Rules(db, makeMetadata({
      source: 'heartbeat',
      text_preview: 'function test()',
    }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.rule.priority).toBe(10);
      expect(result.rule.rule_name).toBe('Heartbeat → self');
    }
  });

  it('should not match greeting pattern for longer text containing greeting', () => {
    // "hello, can you help me write code" should NOT match the greeting rule
    // because the greeting regex requires the greeting to be the full message
    const result = matchTier1Rules(db, makeMetadata({
      text_preview: 'hello, can you help me write code',
    }));
    expect(result.matched).toBe(true);
    if (result.matched) {
      // Should match code keywords or catch-all, NOT the greeting rule
      expect(result.rule.priority).not.toBe(40);
    }
  });
});
