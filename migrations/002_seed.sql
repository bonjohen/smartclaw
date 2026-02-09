-- ── LOCAL MODELS ──

INSERT INTO models (model_id, display_name, provider, location, endpoint_url, api_format,
    quality_score, context_window, max_tokens, supports_tools, supports_vision, reasoning_mode,
    cost_input, cost_output, latency_p50_ms, latency_p99_ms, throughput_tps, hw_requirement)
VALUES
    ('local/deepseek-r1-1.5b', 'DeepSeek R1 Distill Qwen 1.5B', 'deepseek', 'local',
     'http://127.0.0.1:11434/v1', 'openai-chat',
     25, 32768, 4096, 0, 0, 0,
     0, 0, 50, 200, 120, 'CPU 4GB RAM'),

    ('local/deepseek-r1-7b', 'DeepSeek R1 Distill Qwen 7B', 'deepseek', 'local',
     'http://127.0.0.1:11434/v1', 'openai-chat',
     45, 32768, 8192, 0, 0, 1,
     0, 0, 200, 800, 60, 'RTX 8GB+ / Mac 16GB+');

-- ── LAN MODELS ──

INSERT INTO models (model_id, display_name, provider, location, endpoint_url, api_format,
    quality_score, context_window, max_tokens, supports_tools, supports_vision, reasoning_mode,
    cost_input, cost_output, latency_p50_ms, latency_p99_ms, throughput_tps, hw_requirement)
VALUES
    ('lan/mbp-m4-32b', 'DeepSeek R1 Distill Qwen 32B (MBP M4 64GB)', 'deepseek', 'lan',
     'http://mbp.local:11434/v1', 'openai-chat',
     68, 65536, 16384, 1, 0, 1,
     0, 0, 600, 3000, 35, 'MacBook Pro M4 64GB — Q4_K_M ~30GB'),

    ('lan/dgx-spark-70b', 'DeepSeek R1 Distill Llama 70B (DGX Spark 128GB)', 'deepseek', 'lan',
     'http://dgx.local:11434/v1', 'openai-chat',
     78, 65536, 16384, 1, 0, 1,
     0, 0, 1000, 5000, 22, 'NVIDIA DGX Spark 128GB — Q4_K_M ~75GB');

-- ── CLOUD MODELS ──

INSERT INTO models (model_id, display_name, provider, location, endpoint_url, api_format,
    api_key_env, quality_score, context_window, max_tokens,
    supports_tools, supports_vision, reasoning_mode,
    cost_input, cost_output, cost_cache_read, cost_cache_write,
    latency_p50_ms, latency_p99_ms, throughput_tps)
VALUES
    ('anthropic/claude-haiku', 'Claude Haiku', 'anthropic', 'cloud',
     'https://api.anthropic.com/v1', 'anthropic', 'ANTHROPIC_API_KEY',
     55, 200000, 8192, 1, 1, 0,
     0.25, 1.25, 0.03, 0.30, 300, 1500, 250),

    ('anthropic/claude-sonnet', 'Claude Sonnet', 'anthropic', 'cloud',
     'https://api.anthropic.com/v1', 'anthropic', 'ANTHROPIC_API_KEY',
     82, 200000, 16384, 1, 1, 1,
     3.0, 15.0, 0.30, 3.75, 800, 4000, 100),

    ('anthropic/claude-opus', 'Claude Opus', 'anthropic', 'cloud',
     'https://api.anthropic.com/v1', 'anthropic', 'ANTHROPIC_API_KEY',
     95, 200000, 32768, 1, 1, 1,
     15.0, 75.0, 1.50, 18.75, 2000, 10000, 50),

    ('openai/gpt-4o', 'GPT-4o', 'openai', 'cloud',
     'https://api.openai.com/v1', 'openai-chat', 'OPENAI_API_KEY',
     76, 128000, 16384, 1, 1, 0,
     2.50, 10.0, 1.25, 0, 600, 3000, 150),

    ('openai/gpt-5.2', 'GPT-5.2', 'openai', 'cloud',
     'https://api.openai.com/v1', 'openai-chat', 'OPENAI_API_KEY',
     92, 256000, 32768, 1, 1, 1,
     10.0, 30.0, 5.0, 0, 1500, 8000, 60);

-- ── CAPABILITIES ──

