import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { getBackend } from '../src/backends/backend.js';
import { toAnthropicMessages } from '../src/backends/anthropic-backend.js';
import {
  routeWithRetry,
  is429,
  isTimeout,
  markRateLimited,
  markUnhealthy,
} from '../src/backends/route-with-retry.js';
import { NoAvailableModelError } from '../src/types.js';
import type { ChatRequest, ModelRecord, RankedCandidate, ChatCompletionChunk } from '../src/types.js';

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

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
    ...overrides,
  };
}

// ── Backend factory tests ──

describe('getBackend', () => {
  it('should return OpenAIBackend for openai-chat format', () => {
    const model = getModel('local/deepseek-r1-1.5b');
    const backend = getBackend(model);
    expect(backend.constructor.name).toBe('OpenAIBackend');
  });

  it('should return AnthropicBackend for anthropic format', () => {
    const model = getModel('anthropic/claude-sonnet');
    const backend = getBackend(model);
    expect(backend.constructor.name).toBe('AnthropicBackend');
  });

  it('should default to OpenAIBackend for unknown formats', () => {
    const model = { ...getModel('local/deepseek-r1-1.5b'), api_format: 'unknown' };
    const backend = getBackend(model);
    expect(backend.constructor.name).toBe('OpenAIBackend');
  });
});

// ── Anthropic format translation tests ──

describe('toAnthropicMessages', () => {
  it('should extract system messages and convert the rest', () => {
    const result = toAnthropicMessages([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
    ]);

    expect(result.system).toBe('You are helpful');
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
    ]);
  });

  it('should concatenate multiple system messages', () => {
    const result = toAnthropicMessages([
      { role: 'system', content: 'You are helpful' },
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.system).toBe('You are helpful\nBe concise');
  });

  it('should return undefined system when no system messages', () => {
    const result = toAnthropicMessages([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.system).toBeUndefined();
  });

  it('should map tool role to user role', () => {
    const result = toAnthropicMessages([
      { role: 'tool', content: 'tool result', tool_call_id: '123' },
    ]);

    expect(result.messages[0].role).toBe('user');
  });
});

// ── is429 / isTimeout detection ──

