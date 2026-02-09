import type { ChatRequest, ModelRecord, StreamResponse } from '../types.js';
import { OpenAIBackend } from './openai-backend.js';
import { AnthropicBackend } from './anthropic-backend.js';

/**
 * Backend interface: all backends must implement sendRequest.
 */
export interface Backend {
  sendRequest(model: ModelRecord, request: ChatRequest): Promise<StreamResponse>;
}

/**
 * Return the appropriate backend adapter for a given model's api_format.
 */
export function getBackend(model: ModelRecord): Backend {
  switch (model.api_format) {
    case 'anthropic':
      return new AnthropicBackend();
    case 'openai-chat':
    default:
      return new OpenAIBackend();
  }
}