-- 1.5B
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-1.5b', 'classification');
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-1.5b', 'simple_qa');
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-1.5b', 'extraction');
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-1.5b', 'conversation');

-- 7B
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-7b', 'coding');
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-7b', 'summarization');
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-7b', 'reasoning');
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-7b', 'simple_qa');
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-7b', 'conversation');
INSERT INTO model_capabilities VALUES ('local/deepseek-r1-7b', 'extraction');

-- 32B (MBP M4)
INSERT INTO model_capabilities VALUES ('lan/mbp-m4-32b', 'coding');
INSERT INTO model_capabilities VALUES ('lan/mbp-m4-32b', 'writing');
INSERT INTO model_capabilities VALUES ('lan/mbp-m4-32b', 'analysis');
INSERT INTO model_capabilities VALUES ('lan/mbp-m4-32b', 'reasoning');
INSERT INTO model_capabilities VALUES ('lan/mbp-m4-32b', 'summarization');
INSERT INTO model_capabilities VALUES ('lan/mbp-m4-32b', 'tool_calling');
INSERT INTO model_capabilities VALUES ('lan/mbp-m4-32b', 'conversation');
INSERT INTO model_capabilities VALUES ('lan/mbp-m4-32b', 'extraction');

-- 70B (DGX Spark)
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'coding');
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'writing');
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'analysis');
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'reasoning');
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'complex_logic');
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'multi_step');
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'tool_calling');
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'summarization');
INSERT INTO model_capabilities VALUES ('lan/dgx-spark-70b', 'conversation');

-- Haiku
INSERT INTO model_capabilities VALUES ('anthropic/claude-haiku', 'coding');
INSERT INTO model_capabilities VALUES ('anthropic/claude-haiku', 'summarization');
INSERT INTO model_capabilities VALUES ('anthropic/claude-haiku', 'classification');
INSERT INTO model_capabilities VALUES ('anthropic/claude-haiku', 'tool_calling');
INSERT INTO model_capabilities VALUES ('anthropic/claude-haiku', 'conversation');
INSERT INTO model_capabilities VALUES ('anthropic/claude-haiku', 'extraction');

-- Sonnet
INSERT INTO model_capabilities VALUES ('anthropic/claude-sonnet', 'coding');
INSERT INTO model_capabilities VALUES ('anthropic/claude-sonnet', 'writing');
INSERT INTO model_capabilities VALUES ('anthropic/claude-sonnet', 'analysis');
INSERT INTO model_capabilities VALUES ('anthropic/claude-sonnet', 'reasoning');
INSERT INTO model_capabilities VALUES ('anthropic/claude-sonnet', 'complex_logic');
INSERT INTO model_capabilities VALUES ('anthropic/claude-sonnet', 'multi_step');
INSERT INTO model_capabilities VALUES ('anthropic/claude-sonnet', 'tool_calling');

-- Opus
INSERT INTO model_capabilities VALUES ('anthropic/claude-opus', 'coding');
INSERT INTO model_capabilities VALUES ('anthropic/claude-opus', 'writing');
INSERT INTO model_capabilities VALUES ('anthropic/claude-opus', 'analysis');
INSERT INTO model_capabilities VALUES ('anthropic/claude-opus', 'reasoning');
INSERT INTO model_capabilities VALUES ('anthropic/claude-opus', 'complex_logic');
INSERT INTO model_capabilities VALUES ('anthropic/claude-opus', 'multi_step');
INSERT INTO model_capabilities VALUES ('anthropic/claude-opus', 'tool_calling');
INSERT INTO model_capabilities VALUES ('anthropic/claude-opus', 'math');

-- GPT-4o
INSERT INTO model_capabilities VALUES ('openai/gpt-4o', 'coding');
INSERT INTO model_capabilities VALUES ('openai/gpt-4o', 'writing');
INSERT INTO model_capabilities VALUES ('openai/gpt-4o', 'analysis');
INSERT INTO model_capabilities VALUES ('openai/gpt-4o', 'reasoning');
INSERT INTO model_capabilities VALUES ('openai/gpt-4o', 'tool_calling');

