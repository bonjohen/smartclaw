import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { OpenAIBackend } from '../src/backends/openai-backend.js';
import type { ChatRequest, ModelRecord, ChatCompletionChunk } from '../src/types.js';

let db: Database.Database;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  db = initDb(':memory:');
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

// ── sendRequest URL and headers ──

describe('OpenAIBackend.sendRequest', () => {
  it('should construct correct fetch URL from model endpoint', async () => {
    let capturedUrl = '';

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream([
          { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
            choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] },
        ]),
      });
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');
    await backend.sendRequest(model, makeRequest());

    expect(capturedUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('should include Authorization header when api_key_env is set', async () => {
    let capturedHeaders: Record<string, string> = {};
    process.env.OPENAI_API_KEY = 'test-key-123';

    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream([
          { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
            choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] },
        ]),
      });
    });

    const backend = new OpenAIBackend();
    const model = getModel('openai/gpt-4o');
    await backend.sendRequest(model, makeRequest());

    expect(capturedHeaders['Authorization']).toBe('Bearer test-key-123');

    delete process.env.OPENAI_API_KEY;
  });

  it('should not include Authorization header when no api_key_env', async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream([
          { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
            choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] },
        ]),
      });
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b'); // no api_key_env
    await backend.sendRequest(model, makeRequest());

    expect(capturedHeaders['Authorization']).toBeUndefined();
  });

  it('should send correct JSON body with model, messages, and stream flag', async () => {
    let capturedBody: any;

    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream([
          { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
            choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] },
        ]),
      });
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');
    const request = makeRequest({ temperature: 0.7, max_tokens: 1024 });
    await backend.sendRequest(model, request);

    expect(capturedBody.model).toBe('deepseek-r1-1.5b'); // stripped provider prefix
    expect(capturedBody.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.temperature).toBe(0.7);
    expect(capturedBody.max_tokens).toBe(1024);
  });

  it('should strip provider prefix from model_id for cloud models', async () => {
    let capturedBody: any;
    process.env.OPENAI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream([
          { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
            choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] },
        ]),
      });
    });

    const backend = new OpenAIBackend();
    const model = getModel('openai/gpt-4o');
    await backend.sendRequest(model, makeRequest());

    expect(capturedBody.model).toBe('gpt-4o');

    delete process.env.OPENAI_API_KEY;
  });

  it('should throw with status on non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');

    await expect(backend.sendRequest(model, makeRequest()))
      .rejects.toThrow('OpenAI backend error 500');
  });

  it('should attach status code to error on non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');

    try {
      await backend.sendRequest(model, makeRequest());
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(429);
    }
  });
});

// ── SSE stream parsing ──

describe('OpenAIBackend SSE stream parsing', () => {
  it('should parse multi-chunk SSE stream into ChatCompletionChunks', async () => {
    const chunks: ChatCompletionChunk[] = [
      { id: 'c1', object: 'chat.completion.chunk', created: 100, model: 'test',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', created: 100, model: 'test',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', created: 100, model: 'test',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }] },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream(chunks),
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');
    const result = await backend.sendRequest(model, makeRequest());

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    expect(received).toHaveLength(3);
    expect(received[0].choices[0].delta.role).toBe('assistant');
    expect(received[1].choices[0].delta.content).toBe('Hello');
    expect(received[2].choices[0].delta.content).toBe(' world');
    expect(received[2].choices[0].finish_reason).toBe('stop');
  });

  it('should handle SSE stream with [DONE] terminator', async () => {
    const chunks: ChatCompletionChunk[] = [
      { id: 'c1', object: 'chat.completion.chunk', created: 100, model: 'test',
        choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream(chunks),
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');
    const result = await backend.sendRequest(model, makeRequest());

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    // Should get just the data chunk, not the [DONE] marker
    expect(received).toHaveLength(1);
    expect(received[0].choices[0].delta.content).toBe('Done');
  });

  it('should handle non-streaming response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
      json: () => Promise.resolve({
        id: 'chatcmpl-123',
        created: 1000,
        model: 'deepseek-r1-1.5b',
        choices: [{ message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');
    const result = await backend.sendRequest(model, makeRequest({ stream: false }));

    const received: ChatCompletionChunk[] = [];
    for await (const chunk of result.stream) {
      received.push(chunk);
    }

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('chatcmpl-123');
    expect(received[0].choices[0].delta.content).toBe('Hi there');
    expect(received[0].usage?.prompt_tokens).toBe(10);
    expect(received[0].usage?.completion_tokens).toBe(5);
  });

  it('should return model_id matching the model record', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream([
        { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
          choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] },
      ]),
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');
    const result = await backend.sendRequest(model, makeRequest());

    expect(result.model_id).toBe('local/deepseek-r1-1.5b');
  });

  it('should provide an abort function', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream([
        { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
          choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] },
      ]),
    });

    const backend = new OpenAIBackend();
    const model = getModel('local/deepseek-r1-1.5b');
    const result = await backend.sendRequest(model, makeRequest());

    expect(typeof result.abort).toBe('function');
  });
});

// ── API key resolution ──

describe('OpenAIBackend API key resolution', () => {
  it('should read API key from the env var specified in api_key_env', async () => {
    let capturedHeaders: Record<string, string> = {};
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';

    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream([
          { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
            choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] },
        ]),
      });
    });

    // Temporarily change a local model to use ANTHROPIC_API_KEY for testing
    const model = { ...getModel('local/deepseek-r1-1.5b'), api_key_env: 'ANTHROPIC_API_KEY' };
    const backend = new OpenAIBackend();
    await backend.sendRequest(model as ModelRecord, makeRequest());

    expect(capturedHeaders['Authorization']).toBe('Bearer anthropic-test-key');

    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should not set Authorization when api_key_env resolves to undefined', async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream([
          { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test',
            choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] },
        ]),
      });
    });

    // Model with api_key_env pointing to unset env var
    const model = { ...getModel('local/deepseek-r1-1.5b'), api_key_env: 'NONEXISTENT_KEY' };
    const backend = new OpenAIBackend();
    await backend.sendRequest(model as ModelRecord, makeRequest());

    expect(capturedHeaders['Authorization']).toBeUndefined();
  });
});
