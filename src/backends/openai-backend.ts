import type {
  Backend,
} from './backend.js';
import type {
  ChatRequest,
  ModelRecord,
  StreamResponse,
  ChatCompletionChunk,
} from '../types.js';

/**
 * OpenAI-compatible backend.
 * Handles local Ollama, LAN Ollama, and OpenAI cloud — all expose the same
 * POST /chat/completions endpoint and SSE streaming format.
 */
export class OpenAIBackend implements Backend {
  async sendRequest(model: ModelRecord, request: ChatRequest): Promise<StreamResponse> {
    const apiKey = model.api_key_env ? process.env[model.api_key_env] : undefined;
    const url = `${model.endpoint_url}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
      model: model.model_id.includes('/') ? model.model_id.split('/').pop() : model.model_id,
      messages: request.messages,
      stream: request.stream ?? true,
      max_tokens: request.max_tokens ?? model.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop: request.stop,
    });

    const controller = new AbortController();

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const err = new Error(`OpenAI backend error ${response.status}: ${errorBody}`);
      (err as any).status = response.status;
      throw err;
    }

    const isStreaming = request.stream !== false;

    if (isStreaming && response.body) {
      return {
        stream: parseSSEStream(response.body),
        model_id: model.model_id,
        abort: () => controller.abort(),
      };
    }

    // Non-streaming: wrap single response as async iterable
    const json = await response.json() as any;
    const chunk: ChatCompletionChunk = {
      id: json.id ?? `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: json.created ?? Math.floor(Date.now() / 1000),
      model: json.model ?? model.model_id,
      choices: json.choices?.map((c: any, i: number) => ({
        index: i,
        delta: c.message ?? { content: '' },
        finish_reason: c.finish_reason ?? 'stop',
      })) ?? [],
      usage: json.usage,
    };

    return {
      stream: (async function* () { yield chunk; })(),
      model_id: model.model_id,
      abort: () => controller.abort(),
    };
  }
}

/**
 * Parse an SSE byte stream into ChatCompletionChunk objects.
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data) as ChatCompletionChunk;
            yield parsed;
          } catch {
            // Skip unparseable chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
