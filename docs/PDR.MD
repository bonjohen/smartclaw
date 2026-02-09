# OpenClaw Smart Router — Project Specification

> 2**Purpose**: Implementation-ready spec for a local-first LLM routing proxy that sits between OpenClaw and model backends. Hand this file to Claude Code as the project bootstrap.

---

## 1. System Overview

### What This Is

A Node.js/TypeScript proxy server that exposes an OpenAI-compatible `/v1/chat/completions` endpoint. OpenClaw points at it as its primary model. Internally, the proxy:

1. Evaluates deterministic SQL rules (Tier 1, 0ms)
2. Optionally classifies via a local 1.5B LLM (Tier 2, ~50ms CPU)
3. Selects the best available model from a SQLite registry
4. Forwards the request to the selected backend and streams the response back

### What This Is Not

- Not a fork of OpenClaw. It's a standalone proxy.
- Not an LLM inference server. It delegates to Ollama, vLLM, LM Studio, or cloud APIs.
- Not a conversation manager. OpenClaw handles sessions, memory, and tools.

### Physical Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         LOCAL NETWORK                                   │
│                                                                         │
│  ┌──────────────────┐   ┌──────────────────┐   ┌────────────────────┐  │
│  │ Workstation       │   │ MacBook Pro M4   │   │ DGX Spark          │  │
│  │                   │   │ 64GB Unified     │   │ 128GB              │  │
│  │ • Router proxy    │   │                  │   │                    │  │
│  │ • SQLite DB       │   │ • Ollama/vLLM    │   │ • Ollama/vLLM      │  │
│  │ • 1.5B router LLM │   │ • 32B Q4 (~30GB) │   │ • 70B Q4 (~75GB)   │  │
│  │ • 7B local (opt)  │   │                  │   │                    │  │
│  │                   │   │ endpoint:        │   │ endpoint:          │  │
│  │ localhost:8080    │   │ mbp.local:11434  │   │ dgx.local:11434    │  │
│  └──────────────────┘   └──────────────────┘   └────────────────────┘  │
│           │                                                             │
│           │  OpenClaw Gateway (localhost:18789)                          │
│           │  points model.primary → localhost:8080/v1                    │
└───────────┼─────────────────────────────────────────────────────────────┘
            │
            ▼  (only when needed)
     ┌──────────────┐
     │ Cloud APIs   │
     │ • Anthropic  │
     │ • OpenAI     │
     └──────────────┘