describe('is429', () => {
  it('should detect status 429', () => {
    const err = new Error('rate limited');
    (err as any).status = 429;
    expect(is429(err)).toBe(true);
  });

  it('should detect "429" in message', () => {
    expect(is429(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('should detect "rate limit" in message', () => {
    expect(is429(new Error('Rate limit exceeded'))).toBe(true);
  });

  it('should not detect unrelated errors', () => {
    expect(is429(new Error('connection refused'))).toBe(false);
  });
});

describe('isTimeout', () => {
  it('should detect AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTimeout(err)).toBe(true);
  });

  it('should detect ECONNREFUSED', () => {
    const err = new Error('connect failed');
    (err as any).code = 'ECONNREFUSED';
    expect(isTimeout(err)).toBe(true);
  });

  it('should detect ECONNREFUSED in cause', () => {
    const err = new Error('fetch failed');
    (err as any).cause = { code: 'ECONNREFUSED' };
    expect(isTimeout(err)).toBe(true);
  });

  it('should detect timeout in message', () => {
    expect(isTimeout(new Error('Request timeout after 5000ms'))).toBe(true);
  });

  it('should not detect unrelated errors', () => {
    expect(isTimeout(new Error('invalid json'))).toBe(false);
  });
});

// ── markRateLimited / markUnhealthy ──

describe('markRateLimited', () => {
  it('should set provider as rate-limited in DB', () => {
    markRateLimited(db, 'anthropic');

    const row = db.prepare(
      "SELECT is_rate_limited, limited_since FROM provider_rate_limits WHERE provider = 'anthropic'"
    ).get() as any;
    expect(row.is_rate_limited).toBe(1);
    expect(row.limited_since).toBeTruthy();
  });
});

describe('markUnhealthy', () => {
  it('should set model as unhealthy in DB', () => {
    markUnhealthy(db, 'local/deepseek-r1-7b');

    const row = db.prepare(
      "SELECT is_healthy FROM models WHERE model_id = 'local/deepseek-r1-7b'"
    ).get() as any;
    expect(row.is_healthy).toBe(0);
  });
});

// ── routeWithRetry ──

describe('routeWithRetry', () => {
  it('should throw NoAvailableModelError when all candidates fail', async () => {
    // Mock fetch to always fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));

    const model = getModel('local/deepseek-r1-1.5b');
    const candidates: RankedCandidate[] = [
      { model, score: 25, rank: 1 },
    ];

    await expect(
      routeWithRetry(db, makeRequest(), candidates)
    ).rejects.toThrow(NoAvailableModelError);

    globalThis.fetch = originalFetch;
  });

  it('should try next candidate on failure', async () => {
    const callLog: string[] = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callLog.push(url);
      if (url.includes('127.0.0.1')) {
        throw new Error('connection refused');
      }
      // Second call succeeds with a mock response
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream([
          { id: 'test', object: 'chat.completion.chunk' as const, created: 0, model: 'test',
            choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }] },
        ]),
      });
    });

    const model1 = getModel('local/deepseek-r1-1.5b');
    const model2 = getModel('lan/mbp-m4-32b');
    const candidates: RankedCandidate[] = [
      { model: model1, score: 25, rank: 1 },
      { model: model2, score: 68, rank: 2 },
    ];

    const result = await routeWithRetry(db, makeRequest(), candidates);
    expect(result.model_id).toBe('lan/mbp-m4-32b');
    expect(callLog.length).toBe(2);

    globalThis.fetch = originalFetch;
  });

  it('should mark provider rate-limited on 429 error', async () => {
    const originalFetch = globalThis.fetch;
    const err429 = new Error('Too Many Requests');
    (err429 as any).status = 429;

    globalThis.fetch = vi.fn().mockRejectedValue(err429);

    const model = getModel('anthropic/claude-sonnet');
    const candidates: RankedCandidate[] = [
      { model, score: 82, rank: 1 },
    ];

    await expect(routeWithRetry(db, makeRequest(), candidates)).rejects.toThrow();

    const row = db.prepare(
      "SELECT is_rate_limited FROM provider_rate_limits WHERE provider = 'anthropic'"
    ).get() as any;
    expect(row.is_rate_limited).toBe(1);

    globalThis.fetch = originalFetch;
  });

  it('should mark model unhealthy on timeout error', async () => {
    const originalFetch = globalThis.fetch;
    const errTimeout = new Error('request timeout');
    errTimeout.name = 'AbortError';

    globalThis.fetch = vi.fn().mockRejectedValue(errTimeout);

    const model = getModel('local/deepseek-r1-7b');
    const candidates: RankedCandidate[] = [
      { model, score: 45, rank: 1 },
    ];

    await expect(routeWithRetry(db, makeRequest(), candidates)).rejects.toThrow();

    const row = db.prepare(
      "SELECT is_healthy FROM models WHERE model_id = 'local/deepseek-r1-7b'"
    ).get() as any;
    expect(row.is_healthy).toBe(0);

    globalThis.fetch = originalFetch;
  });

  it('should return stream from successful candidate', async () => {
    const originalFetch = globalThis.fetch;

    const chunks: ChatCompletionChunk[] = [
      {
        id: 'test-1', object: 'chat.completion.chunk', created: 123, model: 'test',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      },
      {
        id: 'test-1', object: 'chat.completion.chunk', created: 123, model: 'test',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }],
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream(chunks),
    });

    const model = getModel('local/deepseek-r1-1.5b');
    const candidates: RankedCandidate[] = [
      { model, score: 25, rank: 1 },
    ];

    const result = await routeWithRetry(db, makeRequest(), candidates);
    expect(result.model_id).toBe('local/deepseek-r1-1.5b');

    // Consume the stream
    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }
    expect(received.length).toBe(2);
    expect(received[0].choices[0].delta.content).toBe('Hello');
    expect(received[1].choices[0].delta.content).toBe(' world');

    globalThis.fetch = originalFetch;
  });
});

// ── Anthropic stream translation tests ──

