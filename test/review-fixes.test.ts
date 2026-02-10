import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { clearExpiredRateLimits } from '../src/router/candidate-select.js';
import { selectCandidates } from '../src/router/candidate-select.js';
import { isServerError } from '../src/backends/route-with-retry.js';
import { cleanupOldLogs } from '../src/health/health-checker.js';
import { matchTier1Rules, invalidateRulesCache } from '../src/router/tier1-rules.js';
import { extractMetadata } from '../src/router/router.js';
import type { FastifyInstance } from 'fastify';
import type { RouterOptions } from '../src/router/router.js';
import type { ChatCompletionChunk, RoutingDecision, ModelRecord, RequestMetadata, ChatRequest } from '../src/types.js';

// Mock both the router and backend retry for controlled testing
vi.mock('../src/router/router.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    routeRequest: vi.fn(),
  };
});

vi.mock('../src/backends/route-with-retry.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    routeWithRetry: vi.fn(),
  };
});

import { routeRequest } from '../src/router/router.js';
import { routeWithRetry } from '../src/backends/route-with-retry.js';

const mockRouteRequest = vi.mocked(routeRequest);
const mockRouteWithRetry = vi.mocked(routeWithRetry);

let db: Database.Database;
let app: FastifyInstance;

const routerOptions: RouterOptions = {
  classifyOptions: {
    ollamaEndpoint: 'http://127.0.0.1:11434',
    modelName: 'deepseek-r1:1.5b',
  },
};

function getModel(id: string): ModelRecord {
  return db.prepare('SELECT * FROM models WHERE model_id = ?').get(id) as ModelRecord;
}

function makeDecision(modelId: string, tier: 1 | 2 | 3 = 1): RoutingDecision {
  const model = getModel(modelId);
  return {
    tier_used: tier,
    selected_model: modelId,
    classification: tier >= 2 ? { complexity: 'medium', task_type: 'coding', estimated_tokens: 500, sensitive: false } : null,
    rule_id: tier === 1 ? 1 : null,
    candidates: [{ model, score: model.quality_score, rank: 1 }],
  };
}

function makeMockStream(chunks: ChatCompletionChunk[], modelId: string) {
  const model = getModel(modelId);
  return {
    stream: (async function* () { for (const c of chunks) yield c; })(),
    model_id: modelId,
    model,
    abort: vi.fn(),
  };
}

function makeErrorStream(modelId: string, error: Error) {
  const model = getModel(modelId);
  return {
    stream: (async function* () { throw error; })(),
    model_id: modelId,
    model,
    abort: vi.fn(),
  };
}

function makeChunk(content: string, finish: string | null = null, usage?: any): ChatCompletionChunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'test',
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

beforeEach(async () => {
  db = initDb(':memory:');
  app = createServer({ db, routerOptions, logger: false });
  await app.ready();
  mockRouteRequest.mockReset();
  mockRouteWithRetry.mockReset();
});

afterEach(async () => {
  await app.close();
  db.close();
});

// ── Critical #1 & High #5: Stream/non-stream error logging ──

