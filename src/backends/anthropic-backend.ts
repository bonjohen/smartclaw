import type { Backend } from './backend.js';
import type {
  ChatRequest,
  ChatMessage,
  ModelRecord,
  StreamResponse,
  ChatCompletionChunk,
} from '../types.js';

/**
 * Map our internal model IDs to actual Anthropic model identifiers.
 */
const ANTHROPIC_API_VERSION = process.env.ANTHROPIC_API_VERSION ?? '2023-06-01';

const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  'anthropic/claude-haiku': 'claude-haiku-4-5-20251001',
  'anthropic/claude-sonnet': 'claude-sonnet-4-5-20250929',
  'anthropic/claude-opus': 'claude-opus-4-6',
};

/**
 * Anthropic Messages API backend adapter.
 * Translates OpenAI chat format ↔ Anthropic format and streams responses
 * back in OpenAI SSE format for transparent passthrough to the client.
 */
export class AnthropicBackend implements Backend {
  async sendRequest(model: ModelRecord, request: ChatRequest): Promise<StreamResponse> {
    const apiKey = model.api_key_env ? process.env[model.api_key_env] : undefined;
    if (!apiKey) {
      throw new Error(`Missing API key for ${model.model_id} (env: ${model.api_key_env})`);
    }

    const url = `${model.endpoint_url}/messages`;
    const anthropicModel = ANTHROPIC_MODEL_MAP[model.model_id] ?? model.model_id;

    // Translate OpenAI format → Anthropic format
    const { system, messages } = toAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: anthropicModel,
      messages,
      max_tokens: request.max_tokens ?? model.max_tokens,
      stream: request.stream ?? true,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;

    const controller = new AbortController();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const err = new Error(`Anthropic backend error ${response.status}: ${errorBody}`);
      (err as any).status = response.status;
      throw err;
    }

    const isStreaming = request.stream !== false;

    if (isStreaming && response.body) {
      return {
        stream: translateAnthropicStream(response.body, model.model_id),
        model_id: model.model_id,
        model,
        abort: () => controller.abort(),
      };
    }

    // Non-streaming: translate single response
    const json = await response.json() as AnthropicMessageResponse;
    const content = json.content?.map(b => b.text).join('') ?? '';
    const chunk: ChatCompletionChunk = {
      id: json.id ?? `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model.model_id,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content },
        finish_reason: mapStopReason(json.stop_reason),
      }],
      usage: json.usage ? {
        prompt_tokens: json.usage.input_tokens,
        completion_tokens: json.usage.output_tokens,
        total_tokens: json.usage.input_tokens + json.usage.output_tokens,
      } : undefined,
    };

    return {
      stream: (async function* () { yield chunk; })(),
      model_id: model.model_id,
      model,
      abort: () => controller.abort(),
    };
  }
}

// ── Format translation helpers ──

/**
 * Convert OpenAI chat messages to Anthropic Messages API format.
 * System messages are extracted and concatenated; the rest are passed through.
 */
export function toAnthropicMessages(
  messages: ChatMessage[]
): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content) systemParts.push(msg.content);
    } else {
      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content ?? '',
      });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n') : undefined,
    messages: anthropicMessages,
  };
}

/**
 * Parse an Anthropic SSE stream and yield OpenAI-format ChatCompletionChunks.
 */
async function* translateAnthropicStream(
  body: ReadableStream<Uint8Array>,
  modelId: string,
): AsyncIterable<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let msgId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

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

          let event: AnthropicStreamEvent;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const chunk = translateAnthropicEvent(event, msgId, created, modelId);
          if (chunk) yield chunk;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Translate a single Anthropic streaming event to an OpenAI chunk.
 */
function translateAnthropicEvent(
  event: AnthropicStreamEvent,
  msgId: string,
  created: number,
  modelId: string,
): ChatCompletionChunk | null {
  switch (event.type) {
    case 'content_block_delta': {
      const text = event.delta?.text ?? '';
      if (!text) return null;
      return {
        id: msgId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{
          index: 0,
          delta: { content: text },
          finish_reason: null,
        }],
      };
    }

    case 'message_delta': {
      return {
        id: msgId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: mapStopReason(event.delta?.stop_reason),
        }],
        usage: event.usage ? {
          prompt_tokens: event.usage.input_tokens ?? 0,
          completion_tokens: event.usage.output_tokens ?? 0,
          total_tokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
        } : undefined,
      };
    }

    case 'message_start': {
      // First chunk — send role
      return {
        id: msgId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        }],
      };
    }

    default:
      return null;
  }
}

function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'end_turn': return 'stop';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    default: return 'stop';
  }
}

// ── Anthropic API types (minimal) ──

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicMessageResponse {
  id: string;
  content: { type: string; text: string }[];
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: {
    text?: string;
    stop_reason?: string | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}
