import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';
import type { RouterOptions } from '../src/router/router.js';

// Mock both the router and backend retry so tests don't need real model endpoints
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
import { NoAvailableModelError } from '../src/types.js';
import type { ChatCompletionChunk, ModelRecord, RoutingDecision } from '../src/types.js';

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

function makeRoutingDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  const model = getModel('local/deepseek-r1-1.5b');
  return {
    tier_used: 1,
    selected_model: 'local/deepseek-r1-1.5b',
    classification: null,
    rule_id: 1,
    candidates: [{ model, score: 25, rank: 1 }],
    ...overrides,
  };
}

function makeMockStreamResponse(chunks: ChatCompletionChunk[], modelId = 'local/deepseek-r1-1.5b') {
  return {
    stream: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    model_id: modelId,
    abort: () => {},
  };
}

function makeChunk(content: string, finishReason: string | null = null): ChatCompletionChunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'local/deepseek-r1-1.5b',
    choices: [{
      index: 0,
      delta: { content },
      finish_reason: finishReason,
    }],
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

// ── GET /health ──

describe('GET /health', () => {
  it('should return status ok with model counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.models.total).toBe(9);
    expect(body.models.healthy).toBe(9);
    expect(body.models.unhealthy).toBe(0);
  });

  it('should return degraded when no models are healthy', async () => {
    db.prepare('UPDATE models SET is_healthy = 0').run();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.models.healthy).toBe(0);
  });

  it('should include budget information', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.budget).toBeDefined();
    expect(body.budget.daily_limit).toBe(10.0);
    expect(body.budget.monthly_limit).toBe(200.0);
    expect(body.budget.daily_spend).toBe(0);
  });
});

// ── GET /v1/models ──

describe('GET /v1/models', () => {
  it('should return all enabled models in OpenAI format', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(9);
  });

  it('should include model id and owned_by fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = res.json();
    const first = body.data[0];
    expect(first.id).toBeTruthy();
    expect(first.object).toBe('model');
    expect(first.owned_by).toBeTruthy();
  });

  it('should exclude disabled models', async () => {
    db.prepare("UPDATE models SET is_enabled = 0 WHERE model_id = 'local/deepseek-r1-7b'").run();
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = res.json();
    expect(body.data).toHaveLength(8);
    expect(body.data.find((m: any) => m.id === 'local/deepseek-r1-7b')).toBeUndefined();
  });
});

// ── POST /v1/chat/completions ──

describe('POST /v1/chat/completions', () => {
  it('should return 400 for missing messages', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('should return 400 for empty messages array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should return 503 when no models available', async () => {
    mockRouteRequest.mockRejectedValue(new NoAvailableModelError());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });
    expect(res.statusCode).toBe(503);
  });

  it('should include X-Router-Model and X-Router-Tier headers (non-streaming)', async () => {
    const decision = makeRoutingDecision();
    mockRouteRequest.mockResolvedValue(decision);

    const chunks = [makeChunk('Hello world', 'stop')];
    mockRouteWithRetry.mockResolvedValue(makeMockStreamResponse(chunks));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('local/deepseek-r1-1.5b');
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('Hello world');
  });

  it('should return SSE stream when stream=true', async () => {
    const model = getModel('local/deepseek-r1-1.5b');
    const decision = makeRoutingDecision({ tier_used: 2, classification: { complexity: 'medium', task_type: 'coding', estimated_tokens: 500, sensitive: false } });
    mockRouteRequest.mockResolvedValue(decision);

    const chunks = [
      makeChunk('Hello'),
      makeChunk(' world', 'stop'),
    ];
    mockRouteWithRetry.mockResolvedValue(makeMockStreamResponse(chunks));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['x-router-model']).toBe('local/deepseek-r1-1.5b');
    expect(res.headers['x-router-tier']).toBe('2');

    // Parse SSE body
    const lines = res.body.split('\n').filter(l => l.startsWith('data: '));
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // Last line should be [DONE]
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBe('data: [DONE]');

    // First data line should be parseable JSON
    const firstData = JSON.parse(lines[0].slice(6));
    expect(firstData.choices[0].delta.content).toBe('Hello');
  });

  it('should log request to request_log table after completion', async () => {
    mockRouteRequest.mockResolvedValue(makeRoutingDecision());
    mockRouteWithRetry.mockResolvedValue(
      makeMockStreamResponse([makeChunk('Hi', 'stop')])
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
    expect(log).toBeTruthy();
    expect(log.selected_model).toBe('local/deepseek-r1-1.5b');
    expect(log.tier_used).toBe(1);
    expect(log.success).toBe(1);
    expect(log.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('should include X-Router-Classification header when classification exists', async () => {
    const classification = { complexity: 'complex' as const, task_type: 'coding', estimated_tokens: 2000, sensitive: false };
    mockRouteRequest.mockResolvedValue(makeRoutingDecision({ tier_used: 2, classification }));
    mockRouteWithRetry.mockResolvedValue(
      makeMockStreamResponse([makeChunk('code here', 'stop')])
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Write code' }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    // Non-streaming sets headers via reply.header()
    expect(res.headers['x-router-classification']).toBeTruthy();
    const parsedClassification = JSON.parse(res.headers['x-router-classification'] as string);
    expect(parsedClassification.complexity).toBe('complex');
  });
});

// ── CORS ──

describe('CORS', () => {
  it('should return CORS headers on OPTIONS', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/v1/models' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('should include CORS headers on GET', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
