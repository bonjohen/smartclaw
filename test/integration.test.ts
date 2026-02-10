import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { registerStats } from '../src/routes/stats.js';
import type { FastifyInstance } from 'fastify';
import type { RouterOptions } from '../src/router/router.js';
import type { ChatCompletionChunk, RoutingDecision, ModelRecord } from '../src/types.js';

// Mock both the router and backend retry for controlled integration testing
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
    abort: () => {},
  };
}

function makeChunk(content: string, finish: string | null = null, usage?: any): ChatCompletionChunk {
  return {
    id: 'chatcmpl-integ',
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
  registerStats(app, db);
  await app.ready();
  mockRouteRequest.mockReset();
  mockRouteWithRetry.mockReset();
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe('full server integration', () => {
  it('should start and respond to /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.models.total).toBe(9);
  });

  it('should return seeded model list from /v1/models', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(9);

    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain('local/deepseek-r1-1.5b');
    expect(ids).toContain('lan/dgx-spark-70b');
    expect(ids).toContain('anthropic/claude-sonnet');
  });

  it('should handle full chat completion flow with mocked backend', async () => {
    const decision = makeDecision('lan/mbp-m4-32b', 2);
    mockRouteRequest.mockResolvedValue(decision);
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream([
        makeChunk('Here is '),
        makeChunk('your code.', 'stop', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
      ], 'lan/mbp-m4-32b')
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Write a Python hello world' }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('lan/mbp-m4-32b');
    expect(body.choices[0].message.content).toBe('Here is your code.');
    expect(body.choices[0].finish_reason).toBe('stop');
  });

  it('should log routing decision to request_log', async () => {
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream([makeChunk('Hi!', 'stop')], 'local/deepseek-r1-1.5b')
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      },
    });

    const log = db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT 1').get() as any;
    expect(log).toBeTruthy();
    expect(log.selected_model).toBe('local/deepseek-r1-1.5b');
    expect(log.tier_used).toBe(1);
    expect(log.success).toBe(1);
    expect(log.request_preview).toBe('hello');
  });

  it('should update budget_tracking after cloud model request', async () => {
    const decision = makeDecision('anthropic/claude-sonnet', 2);
    mockRouteRequest.mockResolvedValue(decision);
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream([
        makeChunk('response', 'stop', { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }),
      ], 'anthropic/claude-sonnet')
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Analyze this data' }],
        stream: false,
      },
    });

    const today = new Date().toISOString().slice(0, 10);
    const daily = db.prepare(
      "SELECT * FROM budget_tracking WHERE period_type = 'daily' AND period_key = ?"
    ).get(today) as any;

    // Sonnet: cost_input=3.0, cost_output=15.0 per million
    // (1000 * 3.0 + 500 * 15.0) / 1_000_000 = 0.0105
    expect(daily.total_spend).toBeGreaterThan(0);
  });

  it('should return stats after requests', async () => {
    // Make a request first
    mockRouteRequest.mockResolvedValue(makeDecision('local/deepseek-r1-1.5b', 1));
    mockRouteWithRetry.mockResolvedValue(
      makeMockStream([makeChunk('ok', 'stop')], 'local/deepseek-r1-1.5b')
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    });

    // Now check stats
    const res = await app.inject({ method: 'GET', url: '/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.totals.requests).toBe(1);
    expect(body.totals.successful).toBe(1);
    expect(body.routing_distribution).toHaveLength(1);
    expect(body.routing_distribution[0].tier_used).toBe(1);
    expect(body.model_usage).toHaveLength(1);
    expect(body.model_usage[0].selected_model).toBe('local/deepseek-r1-1.5b');
    expect(body.recent_requests).toHaveLength(1);
  });

  it('should return empty stats when no requests have been made', async () => {
    const res = await app.inject({ method: 'GET', url: '/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.requests).toBe(0);
    expect(body.routing_distribution).toHaveLength(0);
    expect(body.model_usage).toHaveLength(0);
    expect(body.recent_requests).toHaveLength(0);
  });
});