```

---

## 2. Model Registry (Seed Data)

All models the system knows about. Quality scores are relative (0-100). Cost is $/million tokens. Latency is observed p50 in ms.

### Tier: Local (same machine as router)

| model_id | Model | Quality | Cost In/Out | Latency | Context | Notes |
|---|---|---|---|---|---|---|
| `local/deepseek-r1-1.5b` | DeepSeek-R1-Distill-Qwen-1.5B | 25 | 0/0 | 50ms | 32K | **Router + simple QA**. CPU-only, ~2GB RAM. Every machine has this. |
| `local/deepseek-r1-7b` | DeepSeek-R1-Distill-Qwen-7B | 45 | 0/0 | 200ms | 32K | Optional. Needs RTX 8GB+ or Mac 16GB+. |

### Tier: LAN (dedicated GPU machines on local network)

| model_id | Model | Quality | Cost In/Out | Latency | Context | Notes |
|---|---|---|---|---|---|---|
| `lan/mbp-m4-32b` | DeepSeek-R1-Distill-Qwen-32B | 68 | 0/0 | 600ms | 64K | MacBook Pro M4 64GB. Q4_K_M quant, ~30GB VRAM. Strong coding/analysis. |
| `lan/dgx-spark-70b` | DeepSeek-R1-Distill-Llama-70B | 78 | 0/0 | 1000ms | 64K | DGX Spark 128GB. Q4_K_M quant, ~75GB. Near-frontier reasoning at zero cost. |

### Tier: Cloud (external API, metered)

| model_id | Model | Quality | Cost In/Out | Latency | Context | Notes |
|---|---|---|---|---|---|---|
| `anthropic/claude-haiku` | Claude Haiku | 55 | 0.25/1.25 | 300ms | 200K | Fast cloud. Good for classification overflow, tool calling. |
| `anthropic/claude-sonnet` | Claude Sonnet | 82 | 3.0/15.0 | 800ms | 200K | Cloud workhorse. Coding, analysis, multi-step. |
| `anthropic/claude-opus` | Claude Opus | 95 | 15.0/75.0 | 2000ms | 200K | Frontier. Complex architecture, novel reasoning. |
| `openai/gpt-4o` | GPT-4o | 76 | 2.50/10.0 | 600ms | 128K | OpenAI general purpose. |
| `openai/gpt-5.2` | GPT-5.2 | 92 | 10.0/30.0 | 1500ms | 256K | OpenAI frontier. |

### Escalation Ladder (Default Path)

```
Quality  0 ──────── 25 ──── 45 ──── 68 ────── 78 ────── 82 ── 92/95 ── 100
         │          │       │       │         │         │      │
         │       1.5B     7B     32B(MBP)  70B(DGX)  Sonnet  Opus/5.2
         │      router   local    LAN        LAN      cloud   cloud
         │       CPU     GPU    zero-cost  zero-cost  $$$     $$$$$
         │
     simple    simple  medium   complex    complex+  frontier frontier
      QA      coding   coding   reasoning  reasoning  best    best
```

The 32B on the MacBook Pro and 70B on the DGX Spark fill the critical gap between local small models and expensive cloud APIs. Most "complex" work lands on these two machines at zero marginal cost.

---

## 3. Decision Architecture

### Three-Tier Routing

```
Request ─→ Tier 1: SQL Rule Match ─→ resolved? ─→ yes ─→ route/self-answer
                                       │
                                       no
                                       ▼
              Tier 2: 1.5B Classify ─→ select candidate ─→ route
                                       │
                                    no candidates
                                       ▼
              Tier 3: Fallback Model ─→ route (or error)