describe('error success logging', () => {
  it('should log success=false when streaming response throws an error', async () => {
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    mockRouteWithRetry.mockResolvedValue(
      makeErrorStream('local/deepseek-r1-1.5b', new Error('backend crashed'))
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    const log = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get() as any;
    expect(log).toBeTruthy();
    expect(log.success).toBe(0);
  });

  it('should log success=true when streaming completes normally', async () => {
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream([makeChunk('Hello', 'stop')], 'local/deepseek-r1-1.5b')
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    const log = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get() as any;
    expect(log.success).toBe(1);
  });

  it('should return 502 when non-streaming backend returns empty chunks', async () => {
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream([], 'local/deepseek-r1-1.5b')
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(502);
    const log = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get() as any;
    expect(log.success).toBe(0);
  });
});

// ── Critical #2: Rate limit auto-expiry ──

describe('rate limit auto-expiry', () => {
  it('should clear expired rate limits', () => {
    // Mark anthropic as rate limited with retry_after in the past
    db.prepare(`
      UPDATE provider_rate_limits
      SET is_rate_limited = 1,
          limited_since = datetime('now', '-120 seconds'),
          retry_after = datetime('now', '-60 seconds')
      WHERE provider = 'anthropic'
    `).run();

    // Verify it's rate limited
    const before = db.prepare(
      "SELECT is_rate_limited FROM provider_rate_limits WHERE provider = 'anthropic'"
    ).get() as any;
    expect(before.is_rate_limited).toBe(1);

    // Clear expired
    clearExpiredRateLimits(db);

    const after = db.prepare(
      "SELECT is_rate_limited FROM provider_rate_limits WHERE provider = 'anthropic'"
    ).get() as any;
    expect(after.is_rate_limited).toBe(0);
  });

  it('should NOT clear rate limits that have not expired yet', () => {
    db.prepare(`
      UPDATE provider_rate_limits
      SET is_rate_limited = 1,
          limited_since = CURRENT_TIMESTAMP,
          retry_after = datetime('now', '+60 seconds')
      WHERE provider = 'anthropic'
    `).run();

    clearExpiredRateLimits(db);

    const row = db.prepare(
      "SELECT is_rate_limited FROM provider_rate_limits WHERE provider = 'anthropic'"
    ).get() as any;
    expect(row.is_rate_limited).toBe(1);
  });

  it('should include previously rate-limited provider in candidates after expiry', () => {
    // Rate limit anthropic with expired retry_after
    db.prepare(`
      UPDATE provider_rate_limits
      SET is_rate_limited = 1,
          limited_since = datetime('now', '-120 seconds'),
          retry_after = datetime('now', '-60 seconds')
      WHERE provider = 'anthropic'
    `).run();

    // Select candidates — should include anthropic models since limit is expired
    const candidates = selectCandidates(db, {
      quality_floor: 0,
      required_capability: null,
      sensitive: false,
      estimated_tokens: 1000,
    });

    const anthropicCandidates = candidates.filter(c => c.model.provider === 'anthropic');
    expect(anthropicCandidates.length).toBeGreaterThan(0);
  });
});

// ── Critical #3: Cost logged for correct model after retry ──

describe('cost tracking uses actual model', () => {
  it('should log cost based on actual serving model, not first candidate', async () => {
    // Create a decision with two candidates: free local (first) and paid cloud (second)
    const localModel = getModel('local/deepseek-r1-1.5b');
    const sonnetModel = getModel('anthropic/claude-sonnet');
    const decision: RoutingDecision = {
      tier_used: 2,
      selected_model: 'local/deepseek-r1-1.5b',
      classification: { complexity: 'medium', task_type: 'coding', estimated_tokens: 500, sensitive: false },
      rule_id: null,
      candidates: [
        { model: localModel, score: 25, rank: 1 },
        { model: sonnetModel, score: 82, rank: 2 },
      ],
    };
    mockRouteRequest.mockResolvedValue(decision);

    // routeWithRetry returns sonnet (simulating local failure + sonnet success)
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream(
        [makeChunk('response', 'stop', { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 })],
        'anthropic/claude-sonnet'
      )
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });

    const log = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get() as any;
    // Sonnet: cost_input=3.0, cost_output=15.0 per million tokens
    // (1000 * 3.0 + 500 * 15.0) / 1_000_000 = 0.0105
    expect(log.cost_usd).toBeCloseTo(0.0105);
    expect(log.cost_usd).toBeGreaterThan(0); // NOT 0 (which it would be if using local model)
  });
});

// ── Critical #4: Spoofable headers ──

