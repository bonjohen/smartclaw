import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { parseClassification, mapClassificationToCriteria, classifyRequest } from '../src/router/tier2-classify.js';
import type { ClassificationResult } from '../src/types.js';

let db: Database.Database;

beforeEach(() => {
  db = initDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('parseClassification', () => {
  it('should parse valid JSON response correctly', () => {
    const result = parseClassification(
      '{"complexity":"complex","task_type":"coding","estimated_tokens":2000,"sensitive":false}'
    );
    expect(result).toEqual({
      complexity: 'complex',
      task_type: 'coding',
      estimated_tokens: 2000,
      sensitive: false,
    });
  });

  it('should parse all valid complexity levels', () => {
    for (const complexity of ['simple', 'medium', 'complex', 'reasoning'] as const) {
      const result = parseClassification(
        `{"complexity":"${complexity}","task_type":"qa","estimated_tokens":100,"sensitive":false}`
      );
      expect(result.complexity).toBe(complexity);
    }
  });

  it('should parse all valid task types', () => {
    const taskTypes = [
      'qa', 'coding', 'writing', 'analysis', 'extraction',
      'classification', 'conversation', 'tool_use', 'math',
      'reasoning', 'multi_step', 'summarization',
    ];
    for (const task of taskTypes) {
      const result = parseClassification(
        `{"complexity":"medium","task_type":"${task}","estimated_tokens":100,"sensitive":false}`
      );
      expect(result.task_type).toBe(task);
    }
  });

  it('should handle sensitive=true', () => {
    const result = parseClassification(
      '{"complexity":"medium","task_type":"qa","estimated_tokens":100,"sensitive":true}'
    );
    expect(result.sensitive).toBe(true);
  });

  it('should default invalid complexity to medium', () => {
    const result = parseClassification(
      '{"complexity":"ultra","task_type":"coding","estimated_tokens":100,"sensitive":false}'
    );
    expect(result.complexity).toBe('medium');
  });

  it('should default invalid task_type to conversation', () => {
    const result = parseClassification(
      '{"complexity":"medium","task_type":"dancing","estimated_tokens":100,"sensitive":false}'
    );
    expect(result.task_type).toBe('conversation');
  });

  it('should default negative estimated_tokens to 1000', () => {
    const result = parseClassification(
      '{"complexity":"medium","task_type":"coding","estimated_tokens":-5,"sensitive":false}'
    );
    expect(result.estimated_tokens).toBe(1000);
  });

  it('should default non-number estimated_tokens to 1000', () => {
    const result = parseClassification(
      '{"complexity":"medium","task_type":"coding","estimated_tokens":"lots","sensitive":false}'
    );
    expect(result.estimated_tokens).toBe(1000);
  });

  it('should default non-boolean sensitive to false', () => {
    const result = parseClassification(
      '{"complexity":"medium","task_type":"coding","estimated_tokens":100,"sensitive":"yes"}'
    );
    expect(result.sensitive).toBe(false);
  });

  it('should handle JSON wrapped in markdown fences', () => {
    const result = parseClassification(
      '```json\n{"complexity":"complex","task_type":"coding","estimated_tokens":2000,"sensitive":false}\n```'
    );
    expect(result.complexity).toBe('complex');
    expect(result.task_type).toBe('coding');
  });

  it('should return defaults for completely invalid JSON', () => {
    const result = parseClassification('This is not JSON at all');
    expect(result).toEqual({
      complexity: 'medium',
      task_type: 'conversation',
      estimated_tokens: 1000,
      sensitive: false,
    });
  });

  it('should return defaults for empty string', () => {
    const result = parseClassification('');
    expect(result).toEqual({
      complexity: 'medium',
      task_type: 'conversation',
      estimated_tokens: 1000,
      sensitive: false,
    });
  });
});

describe('mapClassificationToCriteria', () => {
  it('should map simple complexity to quality_floor 0', () => {
    const classification: ClassificationResult = {
      complexity: 'simple', task_type: 'qa', estimated_tokens: 100, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.quality_floor).toBe(0);
  });

  it('should map medium complexity to quality_floor 40', () => {
    const classification: ClassificationResult = {
      complexity: 'medium', task_type: 'coding', estimated_tokens: 500, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.quality_floor).toBe(40);
  });

  it('should map complex complexity to quality_floor 65', () => {
    const classification: ClassificationResult = {
      complexity: 'complex', task_type: 'analysis', estimated_tokens: 2000, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.quality_floor).toBe(65);
  });

  it('should map reasoning complexity to quality_floor 80', () => {
    const classification: ClassificationResult = {
      complexity: 'reasoning', task_type: 'math', estimated_tokens: 3000, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.quality_floor).toBe(80);
  });

  it('should map coding task_type to coding capability', () => {
    const classification: ClassificationResult = {
      complexity: 'medium', task_type: 'coding', estimated_tokens: 500, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.required_capability).toBe('coding');
  });

  it('should map reasoning task_type to complex_logic capability', () => {
    const classification: ClassificationResult = {
      complexity: 'complex', task_type: 'reasoning', estimated_tokens: 1000, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.required_capability).toBe('complex_logic');
  });

  it('should map tool_use task_type to tool_calling capability', () => {
    const classification: ClassificationResult = {
      complexity: 'medium', task_type: 'tool_use', estimated_tokens: 500, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.required_capability).toBe('tool_calling');
  });

  it('should return null capability for unknown task_type', () => {
    const classification: ClassificationResult = {
      complexity: 'medium', task_type: 'unknown_task' as any, estimated_tokens: 500, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.required_capability).toBeNull();
  });

  it('should return default quality_floor 40 for unknown complexity', () => {
    const classification: ClassificationResult = {
      complexity: 'unknown' as any, task_type: 'coding', estimated_tokens: 500, sensitive: false,
    };
    const criteria = mapClassificationToCriteria(db, classification);
    expect(criteria.quality_floor).toBe(40);
  });
});

// ── classifyRequest (real fetch pipeline) ──

describe('classifyRequest', () => {
  const options = {
    ollamaEndpoint: 'http://127.0.0.1:11434',
    modelName: 'deepseek-r1:1.5b',
    timeoutMs: 1000,
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should parse valid classification from Ollama response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: {
          content: '{"complexity":"complex","task_type":"coding","estimated_tokens":2000,"sensitive":false}',
        },
      }),
    });

    const result = await classifyRequest('Write a web server in Rust', options);
    expect(result.complexity).toBe('complex');
    expect(result.task_type).toBe('coding');
    expect(result.estimated_tokens).toBe(2000);
    expect(result.sensitive).toBe(false);

    // Verify fetch was called with correct URL and body
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('should return defaults when Ollama returns non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await classifyRequest('Hello', options);
    expect(result).toEqual({
      complexity: 'medium',
      task_type: 'conversation',
      estimated_tokens: 1000,
      sensitive: false,
    });
  });

  it('should return defaults when Ollama returns empty content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '' } }),
    });

    const result = await classifyRequest('Hello', options);
    expect(result).toEqual({
      complexity: 'medium',
      task_type: 'conversation',
      estimated_tokens: 1000,
      sensitive: false,
    });
  });

  it('should return defaults when Ollama returns malformed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { content: 'I am a helpful assistant, here is the classification...' },
      }),
    });

    const result = await classifyRequest('Hello', options);
    expect(result).toEqual({
      complexity: 'medium',
      task_type: 'conversation',
      estimated_tokens: 1000,
      sensitive: false,
    });
  });

  it('should return defaults on network error (fetch throws)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await classifyRequest('Hello', options);
    expect(result).toEqual({
      complexity: 'medium',
      task_type: 'conversation',
      estimated_tokens: 1000,
      sensitive: false,
    });
  });

  it('should truncate long input text to 500 chars in the prompt', async () => {
    let capturedBody: any;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          message: { content: '{"complexity":"medium","task_type":"conversation","estimated_tokens":500,"sensitive":false}' },
        }),
      });
    });

    const longText = 'x'.repeat(1000);
    await classifyRequest(longText, options);

    // The user message content should contain at most 500 chars of the original text
    const userMsg = capturedBody.messages.find((m: any) => m.role === 'user');
    // classifyUserPrompt prepends "Classify this request:\n\n" then slices text to 500
    expect(userMsg.content).toContain('x'.repeat(500));
    expect(userMsg.content).not.toContain('x'.repeat(501));
  });
});