```

### Tier 1 Rules (Built-In)

| Priority | Match | Action | Target |
|---|---|---|---|
| 10 | source = heartbeat | route_self | 1.5B |
| 20 | source = cron | route_self | 1.5B |
| 25 | source = webhook | route_self | 1.5B |
| 30 | text matches `^/status` | route_self | 1.5B |
| 31 | text matches `^/model` | route_self | 1.5B |
| 32 | text matches `^/(new\|reset)` | route_self | 1.5B |
| 40 | text matches simple greeting | route_self | 1.5B |
| 50 | has_media = true | classify | — |
| 60 | text matches code keywords | classify | — |
| 99 | (catch-all) | classify | — |

### Tier 2 Classification (1.5B Output)

The 1.5B returns:
```json
{"complexity": "medium", "task_type": "coding", "estimated_tokens": 1500, "sensitive": false}
```

This maps to query parameters:
- `complexity` → `quality_floor` via lookup table (simple=0, medium=40, complex=65, reasoning=80)
- `task_type` → `required_capability` via lookup table
- `sensitive` → exclude cloud if true
- `estimated_tokens` → filter by context_window

### Candidate Selection Priority

Models are scored and sorted:
1. **Meets quality floor** (hard filter)
2. **Has required capability** (hard filter)
3. **Is healthy and not rate-limited** (hard filter)
4. **Within budget** (hard filter — exclude cloud if budget exceeded)
5. **Prefer local > LAN > cloud** (sort)
6. **Prefer cheapest** (sort)
7. **Prefer highest quality** (tiebreak)

For a `complex` coding request (quality_floor=65), the selection order would be:
1. `lan/mbp-m4-32b` (quality 68, cost 0, LAN) ✅ **selected**
2. `lan/dgx-spark-70b` (quality 78, cost 0, LAN)
3. `openai/gpt-4o` (quality 76, cost 10.0, cloud)
4. `anthropic/claude-sonnet` (quality 82, cost 15.0, cloud)
5. etc.

For a `reasoning` request (quality_floor=80):
1. `lan/dgx-spark-70b` (quality 78) ❌ below floor... but closest LAN option
2. `anthropic/claude-sonnet` (quality 82, cloud) ✅ **selected** (if budget allows)
3. `openai/gpt-5.2` (quality 92, cloud)
4. `anthropic/claude-opus` (quality 95, cloud)

**Design decision**: The 70B at quality 78 is 2 points below the reasoning floor of 80. Two options:
- **(A) Strict**: Skip it, go to cloud. Guarantees quality.
- **(B) Soft**: Allow ±5 tolerance when a zero-cost LAN model is close. Saves money.

Implement **(B)** as a configurable `quality_tolerance` field in `routing_policy` (default 5). When a LAN/local model is within tolerance and costs $0, prefer it over a cloud model that strictly meets the floor.

---

## 4. SQLite Schema

### File: `migrations/001_initial.sql`

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- models
-- ============================================================
CREATE TABLE models (
    model_id        TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    provider        TEXT NOT NULL,
    location        TEXT NOT NULL CHECK (location IN ('local','lan','cloud')),
    endpoint_url    TEXT NOT NULL,
    api_format      TEXT NOT NULL DEFAULT 'openai-chat',
    api_key_env     TEXT,

    quality_score   INTEGER NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
    context_window  INTEGER NOT NULL,
    max_tokens      INTEGER NOT NULL DEFAULT 4096,
    supports_tools  BOOLEAN NOT NULL DEFAULT 0,
    supports_vision BOOLEAN NOT NULL DEFAULT 0,
    reasoning_mode  BOOLEAN NOT NULL DEFAULT 0,

    cost_input      REAL NOT NULL DEFAULT 0,
    cost_output     REAL NOT NULL DEFAULT 0,
    cost_cache_read REAL NOT NULL DEFAULT 0,
    cost_cache_write REAL NOT NULL DEFAULT 0,

    latency_p50_ms  INTEGER NOT NULL DEFAULT 100,
    latency_p99_ms  INTEGER NOT NULL DEFAULT 5000,
    throughput_tps  INTEGER,

    hw_requirement  TEXT,
    is_enabled      BOOLEAN NOT NULL DEFAULT 1,
    is_healthy      BOOLEAN NOT NULL DEFAULT 1,
    last_health_check DATETIME,
    last_used       DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- model_capabilities
-- ============================================================
CREATE TABLE model_capabilities (
    model_id    TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
    capability  TEXT NOT NULL,
    PRIMARY KEY (model_id, capability)
);
CREATE INDEX idx_cap_lookup ON model_capabilities(capability, model_id);

-- ============================================================
-- routing_rules
-- ============================================================
CREATE TABLE routing_rules (
    rule_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_name       TEXT NOT NULL,
    priority        INTEGER NOT NULL DEFAULT 100,
    is_enabled      BOOLEAN NOT NULL DEFAULT 1,

    match_source    TEXT,
    match_channel   TEXT,
    match_pattern   TEXT,
    match_token_max INTEGER,
    match_has_media BOOLEAN,

    target_model_id TEXT REFERENCES models(model_id),
    target_action   TEXT NOT NULL DEFAULT 'route'
        CHECK (target_action IN ('route','route_self','classify','reject','queue')),

    override_max_tokens INTEGER,
    override_temperature REAL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_rules_priority ON routing_rules(is_enabled, priority);

-- ============================================================
-- routing_policy (singleton)
-- ============================================================
CREATE TABLE routing_policy (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    min_quality_score       INTEGER NOT NULL DEFAULT 0,
    max_cost_per_mtok       REAL NOT NULL DEFAULT 999.0,
    max_latency_ms          INTEGER NOT NULL DEFAULT 30000,
    prefer_location_order   TEXT NOT NULL DEFAULT 'local,lan,cloud',
    prefer_privacy          BOOLEAN NOT NULL DEFAULT 0,
    quality_tolerance       INTEGER NOT NULL DEFAULT 5,
    budget_daily_usd        REAL NOT NULL DEFAULT 10.0,
    budget_monthly_usd      REAL NOT NULL DEFAULT 200.0,
    fallback_model_id       TEXT REFERENCES models(model_id),
    router_model_id         TEXT REFERENCES models(model_id),
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- complexity_quality_map
-- ============================================================
CREATE TABLE complexity_quality_map (
    complexity    TEXT PRIMARY KEY,
    quality_floor INTEGER NOT NULL
);

-- ============================================================
-- task_capability_map
-- ============================================================
CREATE TABLE task_capability_map (
    task_type  TEXT PRIMARY KEY,
    capability TEXT NOT NULL
);

-- ============================================================
-- budget_tracking
-- ============================================================
CREATE TABLE budget_tracking (
    period_type TEXT NOT NULL,
    period_key  TEXT NOT NULL,
    total_spend REAL NOT NULL DEFAULT 0,
    total_input_tokens  INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    request_count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (period_type, period_key)
);

-- ============================================================
-- model_health_log
-- ============================================================
CREATE TABLE model_health_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id    TEXT NOT NULL REFERENCES models(model_id),
    checked_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_healthy  BOOLEAN NOT NULL,
    latency_ms  INTEGER,
    error_msg   TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_health_model ON model_health_log(model_id, checked_at DESC);

-- ============================================================
-- request_log
-- ============================================================
CREATE TABLE request_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    request_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source          TEXT,
    channel         TEXT,
    request_preview TEXT,
    tier_used       INTEGER NOT NULL,
    rule_id         INTEGER REFERENCES routing_rules(rule_id),
    classification  TEXT,
    selected_model  TEXT NOT NULL,
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_usd        REAL,
    latency_ms      INTEGER,
    success         BOOLEAN,
    error_msg       TEXT
);
CREATE INDEX idx_reqlog_time ON request_log(request_at DESC);
CREATE INDEX idx_reqlog_model ON request_log(selected_model, request_at DESC);

-- ============================================================
-- provider_rate_limits
-- ============================================================
CREATE TABLE provider_rate_limits (
    provider        TEXT PRIMARY KEY,
    is_rate_limited BOOLEAN NOT NULL DEFAULT 0,
    limited_since   DATETIME,
    retry_after     DATETIME,
    rpm_limit       INTEGER,
    rpm_used        INTEGER NOT NULL DEFAULT 0,
    tpm_limit       INTEGER,
    tpm_used        INTEGER NOT NULL DEFAULT 0,
    window_reset_at DATETIME
);
```

