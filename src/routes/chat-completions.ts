import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import type { ChatRequest, ChatCompletionChunk, ModelRecord } from '../types.js';
import { NoAvailableModelError } from '../types.js';
import { routeRequest, type RouterOptions } from '../router/router.js';
import { routeWithRetry } from '../backends/route-with-retry.js';

interface ChatCompletionsBody {
  model?: string;
  messages: { role: string; content: string | null }[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
}

const chatCompletionsSchema = {
  body: {
    type: 'object',
    required: ['messages'],
    properties: {
      model: { type: 'string' },
      messages: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: { type: 'string', enum: ['system', 'user', 'assistant'] },
            content: { type: ['string', 'null'] },
          },
        },
      },
      stream: { type: 'boolean' },
      max_tokens: { type: 'integer', minimum: 1 },
      temperature: { type: 'number', minimum: 0, maximum: 2 },
      top_p: { type: 'number', minimum: 0, maximum: 1 },
      stop: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
    },
  },
};

export function registerChatCompletions(
  app: FastifyInstance,
  db: Database.Database,
  routerOptions: RouterOptions
): void {
  app.post('/v1/chat/completions', { schema: chatCompletionsSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ChatCompletionsBody;

    if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.status(400).send({
        error: { message: 'messages array is required and must not be empty', type: 'invalid_request_error' },
      });
    }

    const chatRequest: ChatRequest = {
      model: body.model ?? 'auto',
      messages: body.messages.map(m => ({
        role: m.role as any,
        content: m.content,
      })),
      stream: body.stream,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop: body.stop,
      source: request.headers['x-router-source'] as string | undefined,
      channel: request.headers['x-router-channel'] as string | undefined,
    };

    const startTime = Date.now();

    // Route the request
    let decision;
    try {
      decision = await routeRequest(db, chatRequest, routerOptions);
    } catch (err) {
      if (err instanceof NoAvailableModelError) {
        return reply.status(503).send({
          error: { message: err.message, type: 'server_error' },
        });
      }
      throw err;
    }

    // Set routing headers
    reply.header('X-Router-Model', decision.selected_model);
    reply.header('X-Router-Tier', String(decision.tier_used));
    if (decision.classification) {
      reply.header('X-Router-Classification', JSON.stringify(decision.classification));
    }

    // Send request to backend with retry
    let streamResponse;
    try {
      streamResponse = await routeWithRetry(db, chatRequest, decision.candidates);
    } catch (err) {
      if (err instanceof NoAvailableModelError) {
        return reply.status(503).send({
          error: { message: 'All backend models failed', type: 'server_error' },
        });
      }
      throw err;
    }

    const isStreaming = chatRequest.stream !== false;
    const actualModel = streamResponse.model;

    // Abort backend stream if client disconnects
    request.raw.on('close', () => {
      streamResponse.abort();
    });

    if (isStreaming) {
      // SSE streaming response
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Router-Model': decision.selected_model,
        'X-Router-Tier': String(decision.tier_used),
        ...(decision.classification
          ? { 'X-Router-Classification': JSON.stringify(decision.classification) }
          : {}),
      });

      let inputTokens = 0;
      let outputTokens = 0;
      let success = true;

      try {
        for await (const chunk of streamResponse.stream) {
          // Accumulate usage if present
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || inputTokens;
            outputTokens = chunk.usage.completion_tokens || outputTokens;
          }

          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        reply.raw.write('data: [DONE]\n\n');
      } catch (err: any) {
        success = false;
        // Stream error — write error event and close
        reply.raw.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      } finally {
        reply.raw.end();
        logRequest(db, decision, actualModel, startTime, inputTokens, outputTokens, success, chatRequest);
      }
    } else {
      // Non-streaming: collect all chunks into a single response
      let success = true;
      try {
        const chunks: ChatCompletionChunk[] = [];
        for await (const chunk of streamResponse.stream) {
          chunks.push(chunk);
        }

        if (chunks.length === 0) {
          logRequest(db, decision, actualModel, startTime, 0, 0, false, chatRequest);
          return reply.status(502).send({
            error: { message: 'Backend returned no response data', type: 'server_error' },
          });
        }

        const lastChunk = chunks[chunks.length - 1];
        const content = chunks
          .map(c => c.choices?.[0]?.delta?.content ?? '')
          .join('');

        const inputTokens = lastChunk?.usage?.prompt_tokens ?? 0;
        const outputTokens = lastChunk?.usage?.completion_tokens ?? 0;

        logRequest(db, decision, actualModel, startTime, inputTokens, outputTokens, true, chatRequest);

        return reply.send({
          id: lastChunk?.id ?? `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: lastChunk?.created ?? Math.floor(Date.now() / 1000),
          model: decision.selected_model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: lastChunk?.choices?.[0]?.finish_reason ?? 'stop',
          }],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        });
      } catch (err: any) {
        logRequest(db, decision, actualModel, startTime, 0, 0, false, chatRequest);
        throw err;
      }
    }
  });
}

function logRequest(
  db: Database.Database,
  decision: any,
  actualModel: ModelRecord,
  startTime: number,
  inputTokens: number,
  outputTokens: number,
  success: boolean,
  request: ChatRequest
): void {
  try {
    const costInput = actualModel?.cost_input ?? 0;
    const costOutput = actualModel?.cost_output ?? 0;
    const costUsd = (inputTokens * costInput + outputTokens * costOutput) / 1_000_000;

    db.prepare(`
      INSERT INTO request_log (source, channel, request_preview, tier_used, rule_id,
        classification, selected_model, input_tokens, output_tokens, cost_usd,
        latency_ms, success)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.source ?? null,
      request.channel ?? null,
      request.messages[request.messages.length - 1]?.content?.slice(0, 200) ?? null,
      decision.tier_used,
      decision.rule_id,
      decision.classification ? JSON.stringify(decision.classification) : null,
      decision.selected_model,
      inputTokens,
      outputTokens,
      costUsd,
      Date.now() - startTime,
      success ? 1 : 0,
    );

    // Update budget tracking
    if (costUsd > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const month = today.slice(0, 7);

      db.prepare(`
        INSERT INTO budget_tracking (period_type, period_key, total_spend, total_input_tokens, total_output_tokens, request_count)
        VALUES ('daily', ?, ?, ?, ?, 1)
        ON CONFLICT(period_type, period_key) DO UPDATE SET
          total_spend = total_spend + excluded.total_spend,
          total_input_tokens = total_input_tokens + excluded.total_input_tokens,
          total_output_tokens = total_output_tokens + excluded.total_output_tokens,
          request_count = request_count + 1
      `).run(today, costUsd, inputTokens, outputTokens);

      db.prepare(`
        INSERT INTO budget_tracking (period_type, period_key, total_spend, total_input_tokens, total_output_tokens, request_count)
        VALUES ('monthly', ?, ?, ?, ?, 1)
        ON CONFLICT(period_type, period_key) DO UPDATE SET
          total_spend = total_spend + excluded.total_spend,
          total_input_tokens = total_input_tokens + excluded.total_input_tokens,
          total_output_tokens = total_output_tokens + excluded.total_output_tokens,
          request_count = request_count + 1
      `).run(month, costUsd, inputTokens, outputTokens);
    }
  } catch (err) {
    // logRequest failure should not crash the request; use stderr for operational logging
    process.stderr.write(`[logRequest] Failed to log request: ${err}\n`);
  }
}
