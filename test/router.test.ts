import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { routeRequest, extractMetadata, type RouterOptions } from '../src/router/router.js';
import type { ChatRequest } from '../src/types.js';
import { NoAvailableModelError } from '../src/types.js';

// Mock the classify request to avoid needing a real Ollama instance
vi.mock('../src/router/tier2-classify.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    classifyRequest: vi.fn().mockResolvedValue({
      complexity: 'medium',
      task_type: 'coding',
      estimated_tokens: 1000,
      sensitive: false,
    }),
  };
});

import { classifyRequest } from '../src/router/tier2-classify.js';
const mockClassify = vi.mocked(classifyRequest);

let db: Database.Database;

const routerOptions: RouterOptions = {
  classifyOptions: {
    ollamaEndpoint: 'http://127.0.0.1:11434',
    modelName: 'deepseek-r1:1.5b',
  },
};

beforeEach(() => {
  db = initDb(':memory:');
  mockClassify.mockClear();
});

afterEach(() => {
  db.close();
});

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [
      { role: 'user', content: 'Hello world' },
    ],
    ...overrides,
  };
}

describe('extractMetadata', () => {
  it('should extract text preview from last user message', () => {
    const metadata = extractMetadata(makeRequest({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Write some code' },
      ],
    }));
    expect(metadata.text_preview).toBe('Write some code');
  });

  it('should extract source and channel from request', () => {
    const metadata = extractMetadata(makeRequest({ source: 'heartbeat', channel: 'test' }));
    expect(metadata.source).toBe('heartbeat');
    expect(metadata.channel).toBe('test');
  });

  it('should estimate tokens from message content', () => {
    const metadata = extractMetadata(makeRequest({
      messages: [{ role: 'user', content: 'a'.repeat(400) }],
    }));
    expect(metadata.estimated_tokens).toBe(100); // 400 / 4 = 100
  });
});

describe('router orchestrator', () => {
  it('should resolve heartbeat at Tier 1 to 1.5B without calling Tier 2', async () => {
    const result = await routeRequest(db, makeRequest({ source: 'heartbeat' }), routerOptions);

    expect(result.tier_used).toBe(1);
    expect(result.selected_model).toBe('local/deepseek-r1-1.5b');
    expect(result.classification).toBeNull();
    expect(result.rule_id).toBeDefined();
    // Tier 2 classify should NOT have been called
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('should resolve greeting at Tier 1 to 1.5B', async () => {
    const result = await routeRequest(
      db,
      makeRequest({ messages: [{ role: 'user', content: 'hello' }] }),
      routerOptions,
    );

    expect(result.tier_used).toBe(1);
    expect(result.selected_model).toBe('local/deepseek-r1-1.5b');
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('should classify code request via Tier 2 and select a candidate', async () => {
    mockClassify.mockResolvedValue({
      complexity: 'medium',
      task_type: 'coding',
      estimated_tokens: 1000,
      sensitive: false,
    });

    const result = await routeRequest(
      db,
      makeRequest({
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
      }),
      routerOptions,
    );

    expect(result.tier_used).toBe(2);
    expect(result.classification).toBeTruthy();
    expect(result.classification!.task_type).toBe('coding');
    expect(mockClassify).toHaveBeenCalledOnce();
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('should use default classification when Tier 2 fails', async () => {
    mockClassify.mockRejectedValue(new Error('Ollama not available'));

    const result = await routeRequest(
      db,
      makeRequest({
        messages: [{ role: 'user', content: 'Explain quantum computing' }],
      }),
      routerOptions,
    );

    // Should still route successfully using default classification (medium/conversation)
    expect(result.tier_used).toBe(2);
    expect(result.classification).toBeTruthy();
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('should fall back to Tier 3 when no candidates found', async () => {
    // Set classification to require a capability that no model has
    mockClassify.mockResolvedValue({
      complexity: 'reasoning',
      task_type: 'coding',
      estimated_tokens: 1000,
      sensitive: true, // exclude cloud
    });

    // Mark all local/LAN models as unhealthy so no candidates are found
    db.prepare("UPDATE models SET is_healthy = 0 WHERE location IN ('local', 'lan')").run();
    // But keep the fallback (claude-sonnet) healthy — however it's cloud and sensitive=true
    // So we need a local/LAN fallback. Let's set a local fallback:
    // Actually, the fallback is anthropic/claude-sonnet (cloud), and sensitive=true excludes cloud
    // from candidate selection. But Tier 3 fallback bypasses the selection criteria —
    // it just returns the configured fallback model directly.
    // Let's just mark all models unhealthy except the fallback
    db.prepare("UPDATE models SET is_healthy = 0").run();
    db.prepare("UPDATE models SET is_healthy = 1 WHERE model_id = 'anthropic/claude-sonnet'").run();

    // Since sensitive=true excludes cloud from candidate selection, candidates will be empty
    // Tier 3 should return the fallback (claude-sonnet) regardless of sensitive flag
    const result = await routeRequest(
      db,
      makeRequest({
        messages: [{ role: 'user', content: 'Solve this math proof' }],
      }),
      routerOptions,
    );

    expect(result.tier_used).toBe(3);
    expect(result.selected_model).toBe('anthropic/claude-sonnet');
  });

  it('should throw NoAvailableModelError when all tiers fail', async () => {
    mockClassify.mockResolvedValue({
      complexity: 'reasoning',
      task_type: 'coding',
      estimated_tokens: 1000,
      sensitive: true,
    });

    // Mark all models as unhealthy (including fallback)
    db.prepare("UPDATE models SET is_healthy = 0").run();

    await expect(
      routeRequest(
        db,
        makeRequest({
          messages: [{ role: 'user', content: 'Do something impossible' }],
        }),
        routerOptions,
      )
    ).rejects.toThrow(NoAvailableModelError);
  });

  it('should include correct tier_used and metadata in RoutingDecision', async () => {
    mockClassify.mockResolvedValue({
      complexity: 'complex',
      task_type: 'analysis',
      estimated_tokens: 2000,
      sensitive: false,
    });

    const result = await routeRequest(
      db,
      makeRequest({
        messages: [{ role: 'user', content: 'Analyze this data set in detail' }],
      }),
      routerOptions,
    );

    expect(result.tier_used).toBe(2);
    expect(result.classification).toEqual({
      complexity: 'complex',
      task_type: 'analysis',
      estimated_tokens: 2000,
      sensitive: false,
    });
    expect(result.selected_model).toBeTruthy();
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].rank).toBe(1);
  });
});