describe('routing header security', () => {
  it('should strip untrusted x-router-source headers', async () => {
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream([makeChunk('ok', 'stop')], 'local/deepseek-r1-1.5b')
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-router-source': 'malicious-client',
      },
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });

    // The routeRequest should have been called without the spoofed source
    const calledRequest = mockRouteRequest.mock.calls[0]?.[1];
    expect(calledRequest?.source).toBeUndefined();
  });

  it('should allow trusted x-router-source headers', async () => {
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream([makeChunk('ok', 'stop')], 'local/deepseek-r1-1.5b')
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-router-source': 'heartbeat',
      },
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });

    const calledRequest = mockRouteRequest.mock.calls[0]?.[1];
    expect(calledRequest?.source).toBe('heartbeat');
  });
});

// ── High #1: Bearer token authentication ──

describe('bearer token authentication', () => {
  let authedApp: FastifyInstance;

  beforeEach(async () => {
    authedApp = createServer({ db, routerOptions, apiKey: 'test-secret-key', logger: false });
    await authedApp.ready();
  });

  afterEach(async () => {
    await authedApp.close();
  });

  it('should return 401 when no Authorization header is provided', async () => {
    const res = await authedApp.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe('authentication_error');
  });

  it('should return 401 when wrong API key is provided', async () => {
    const res = await authedApp.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should allow access with correct API key', async () => {
    const res = await authedApp.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer test-secret-key' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should allow /health without authentication', async () => {
    const res = await authedApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('should not require auth when no apiKey is configured', async () => {
    // The default `app` (from beforeEach) has no apiKey
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);
  });
});

// ── High #4: Server error detection ──

describe('isServerError', () => {
  it('should detect 500 status', () => {
    const err = new Error('Internal Server Error');
    (err as any).status = 500;
    expect(isServerError(err)).toBe(true);
  });

  it('should detect 502 status', () => {
    const err = new Error('Bad Gateway');
    (err as any).status = 502;
    expect(isServerError(err)).toBe(true);
  });

  it('should detect 503 status', () => {
    const err = new Error('Service Unavailable');
    (err as any).status = 503;
    expect(isServerError(err)).toBe(true);
  });

  it('should not detect 429 as server error', () => {
    const err = new Error('Too Many Requests');
    (err as any).status = 429;
    expect(isServerError(err)).toBe(false);
  });

  it('should not detect 400 as server error', () => {
    const err = new Error('Bad Request');
    (err as any).status = 400;
    expect(isServerError(err)).toBe(false);
  });

  it('should not detect errors without status', () => {
    expect(isServerError(new Error('network error'))).toBe(false);
  });
});

// ── High #2: Deduplicated isBudgetExceeded ──

describe('deduplicated budget check', () => {
  it('should exclude cloud models when budget exceeded via shared isBudgetExceeded', () => {
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
    expect(candidates.length).toBeGreaterThan(0);
  });
});

// ── Medium: Input validation via JSON schema ──

describe('request body schema validation', () => {
  it('should reject messages with wrong role type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 123, content: 'Hello' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should reject messages with wrong content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: [1, 2, 3] }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should reject negative max_tokens', async () => {
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: -5,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should reject temperature out of range', async () => {
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 5.0,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── Medium: Log table cleanup ──

describe('log table cleanup', () => {
  it('should delete old health logs while preserving recent ones', () => {
    // Insert an old health log (8 days ago) and a recent one
    db.prepare(`
      INSERT INTO model_health_log (model_id, is_healthy, latency_ms, consecutive_failures, checked_at)
      VALUES ('local/deepseek-r1-1.5b', 1, 50, 0, datetime('now', '-8 days'))
    `).run();
    db.prepare(`
      INSERT INTO model_health_log (model_id, is_healthy, latency_ms, consecutive_failures, checked_at)
      VALUES ('local/deepseek-r1-1.5b', 1, 50, 0, datetime('now', '-1 day'))
    `).run();

    const beforeCount = (db.prepare('SELECT COUNT(*) as count FROM model_health_log').get() as any).count;

    const result = cleanupOldLogs(db);

    const afterCount = (db.prepare('SELECT COUNT(*) as count FROM model_health_log').get() as any).count;
    expect(result.healthLogsDeleted).toBeGreaterThanOrEqual(1);
    expect(afterCount).toBeLessThan(beforeCount);
    // Recent entry should still exist
    expect(afterCount).toBeGreaterThanOrEqual(1);
  });

  it('should delete old request logs while preserving recent ones', () => {
    // Insert an old request log (31 days ago) and a recent one
    db.prepare(`
      INSERT INTO request_log (source, tier_used, selected_model, success, latency_ms, request_at)
      VALUES ('test', 1, 'local/deepseek-r1-1.5b', 1, 50, datetime('now', '-31 days'))
    `).run();
    db.prepare(`
      INSERT INTO request_log (source, tier_used, selected_model, success, latency_ms, request_at)
      VALUES ('test', 1, 'local/deepseek-r1-1.5b', 1, 50, datetime('now', '-1 day'))
    `).run();

    const result = cleanupOldLogs(db);

    expect(result.requestLogsDeleted).toBeGreaterThanOrEqual(1);
    const remaining = (db.prepare('SELECT COUNT(*) as count FROM request_log').get() as any).count;
    expect(remaining).toBeGreaterThanOrEqual(1);
  });
});

// ── Medium: Tier1 rules caching ──

describe('tier1 rules caching', () => {
  it('should return same results from cached rules', () => {
    invalidateRulesCache();
    const metadata: RequestMetadata = {
      text_preview: 'hello',
      estimated_tokens: 10,
      has_media: false,
      source: null,
      channel: null,
    };

    const result1 = matchTier1Rules(db, metadata);
    const result2 = matchTier1Rules(db, metadata);
    expect(result1).toEqual(result2);
  });

  it('should reflect DB changes after cache invalidation', () => {
    invalidateRulesCache();
    const metadata: RequestMetadata = {
      text_preview: '',
      estimated_tokens: 10,
      has_media: false,
      source: 'heartbeat',
      channel: null,
    };

    const before = matchTier1Rules(db, metadata);
    expect(before.matched).toBe(true);
    if (before.matched) expect(before.rule.priority).toBe(10);

    // Disable heartbeat rule
    db.prepare("UPDATE routing_rules SET is_enabled = 0 WHERE match_source = 'heartbeat'").run();
    invalidateRulesCache();

    const after = matchTier1Rules(db, metadata);
    expect(after.matched).toBe(true);
    if (after.matched) expect(after.rule.priority).not.toBe(10);
  });
});

// ── Low: Media detection uses structured content, not regex ──

describe('media detection', () => {
  it('should not detect media from string content containing "[image]"', () => {
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Click on [image] above to see the result' }],
    };
    const metadata = extractMetadata(request);
    expect(metadata.has_media).toBe(false);
  });

  it('should not detect media from string content containing "[file]"', () => {
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Put the [file] in the folder' }],
    };
    const metadata = extractMetadata(request);
    expect(metadata.has_media).toBe(false);
  });

  it('should detect media from array-type content', () => {
    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: ['image data'] as any }],
    };
    const metadata = extractMetadata(request);
    expect(metadata.has_media).toBe(true);
  });
});

// ── Low: Stats endpoint does not expose request_preview ──

describe('stats PII redaction', () => {
  it('should not include request_preview in /stats recent_requests', async () => {
    // Insert a request log with known preview text
    db.prepare(`
      INSERT INTO request_log (source, tier_used, selected_model, success, latency_ms, request_preview)
      VALUES ('test', 1, 'local/deepseek-r1-1.5b', 1, 50, 'This is sensitive user content')
    `).run();

    // We need to register stats endpoint on our test app
    const { registerStats } = await import('../src/routes/stats.js');
    // Create a fresh server with stats
    const statsApp = createServer({ db, routerOptions, logger: false });
    registerStats(statsApp, db);
    await statsApp.ready();

    const res = await statsApp.inject({ method: 'GET', url: '/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Verify recent_requests exists but no entry contains request_preview
    expect(body.recent_requests.length).toBeGreaterThan(0);
    for (const req of body.recent_requests) {
      expect(req).not.toHaveProperty('request_preview');
    }

    await statsApp.close();
  });
});