### File: `migrations/002_seed.sql`

```sql
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
```

---

## 5. Project Structure

```
openclaw-router/
├── CLAUDE.md                    # Instructions for Claude Code (this section)
├── package.json
├── tsconfig.json
├── .env.example
├── migrations/
│   ├── 001_initial.sql          # Schema
│   └── 002_seed.sql             # Seed data
├── src/
│   ├── index.ts                 # Entry: start proxy server + health checker
│   ├── config.ts                # Load .env, validate, export typed config
│   ├── db.ts                    # better-sqlite3 init, migration runner, singleton
│   ├── server.ts                # Express/Fastify HTTP server
│   │
│   ├── routes/
│   │   ├── chat-completions.ts  # POST /v1/chat/completions (main endpoint)
│   │   ├── models.ts            # GET  /v1/models (list available models)
│   │   └── health.ts            # GET  /health (proxy health)
│   │
│   ├── router/
│   │   ├── tier1-rules.ts       # SQL rule matcher
│   │   ├── tier2-classify.ts    # 1.5B LLM classification
│   │   ├── tier3-fallback.ts    # Fallback logic
│   │   ├── candidate-select.ts  # SQL candidate query + scoring
│   │   └── router.ts            # Orchestrates tier1 → tier2 → tier3
│   │
│   ├── backends/
│   │   ├── backend.ts           # Interface: sendRequest(model, messages) → stream
│   │   ├── openai-backend.ts    # OpenAI-compatible (local, LAN, OpenAI cloud)
│   │   └── anthropic-backend.ts # Anthropic Messages API
│   │
│   ├── health/
│   │   ├── health-checker.ts    # Background loop: ping endpoints, update DB
│   │   └── budget-tracker.ts    # Post-request cost accumulation
│   │
│   └── types.ts                 # Shared TypeScript types
│
└── test/
    ├── tier1-rules.test.ts
    ├── tier2-classify.test.ts
    ├── candidate-select.test.ts
    ├── router.test.ts
    └── fixtures/
        └── test.db              # In-memory test DB fixture
```

