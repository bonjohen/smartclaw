// ── OpenAI-compatible request/response types ──

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  // Routing metadata injected by OpenClaw or extracted by proxy
  source?: string;
  channel?: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }[];
  usage?: TokenUsage;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
  usage: TokenUsage;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ── Tier 2 classification ──

export interface ClassificationResult {
  complexity: 'simple' | 'medium' | 'complex' | 'reasoning';
  task_type: string;
  estimated_tokens: number;
  sensitive: boolean;
}

// ── Routing decision ──

export type TargetAction = 'route' | 'route_self' | 'classify' | 'reject' | 'queue';

export interface RoutingDecision {
  tier_used: 1 | 2 | 3;
  selected_model: string;
  classification: ClassificationResult | null;
  rule_id: number | null;
  candidates: RankedCandidate[];
}

// ── Database row types ──

export interface ModelRecord {
  model_id: string;
  display_name: string;
  provider: string;
  location: 'local' | 'lan' | 'cloud';
  endpoint_url: string;
  api_format: string;
  api_key_env: string | null;

  quality_score: number;
  context_window: number;
  max_tokens: number;
  supports_tools: number;
  supports_vision: number;
  reasoning_mode: number;

  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_write: number;

  latency_p50_ms: number;
  latency_p99_ms: number;
  throughput_tps: number | null;

  hw_requirement: string | null;
  is_enabled: number;
  is_healthy: number;
  last_health_check: string | null;
  last_used: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutingRule {
  rule_id: number;
  rule_name: string;
  priority: number;
  is_enabled: number;

  match_source: string | null;
  match_channel: string | null;
  match_pattern: string | null;
  match_token_max: number | null;
  match_has_media: number | null;

  target_model_id: string | null;
  target_action: TargetAction;

  override_max_tokens: number | null;
  override_temperature: number | null;
  created_at: string;
}

export interface RoutingPolicy {
  id: number;
  min_quality_score: number;
  max_cost_per_mtok: number;
  max_latency_ms: number;
  prefer_location_order: string;
  prefer_privacy: number;
  quality_tolerance: number;
  budget_daily_usd: number;
  budget_monthly_usd: number;
  fallback_model_id: string | null;
  router_model_id: string | null;
  updated_at: string;
}

export interface RankedCandidate {
  model: ModelRecord;
  score: number;
  rank: number;
}

// ── Health & budget ──

export interface HealthStatus {
  model_id: string;
  is_healthy: boolean;
  latency_ms: number | null;
  consecutive_failures: number;
  last_checked: string | null;
}

export interface BudgetStatus {
  daily_spend: number;
  daily_limit: number;
  monthly_spend: number;
  monthly_limit: number;
  is_exceeded: boolean;
}

export interface BudgetTrackingRow {
  period_type: string;
  period_key: string;
  total_spend: number;
  total_input_tokens: number;
  total_output_tokens: number;
  request_count: number;
}

export interface ProviderRateLimitRow {
  provider: string;
  is_rate_limited: number;
  limited_since: string | null;
  retry_after: string | null;
  rpm_limit: number | null;
  rpm_used: number;
  tpm_limit: number | null;
  tpm_used: number;
  window_reset_at: string | null;
}

// ── Request metadata extracted for routing ──

export interface RequestMetadata {
  text_preview: string;
  estimated_tokens: number;
  has_media: boolean;
  source: string | null;
  channel: string | null;
}

// ── Stream response from backends ──

export interface StreamResponse {
  stream: AsyncIterable<ChatCompletionChunk>;
  model_id: string;
  model: ModelRecord;
  abort: () => void;
}

// ── Errors ──

export class NoAvailableModelError extends Error {
  constructor(message = 'No available model to handle this request') {
    super(message);
    this.name = 'NoAvailableModelError';
  }
}

export class ClassificationError extends Error {
  constructor(message = 'Failed to classify request') {
    super(message);
    this.name = 'ClassificationError';
  }
}
