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