-- GPT-5.2
INSERT INTO model_capabilities VALUES ('openai/gpt-5.2', 'coding');
INSERT INTO model_capabilities VALUES ('openai/gpt-5.2', 'writing');
INSERT INTO model_capabilities VALUES ('openai/gpt-5.2', 'analysis');
INSERT INTO model_capabilities VALUES ('openai/gpt-5.2', 'reasoning');
INSERT INTO model_capabilities VALUES ('openai/gpt-5.2', 'complex_logic');
INSERT INTO model_capabilities VALUES ('openai/gpt-5.2', 'multi_step');
INSERT INTO model_capabilities VALUES ('openai/gpt-5.2', 'tool_calling');
INSERT INTO model_capabilities VALUES ('openai/gpt-5.2', 'math');

-- ── LOOKUP TABLES ──

INSERT INTO complexity_quality_map VALUES ('simple', 0);
INSERT INTO complexity_quality_map VALUES ('medium', 40);
INSERT INTO complexity_quality_map VALUES ('complex', 65);
INSERT INTO complexity_quality_map VALUES ('reasoning', 80);

INSERT INTO task_capability_map VALUES ('qa', 'simple_qa');
INSERT INTO task_capability_map VALUES ('coding', 'coding');
INSERT INTO task_capability_map VALUES ('writing', 'writing');
INSERT INTO task_capability_map VALUES ('analysis', 'analysis');
INSERT INTO task_capability_map VALUES ('extraction', 'extraction');
INSERT INTO task_capability_map VALUES ('classification', 'classification');
INSERT INTO task_capability_map VALUES ('conversation', 'conversation');
INSERT INTO task_capability_map VALUES ('tool_use', 'tool_calling');
INSERT INTO task_capability_map VALUES ('math', 'math');
INSERT INTO task_capability_map VALUES ('reasoning', 'complex_logic');
INSERT INTO task_capability_map VALUES ('multi_step', 'multi_step');
INSERT INTO task_capability_map VALUES ('summarization', 'summarization');

-- ── ROUTING RULES (Tier 1) ──

INSERT INTO routing_rules (rule_name, priority, match_source, target_model_id, target_action) VALUES
    ('Heartbeat → self',       10, 'heartbeat', 'local/deepseek-r1-1.5b', 'route_self'),
    ('Cron → self',            20, 'cron',      'local/deepseek-r1-1.5b', 'route_self'),
    ('Webhook ping → self',    25, 'webhook',   'local/deepseek-r1-1.5b', 'route_self');

INSERT INTO routing_rules (rule_name, priority, match_pattern, target_model_id, target_action) VALUES
    ('Slash status → self',    30, '^/status\b',        'local/deepseek-r1-1.5b', 'route_self'),
    ('Slash model → self',     31, '^/model\b',         'local/deepseek-r1-1.5b', 'route_self'),
    ('Slash reset → self',     32, '^/(new|reset)\b',   'local/deepseek-r1-1.5b', 'route_self'),
    ('Simple greeting → self', 40,
     '^(hi|hello|hey|good (morning|evening|afternoon)|thanks|thank you|ok|bye|gm|gn)\s*[!.,]?\s*$',
     'local/deepseek-r1-1.5b', 'route_self');

INSERT INTO routing_rules (rule_name, priority, match_has_media, target_action) VALUES
    ('Has media → classify',   50, 1, 'classify');

INSERT INTO routing_rules (rule_name, priority, match_pattern, target_action) VALUES
    ('Code keywords → classify', 60,
     '(function |class |import |def |SELECT |CREATE |ALTER |async |await |const |let |var |pip |npm |docker|git |curl )',
     'classify');

INSERT INTO routing_rules (rule_name, priority, target_action) VALUES
    ('Catch-all → classify',  99, 'classify');

-- ── POLICY ──

INSERT INTO routing_policy VALUES (
    1, 0, 999.0, 30000,
    'local,lan,cloud', 0, 5,
    10.0, 200.0,
    'anthropic/claude-sonnet',
    'local/deepseek-r1-1.5b',
    CURRENT_TIMESTAMP
);

-- ── BUDGET SEED ──

INSERT INTO budget_tracking VALUES ('daily',   date('now'), 0, 0, 0, 0);
INSERT INTO budget_tracking VALUES ('monthly', strftime('%Y-%m', 'now'), 0, 0, 0, 0);

-- ── RATE LIMIT TRACKING ──

INSERT INTO provider_rate_limits (provider) VALUES ('anthropic');
INSERT INTO provider_rate_limits (provider) VALUES ('openai');
INSERT INTO provider_rate_limits (provider) VALUES ('deepseek');
