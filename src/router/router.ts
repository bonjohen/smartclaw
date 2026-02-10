import type Database from 'better-sqlite3';
import type {
  ChatRequest,
  RequestMetadata,
  RoutingDecision,
  ClassificationResult,
  ModelRecord,
  RankedCandidate,
} from '../types.js';
import { NoAvailableModelError } from '../types.js';
import { matchTier1Rules } from './tier1-rules.js';
import { classifyRequest, parseClassification, mapClassificationToCriteria, type ClassifyOptions } from './tier2-classify.js';
import { selectCandidates } from './candidate-select.js';
import { getFallbackCandidate } from './tier3-fallback.js';

export interface RouterOptions {
  classifyOptions: ClassifyOptions;
}

/**
 * Extract routing metadata from a ChatRequest.
 */
export function extractMetadata(request: ChatRequest): RequestMetadata {
  // Get the last user message content as the text preview
  const lastUserMessage = [...request.messages]
    .reverse()
    .find(m => m.role === 'user');
  const textPreview = lastUserMessage?.content ?? '';

  // Rough token estimate: ~4 chars per token
  const totalChars = request.messages.reduce(
    (sum, m) => sum + (m.content?.length ?? 0), 0
  );
  const estimatedTokens = Math.max(Math.ceil(totalChars / 4), 100);

  // Check for media: only detect from structured content (array-type content
  // with image_url entries), not regex on string content which false-positives
  const hasMedia = request.messages.some(m => Array.isArray(m.content));

  return {
    text_preview: typeof textPreview === 'string' ? textPreview : '',
    estimated_tokens: estimatedTokens,
    has_media: hasMedia,
    source: request.source ?? null,
    channel: request.channel ?? null,
  };
}

/**
 * Main routing orchestrator.
 * Runs Tier 1 → (optionally) Tier 2 → candidate selection → (optionally) Tier 3 fallback.
 */
export async function routeRequest(
  db: Database.Database,
  request: ChatRequest,
  options: RouterOptions
): Promise<RoutingDecision> {
  const metadata = extractMetadata(request);

  // ── Tier 1: Deterministic rule matching ──
  const tier1 = matchTier1Rules(db, metadata);

  if (tier1.matched) {
    if (tier1.action === 'route_self' || tier1.action === 'route') {
      // Resolved at Tier 1 — route to the target model
      const modelId = tier1.target_model_id;
      if (modelId) {
        const model = db.prepare(
          'SELECT * FROM models WHERE model_id = ?'
        ).get(modelId) as ModelRecord | undefined;

        if (model) {
          return {
            tier_used: 1,
            selected_model: modelId,
            classification: null,
            rule_id: tier1.rule.rule_id,
            candidates: [{ model, score: model.quality_score, rank: 1 }],
          };
        }
      }
      // Target model not found — fall through to classification
    }

    if (tier1.action === 'reject') {
      throw new NoAvailableModelError('Request rejected by routing rule');
    }

    // 'classify' or 'queue' — proceed to Tier 2
  }

  // ── Tier 2: LLM Classification ──
  let classification: ClassificationResult;
  try {
    classification = await classifyRequest(metadata.text_preview, options.classifyOptions);
  } catch {
    // Classification failed — use defaults
    classification = parseClassification('');
  }

  const { quality_floor, required_capability } = mapClassificationToCriteria(db, classification);

  // ── Candidate Selection ──
  const candidates = selectCandidates(db, {
    quality_floor,
    required_capability,
    sensitive: classification.sensitive,
    estimated_tokens: metadata.estimated_tokens,
  });

  if (candidates.length > 0) {
    return {
      tier_used: 2,
      selected_model: candidates[0].model.model_id,
      classification,
      rule_id: tier1.matched ? tier1.rule.rule_id : null,
      candidates,
    };
  }

  // ── Tier 3: Fallback ──
  const fallback = getFallbackCandidate(db);

  if (fallback.length > 0) {
    return {
      tier_used: 3,
      selected_model: fallback[0].model.model_id,
      classification,
      rule_id: null,
      candidates: fallback,
    };
  }

  throw new NoAvailableModelError();
}