---

## 6. API Contract

### POST `/v1/chat/completions`

Accepts standard OpenAI chat completions request. This is the only endpoint OpenClaw calls.

**Request** (from OpenClaw):
```json
{
  "model": "auto",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "Write a Python script to parse CSV files"}
  ],
  "stream": true,
  "max_tokens": 4096,
  "temperature": 0.7
}
```

**Behavior**:
1. Extract routing metadata from the request (text preview, token estimate, media presence)
2. Run through tier1 → tier2 → tier3
3. Forward to selected backend
4. Stream response back in OpenAI SSE format
5. On completion, log to `request_log`, update `budget_tracking`

**Response headers** (added by proxy):
```
X-Router-Model: lan/dgx-spark-70b
X-Router-Tier: 2
X-Router-Classification: {"complexity":"complex","task_type":"coding"}
```

**Error handling**:
- If selected model fails, try next candidate from the ranked list
- If all candidates fail, try `routing_policy.fallback_model_id`
- If fallback fails, return 503 with error detail

### GET `/v1/models`

Returns the combined model list from the DB (so OpenClaw's `/model` command works).

### GET `/health`

Returns proxy status, DB connectivity, and summary of healthy/unhealthy models.

### GET `/stats` (bonus, for dashboard)

Returns routing distribution, cost breakdown, model usage stats from `request_log`.

---

## 7. Key Implementation Details

### 7.1 Classification Prompt

```typescript
const CLASSIFY_SYSTEM = `You are a request classifier. Analyze the user request and return JSON only.
Classify complexity as one of: simple, medium, complex, reasoning.
Classify task_type as one of: qa, coding, writing, analysis, extraction, classification, conversation, tool_use, math, reasoning, multi_step, summarization.
Estimate total tokens needed for a complete response.
Set sensitive=true if the request contains personal, financial, medical, or proprietary information.

Definitions:
- simple: greetings, status, lookups, yes/no, one-line answers
- medium: short code snippets, single-paragraph writing, reformatting, summarization
- complex: multi-file code, architecture, long analysis, document generation
- reasoning: math proofs, logic puzzles, novel problem-solving, multi-step planning

Respond with ONLY a JSON object. No explanation, no markdown fences.`;

const CLASSIFY_USER = (text: string) =>
  `Classify this request:\n\n${text.slice(0, 500)}`;

// Expected: {"complexity":"medium","task_type":"coding","estimated_tokens":1500,"sensitive":false}
```

### 7.2 Quality Tolerance (Soft Floor)

```typescript
function applyQualityTolerance(
  candidates: Model[],
  qualityFloor: number,
  tolerance: number
): Model[] {
  const strict = candidates.filter(m => m.quality_score >= qualityFloor);
  if (strict.length > 0) return strict;

  // No strict matches — check if a zero-cost model is within tolerance
  const soft = candidates.filter(
    m => m.quality_score >= (qualityFloor - tolerance)
      && m.cost_output === 0
  );
  if (soft.length > 0) return soft;

  // Nothing within tolerance — return all above floor (will be empty, triggers fallback)
  return strict;
}
```

This is the mechanism that lets the DGX 70B (quality 78) handle `reasoning` tasks (floor 80) without burning cloud tokens.

### 7.3 Streaming Passthrough

The proxy must support SSE streaming passthrough. Do not buffer the full response. Pipe chunks from the backend through to OpenClaw as they arrive. Accumulate token counts from the final `[DONE]` chunk or `usage` field for logging.

### 7.4 Backend Retry on Failure

```typescript
async function routeWithRetry(
  request: ChatRequest,
  candidates: RankedModel[]
): Promise<StreamResponse> {
  for (const candidate of candidates) {
    try {
      return await backends.send(candidate, request);
    } catch (err) {
      logFailure(candidate, err);
      if (is429(err)) markRateLimited(candidate.provider);
      if (isTimeout(err)) markUnhealthy(candidate.model_id);
      continue; // try next candidate
    }
  }
  throw new NoAvailableModelError();
}
```

### 7.5 Health Check Loop

```typescript
// Every 60 seconds, ping all enabled models
async function healthCheckLoop(db: Database) {
  const models = db.prepare(
    'SELECT model_id, endpoint_url FROM models WHERE is_enabled = 1'
  ).all();

  for (const model of models) {
    const start = Date.now();
    try {
      await fetch(`${model.endpoint_url}/models`, {
        signal: AbortSignal.timeout(5000)
      });
      markHealthy(db, model.model_id, Date.now() - start);
    } catch {
      markUnhealthy(db, model.model_id);
    }
  }
}
```

### 7.6 Anthropic Backend Adapter

Anthropic uses a different API format. The backend must translate:

```typescript
// OpenAI format (from OpenClaw) → Anthropic Messages API
function toAnthropicRequest(openaiReq: ChatRequest): AnthropicRequest {
  const system = openaiReq.messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n');

  const messages = openaiReq.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  return {
    model: mapModelId(openaiReq),  // 'anthropic/claude-sonnet' → 'claude-sonnet-4-5-20250929'
    system,
    messages,
    max_tokens: openaiReq.max_tokens ?? 4096,
    stream: openaiReq.stream ?? true,
  };
}

// Anthropic SSE → OpenAI SSE (for streaming passthrough)
function translateAnthropicChunk(chunk: AnthropicStreamEvent): OpenAIChunk { ... }
```

---

## 8. Configuration

### `.env`

```bash
# Proxy
ROUTER_PORT=8080
ROUTER_DB_PATH=~/.openclaw/router/router.db

# API keys (referenced by models.api_key_env)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# LAN endpoints (override DB defaults if needed)
LAN_MBP_ENDPOINT=http://mbp.local:11434/v1
LAN_DGX_ENDPOINT=http://dgx.local:11434/v1

# Local router model (Ollama)
ROUTER_OLLAMA_ENDPOINT=http://127.0.0.1:11434
ROUTER_MODEL_NAME=deepseek-r1:1.5b

# Health check interval
HEALTH_CHECK_INTERVAL_MS=60000
```

### OpenClaw Integration (`~/.openclaw/openclaw.json`)

```jsonc
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "router/auto",
        "fallbacks": ["anthropic/claude-sonnet-4-5"]
      }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "router": {
        "baseUrl": "http://127.0.0.1:8080/v1",
        "apiKey": "local",
        "api": "openai-responses",
        "models": [{
          "id": "auto",
          "name": "Smart Router",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 32768
        }]
      }
    }
  }
}
```

---

## 9. Dependencies

```json
{
  "name": "openclaw-router",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "migrate": "tsx src/db.ts --migrate",
    "test": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "fastify": "^5.0.0",
    "undici": "^7.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

Intentionally minimal. No ORMs, no heavy frameworks. `better-sqlite3` is synchronous and fast for the query patterns here. `undici` for HTTP streaming. `fastify` for the proxy server.

---

## 10. CLAUDE.md (For Claude Code)

Place this at the project root so Claude Code understands the project:

```markdown
# OpenClaw Smart Router

## What This Is
A TypeScript proxy server that routes OpenClaw LLM requests to the optimal backend
(local, LAN, or cloud) using a SQLite-backed model registry and three-tier decision engine.

## Architecture
- Tier 1: Deterministic SQL rule matching (0ms, no LLM)
- Tier 2: DeepSeek-R1-1.5B classification via Ollama (50ms, CPU)
- Tier 3: Fallback to configured default model

## Key Files
- `migrations/001_initial.sql` — Complete schema
- `migrations/002_seed.sql` — Model registry, rules, policy seed data
- `src/router/router.ts` — Main routing orchestrator
- `src/routes/chat-completions.ts` — Primary API endpoint
- `src/backends/` — Backend adapters (OpenAI-compatible + Anthropic)

## Conventions
- SQLite via better-sqlite3 (synchronous, no async wrappers)
- Fastify for HTTP
- Streaming SSE passthrough (never buffer full responses)
- All model metadata lives in SQLite, not config files
- No ORMs — raw SQL with prepared statements
- Tests via vitest with in-memory SQLite

## Build & Run
npm install
npm run migrate   # creates DB + runs migrations
npm run dev       # tsx watch mode

## Critical Behaviors
1. Tier 1 rules resolve ~40-60% of requests with zero LLM calls
2. Quality tolerance (default ±5) lets zero-cost LAN models handle tasks
   slightly above their quality score, avoiding unnecessary cloud spend
3. On backend failure, automatically try next candidate — never fail without
   exhausting the full candidate list + fallback
4. Accumulate cost to budget_tracking after every request; gate cloud
   access when budget is exceeded
5. Health check loop runs every 60s; 3 consecutive failures → mark unhealthy
6. Anthropic backend must translate OpenAI format ↔ Anthropic Messages API
7. Response headers include X-Router-Model, X-Router-Tier for debugging
```

---

## 11. Implementation Order

Build in this sequence. Each step is independently testable.

| Phase | Module | Description | Test With |
|---|---|---|---|
| 1 | `db.ts`, migrations | SQLite init, migration runner, seed data | `vitest` — query models, rules |
| 2 | `tier1-rules.ts` | SQL rule matching engine | Unit test with mock requests |
| 3 | `candidate-select.ts` | Candidate query + quality tolerance scoring | Unit test with various policy/budget states |
| 4 | `tier2-classify.ts` | 1.5B classification via Ollama HTTP | Integration test with running Ollama |
| 5 | `router.ts` | Orchestrate tier1 → tier2 → tier3 | Unit test with mocked backends |
| 6 | `openai-backend.ts` | OpenAI-compatible streaming passthrough | Integration test vs local Ollama |
| 7 | `anthropic-backend.ts` | Anthropic format translation + streaming | Integration test vs Anthropic API |
| 8 | `chat-completions.ts` | Fastify route handler, SSE piping | `curl` against running server |
| 9 | `health-checker.ts` | Background health loop | Manual: stop Ollama, check DB state |
| 10 | `budget-tracker.ts` | Post-request cost accumulation + budget gating | Unit test: exceed budget, verify cloud exclusion |
| 11 | `server.ts`, `index.ts` | Full server assembly, startup | End-to-end: OpenClaw → proxy → backend |

---

## 12. Future Extensions (Not In Scope Now)

- **Admin UI**: Web dashboard reading from `request_log` and `budget_tracking`.
- **Model auto-discovery**: mDNS/Bonjour scan for Ollama endpoints on LAN.
- **Adaptive quality scores**: Update `quality_score` based on observed success/failure rates.
- **Request queuing**: `target_action = 'queue'` for batch/async workloads.
- **Multi-tenant**: Per-user or per-agent routing policies.
- **Prompt caching awareness**: Route to same model for cache hits (Anthropic cache_read pricing).