describe('AnthropicBackend stream translation', () => {
  it('should translate message_start event to role chunk', async () => {
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const events = [
      { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createAnthropicSSEStream(events),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest());

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].choices[0].delta.role).toBe('assistant');

    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should translate content_block_delta events to content chunks', async () => {
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const events = [
      { type: 'message_start', message: { id: 'msg_1' } },
      { type: 'content_block_delta', delta: { text: 'Hello' } },
      { type: 'content_block_delta', delta: { text: ' world' } },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createAnthropicSSEStream(events),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest());

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    // Filter content chunks (skip role-only chunks)
    const contentChunks = received.filter(c => c.choices[0].delta.content && c.choices[0].delta.content !== '');
    expect(contentChunks).toHaveLength(2);
    expect(contentChunks[0].choices[0].delta.content).toBe('Hello');
    expect(contentChunks[1].choices[0].delta.content).toBe(' world');

    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should translate message_delta with stop reason', async () => {
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const events = [
      { type: 'message_start', message: { id: 'msg_1' } },
      { type: 'content_block_delta', delta: { text: 'Hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createAnthropicSSEStream(events),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest());

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    // Last chunk should have the stop reason mapped from end_turn→stop
    const lastChunk = received[received.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe('stop');

    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should map max_tokens stop reason to length', async () => {
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const events = [
      { type: 'message_start', message: { id: 'msg_1' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 100 } },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createAnthropicSSEStream(events),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest());

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    const deltaChunk = received.find(c => c.choices[0].finish_reason === 'length');
    expect(deltaChunk).toBeDefined();

    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should extract usage from message_delta', async () => {
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const events = [
      { type: 'message_start', message: { id: 'msg_1' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 50, output_tokens: 25 } },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createAnthropicSSEStream(events),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest());

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    const usageChunk = received.find(c => c.usage !== undefined);
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.usage!.prompt_tokens).toBe(50);
    expect(usageChunk!.usage!.completion_tokens).toBe(25);
    expect(usageChunk!.usage!.total_tokens).toBe(75);

    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should skip unknown event types', async () => {
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const events = [
      { type: 'message_start', message: { id: 'msg_1' } },
      { type: 'ping' },
      { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', delta: { text: 'Hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createAnthropicSSEStream(events),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest());

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    // Should only get message_start, content_block_delta, and message_delta chunks
    // ping, content_block_start, and content_block_stop should be skipped
    expect(received).toHaveLength(3);

    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should set correct model_id on translated chunks', async () => {
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const events = [
      { type: 'message_start', message: { id: 'msg_1' } },
      { type: 'content_block_delta', delta: { text: 'test' } },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createAnthropicSSEStream(events),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest());

    expect(result.model_id).toBe('anthropic/claude-sonnet');

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    for (const chunk of received) {
      expect(chunk.model).toBe('anthropic/claude-sonnet');
    }

    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });
});

// ── Anthropic non-streaming response tests ──

describe('AnthropicBackend non-streaming', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should translate a non-streaming JSON response to OpenAI chunk format', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null, // no body signals non-streaming since isStreaming check requires body
      json: () => Promise.resolve({
        id: 'msg_abc123',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world!' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest({ stream: false }));

    expect(result.model_id).toBe('anthropic/claude-sonnet');
    expect(result.model.model_id).toBe('anthropic/claude-sonnet');

    // Collect chunks from the single-item generator
    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    expect(received).toHaveLength(1);
    const chunk = received[0];
    expect(chunk.choices[0].delta.role).toBe('assistant');
    expect(chunk.choices[0].delta.content).toBe('Hello world!');
    expect(chunk.choices[0].finish_reason).toBe('stop');
    expect(chunk.usage).toBeDefined();
    expect(chunk.usage!.prompt_tokens).toBe(10);
    expect(chunk.usage!.completion_tokens).toBe(5);
    expect(chunk.usage!.total_tokens).toBe(15);
  });

  it('should handle non-streaming response with no usage data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
      json: () => Promise.resolve({
        id: 'msg_abc456',
        content: [{ type: 'text', text: 'Just text' }],
        stop_reason: 'max_tokens',
      }),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');
    const result = await backend.sendRequest(model, makeRequest({ stream: false }));

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    expect(received).toHaveLength(1);
    expect(received[0].choices[0].delta.content).toBe('Just text');
    expect(received[0].choices[0].finish_reason).toBe('length');
    expect(received[0].usage).toBeUndefined();
  });

  it('should throw on missing API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');

    await expect(
      backend.sendRequest(model, makeRequest({ stream: false }))
    ).rejects.toThrow(/Missing API key/);
  });

  it('should throw on non-OK HTTP response with status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"bad request"}'),
    });

    const { AnthropicBackend } = await import('../src/backends/anthropic-backend.js');
    const backend = new AnthropicBackend();
    const model = getModel('anthropic/claude-sonnet');

    try {
      await backend.sendRequest(model, makeRequest({ stream: false }));
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('Anthropic backend error 400');
      expect(err.status).toBe(400);
    }
  });
});

// ── Helpers ──

/**
 * Create a mock ReadableStream that emits Anthropic SSE-formatted events.
 */
function createAnthropicSSEStream(events: any[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < events.length) {
        const data = `data: ${JSON.stringify(events[index])}\n\n`;
        controller.enqueue(encoder.encode(data));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Create a mock ReadableStream that emits SSE-formatted data.
 */
function createMockSSEStream(chunks: ChatCompletionChunk[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const data = `data: ${JSON.stringify(chunks[index])}\n\n`;
        controller.enqueue(encoder.encode(data));
        index++;
      } else {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
}
