# OpenClaw Smart Router — Phased Execution Plan

> Generated from [PDR.MD](./PDR.MD). Each phase is a check-in point: all tests pass and code is committed before moving on. Steps are marked as they progress.

**Status Key:**
- `[ ]` — Not started
- `[~]` — In progress
- `[x]` — Completed

---

## Phase 1: Project Foundation & Database Layer

> **Goal**: Bootable project with SQLite database, migrations, seed data, typed config, and shared types. Everything is testable in isolation.

- [x] **1.1** Initialize project scaffolding
  - Create `package.json` with dependencies from PDR Section 9 (better-sqlite3, fastify, undici, vitest, tsx, typescript)
  - Create `tsconfig.json` (strict mode, ES modules, NodeNext module resolution)
  - Create `.env.example` with all config vars from PDR Section 8
  - Create `.gitignore` (node_modules, dist, *.db, .env)
  - Run `npm install`

- [x] **1.2** Define shared TypeScript types (`src/types.ts`)
  - `ChatRequest` / `ChatMessage` — OpenAI-compatible request shape
  - `ClassificationResult` — Tier 2 output (`complexity`, `task_type`, `estimated_tokens`, `sensitive`)
  - `RoutingDecision` — result of the router (`tier_used`, `selected_model`, `classification`, `rule_id`)
  - `ModelRecord` — row from `models` table
  - `RoutingRule` — row from `routing_rules` table
  - `RoutingPolicy` — row from `routing_policy` table
  - `RankedCandidate` — model + computed score for candidate selection
  - `HealthStatus` / `BudgetStatus` — health and budget query results

- [x] **1.3** Implement configuration loader (`src/config.ts`)
  - Load `.env` via `dotenv` (add to dependencies)
  - Export typed `Config` object: `port`, `dbPath`, `ollamaEndpoint`, `routerModelName`, `healthCheckIntervalMs`, API key env var names
  - Validate required config on startup; throw clear error on missing values

- [x] **1.4** Create SQL migration files
  - `migrations/001_initial.sql` — full schema from PDR Section 4
  - `migrations/002_seed.sql` — all seed data from PDR Section 4 (models, capabilities, rules, policy, budget, rate limits)

- [x] **1.5** Implement database module (`src/db.ts`)
  - Initialize `better-sqlite3` with WAL mode and foreign keys
  - Migration runner: read `migrations/*.sql` in order, track applied migrations (use a `_migrations` meta table or filename tracking)
  - Export singleton `getDb()` function
  - Support in-memory DB for tests (`":memory:"`)

- [x] **1.6** Write Phase 1 tests (`test/db.test.ts`)
  - Test: migrations run without error on in-memory DB
  - Test: all 9 models are seeded and queryable
  - Test: capabilities are correctly linked to models
  - Test: routing rules exist with correct priorities
  - Test: routing policy singleton exists with expected defaults
  - Test: budget tracking rows exist for daily and monthly
  - Test: complexity_quality_map and task_capability_map are populated

**Phase 1 Checkpoint:** `npm test` passes. Commit and tag.

---

## Phase 2: Routing Engine

> **Goal**: The three-tier routing decision engine works end-to-end with mocked/stubbed backends. No HTTP server yet — pure logic.

- [x] **2.1** Implement Tier 1 rule matcher (`src/router/tier1-rules.ts`)
  - Query `routing_rules` ordered by priority where `is_enabled = 1`
  - Match against request metadata: `source`, `channel`, `match_pattern` (regex), `match_has_media`, `match_token_max`
  - Return first matching rule's `target_action` and `target_model_id`, or `null` if no match
  - Handle `route_self`, `classify`, `route`, `reject`, `queue` actions

- [x] **2.2** Write Tier 1 tests (`test/tier1-rules.test.ts`)
  - Test: heartbeat source → `route_self` to 1.5B (priority 10)
  - Test: cron source → `route_self` to 1.5B (priority 20)
  - Test: `/status` command → `route_self` (priority 30)
  - Test: `/model` command → `route_self` (priority 31)
  - Test: `/new` and `/reset` commands → `route_self` (priority 32)
  - Test: simple greeting "hello" → `route_self` (priority 40)
  - Test: message with media → `classify` (priority 50)
  - Test: code keywords ("function ", "import ") → `classify` (priority 60)
  - Test: generic message → `classify` via catch-all (priority 99)
  - Test: disabled rules are skipped
  - Test: priority ordering is respected (lower number = higher priority)

- [x] **2.3** Implement candidate selection (`src/router/candidate-select.ts`)
  - Query eligible models from DB given: `quality_floor`, `required_capability`, `sensitive` flag, `estimated_tokens`
  - Apply hard filters: meets quality floor, has capability, is healthy, is enabled, not rate-limited, within budget (exclude cloud if budget exceeded)
  - Apply quality tolerance from `routing_policy.quality_tolerance` (PDR Section 7.2)
  - Sort by: prefer local > LAN > cloud, then cheapest, then highest quality (tiebreak)
  - Return `RankedCandidate[]`

- [x] **2.4** Write candidate selection tests (`test/candidate-select.test.ts`)
  - Test: simple request (floor=0) → selects cheapest local model
  - Test: medium coding (floor=40) → selects 7B local if healthy, else LAN 32B
  - Test: complex coding (floor=65) → selects LAN 32B (quality 68)
  - Test: reasoning (floor=80) → quality tolerance allows DGX 70B (quality 78, within ±5)
  - Test: reasoning with tolerance=0 → skips 70B, selects cloud Sonnet
  - Test: sensitive=true → excludes all cloud models
  - Test: unhealthy model is excluded from candidates
  - Test: rate-limited provider's models are excluded
  - Test: budget exceeded → excludes cloud models
  - Test: estimated_tokens exceeding context_window → model excluded
  - Test: required capability filtering works (e.g., "math" only returns Opus/GPT-5.2)

- [x] **2.5** Implement Tier 2 classification (`src/router/tier2-classify.ts`)
  - Send classification prompt to 1.5B model via Ollama HTTP API (PDR Section 7.1)
  - Parse JSON response into `ClassificationResult`
  - Map `complexity` → `quality_floor` via `complexity_quality_map` table
  - Map `task_type` → `required_capability` via `task_capability_map` table
  - Handle parse failures gracefully (default to `medium` complexity)
  - Respect timeout (e.g., 5s max for classification)

- [x] **2.6** Write Tier 2 tests (`test/tier2-classify.test.ts`)
  - Test: valid JSON response is parsed correctly
  - Test: complexity maps to correct quality_floor (simple=0, medium=40, complex=65, reasoning=80)
  - Test: task_type maps to correct capability
  - Test: malformed JSON defaults to medium/conversation
  - Test: timeout returns default classification
  - Test: sensitive=true is propagated correctly

- [x] **2.7** Implement Tier 3 fallback (`src/router/tier3-fallback.ts`)
  - Read `routing_policy.fallback_model_id` from DB
  - Return fallback model as sole candidate if available and healthy
  - Return empty list (triggering 503) if fallback is also unavailable

- [x] **2.8** Implement router orchestrator (`src/router/router.ts`)
  - Orchestrate: Tier 1 → (if classify) Tier 2 → candidate selection → (if empty) Tier 3
  - For `route_self` actions, return the target model directly
  - For `classify` actions, run Tier 2 then candidate selection
  - For `route` actions with explicit `target_model_id`, return that model
  - Produce `RoutingDecision` with tier used, selected model, classification, rule_id
  - Handle all error paths (no candidates, classification failure, etc.)

- [x] **2.9** Write router orchestrator tests (`test/router.test.ts`)
  - Test: heartbeat → Tier 1 resolves to 1.5B, no Tier 2 called
  - Test: greeting → Tier 1 resolves to 1.5B
  - Test: code request → Tier 1 yields `classify` → Tier 2 runs → candidate selected
  - Test: Tier 2 failure → falls back gracefully (uses default classification)
  - Test: no candidates after Tier 2 → Tier 3 fallback used
  - Test: all tiers fail → error thrown
  - Test: `RoutingDecision` includes correct tier_used and metadata

**Phase 2 Checkpoint:** `npm test` passes (all Phase 1 + Phase 2 tests). Commit and tag.

---

## Phase 3: Backend Adapters

> **Goal**: Backend adapters can send requests to OpenAI-compatible and Anthropic endpoints, with SSE streaming passthrough. Tested against mocked HTTP responses.

- [x] **3.1** Define backend interface (`src/backends/backend.ts`)
  - `Backend` interface: `sendRequest(model: ModelRecord, request: ChatRequest): Promise<StreamResponse>`
  - `StreamResponse` type: readable stream of OpenAI-format SSE chunks + metadata (model used, usage stats)
  - Backend factory: given a `ModelRecord`, return the appropriate backend instance

- [x] **3.2** Implement OpenAI-compatible backend (`src/backends/openai-backend.ts`)
  - Send request to model's `endpoint_url` using `undici` for streaming
  - Pass through SSE chunks as-is (local Ollama, LAN Ollama, and OpenAI cloud all use this format)
  - Extract token usage from final chunk or `usage` field
  - Handle connection errors, timeouts, HTTP error status codes
  - Support `api_key_env` lookup for cloud models (read API key from env)

- [x] **3.3** Implement Anthropic backend adapter (`src/backends/anthropic-backend.ts`)
  - Translate OpenAI chat format → Anthropic Messages API format (PDR Section 7.6)
  - Map model IDs: `anthropic/claude-sonnet` → actual Anthropic model ID (e.g., `claude-sonnet-4-5-20250929`)
  - Send request to Anthropic API using `undici` with streaming
  - Translate Anthropic SSE events → OpenAI SSE format for passthrough to client
  - Extract token usage from Anthropic `message_delta` events
  - Include `anthropic-version` header, `x-api-key` header

- [x] **3.4** Implement retry-with-candidates logic (`src/backends/route-with-retry.ts`)
  - Iterate through `RankedCandidate[]`, try each in order (PDR Section 7.4)
  - On 429: mark provider as rate-limited in `provider_rate_limits`
  - On timeout: mark model as unhealthy in `models`
  - On other errors: log and continue to next candidate
  - If all candidates exhausted: throw `NoAvailableModelError`

- [x] **3.5** Write backend tests (`test/backends.test.ts`)
  - Test: OpenAI backend sends correct request format
  - Test: OpenAI backend streams SSE chunks correctly (mock HTTP server)
  - Test: Anthropic backend translates request format correctly
  - Test: Anthropic backend translates streaming response to OpenAI format
  - Test: Anthropic model ID mapping works
  - Test: retry logic tries next candidate on failure
  - Test: 429 response marks provider rate-limited
  - Test: timeout marks model unhealthy
  - Test: all candidates exhausted throws NoAvailableModelError
  - Test: API key is read from correct env var

**Phase 3 Checkpoint:** `npm test` passes (all Phase 1–3 tests). Commit and tag.

---

## Phase 4: HTTP Server & API Endpoints

> **Goal**: Fastify server exposes the OpenAI-compatible API. Requests flow from HTTP → router → backend → SSE stream back to client.

- [ ] **4.1** Implement Fastify server setup (`src/server.ts`)
  - Create Fastify instance with logging
  - Register routes from `src/routes/`
  - Attach DB instance and router to request context (Fastify decorators or dependency injection)
  - CORS configuration for local development
  - Error handling middleware (map internal errors to HTTP status codes)

- [ ] **4.2** Implement POST `/v1/chat/completions` (`src/routes/chat-completions.ts`)
  - Parse OpenAI-format request body
  - Extract routing metadata: text preview (first message content), token estimate, media presence, source header
  - Call router to get `RoutingDecision`
  - Call backend with retry using ranked candidates
  - Stream SSE response back to client (pipe through, never buffer — PDR Section 7.3)
  - Set response headers: `X-Router-Model`, `X-Router-Tier`, `X-Router-Classification`
  - On completion: log to `request_log`, update `budget_tracking`
  - Support both `stream: true` (SSE) and `stream: false` (buffered JSON)

- [ ] **4.3** Implement GET `/v1/models` (`src/routes/models.ts`)
  - Query all enabled models from DB
  - Return in OpenAI `/v1/models` response format (`data` array with `id`, `object`, `created`, `owned_by`)

- [ ] **4.4** Implement GET `/health` (`src/routes/health.ts`)
  - Return proxy status, DB connectivity check
  - Include summary: total models, healthy count, unhealthy count
  - Include budget status (daily/monthly spend vs limits)

- [ ] **4.5** Write HTTP endpoint tests (`test/routes.test.ts`)
  - Test: POST /v1/chat/completions returns SSE stream with correct headers
  - Test: POST /v1/chat/completions with `stream: false` returns buffered JSON
  - Test: response includes X-Router-Model and X-Router-Tier headers
  - Test: GET /v1/models returns all enabled models in correct format
  - Test: GET /health returns status with model counts
  - Test: invalid request body returns 400
  - Test: no available models returns 503
  - Test: request is logged to request_log table after completion

**Phase 4 Checkpoint:** `npm test` passes (all Phase 1–4 tests). Commit and tag.

---

## Phase 5: Health Monitoring & Budget Management

> **Goal**: Background health checks keep model status current. Budget tracking gates cloud access when spending limits are reached.

- [ ] **5.1** Implement health checker (`src/health/health-checker.ts`)
  - Background loop pings all enabled models every `HEALTH_CHECK_INTERVAL_MS` (PDR Section 7.5)
  - Ping endpoint: `GET {endpoint_url}/models` with 5s timeout
  - On success: mark healthy, record latency, reset consecutive failures
  - On failure: increment `consecutive_failures` in `model_health_log`
  - 3 consecutive failures → set `is_healthy = 0` on `models` table
  - Recovery: successful ping after unhealthy → set `is_healthy = 1`, reset counter
  - Graceful shutdown: stop loop on SIGTERM/SIGINT

- [ ] **5.2** Implement budget tracker (`src/health/budget-tracker.ts`)
  - Called after each request completion with token counts and model cost data
  - Calculate cost: `(input_tokens * cost_input + output_tokens * cost_output) / 1_000_000`
  - Upsert into `budget_tracking` for current daily and monthly periods
  - Export `isBudgetExceeded()` function: checks daily and monthly totals against `routing_policy` limits
  - Used by candidate selection to exclude cloud models when budget is exceeded

- [ ] **5.3** Write health & budget tests (`test/health-budget.test.ts`)
  - Test: healthy model is marked healthy with latency recorded
  - Test: failed ping increments consecutive_failures
  - Test: 3 consecutive failures marks model unhealthy
  - Test: recovery after failure resets to healthy
  - Test: cost calculation is correct for known token counts
  - Test: budget tracking accumulates across requests
  - Test: `isBudgetExceeded()` returns true when daily limit exceeded
  - Test: `isBudgetExceeded()` returns true when monthly limit exceeded
  - Test: cloud models excluded from candidates when budget exceeded

**Phase 5 Checkpoint:** `npm test` passes (all Phase 1–5 tests). Commit and tag.

---

## Phase 6: Integration & Assembly

> **Goal**: Full server assembly, CLAUDE.md, stats endpoint, and end-to-end verification. The system is ready to run.

- [ ] **6.1** Implement application entry point (`src/index.ts`)
  - Load config
  - Initialize DB and run migrations
  - Create Fastify server with all routes
  - Start health check loop
  - Listen on configured port
  - Graceful shutdown: close server, stop health checker, close DB

- [ ] **6.2** Implement GET `/stats` endpoint (`src/routes/stats.ts`)
  - Query `request_log` for routing distribution (requests per tier, per model)
  - Query `budget_tracking` for cost breakdown (daily, monthly)
  - Query model usage stats (most used, average latency)
  - Return structured JSON summary

- [ ] **6.3** Create CLAUDE.md at project root
  - Content from PDR Section 10
  - Project description, architecture, key files, conventions, build/run commands, critical behaviors

- [ ] **6.4** Create `.env.example` with documentation comments
  - All environment variables from PDR Section 8
  - Comments explaining each variable

- [ ] **6.5** Write integration tests (`test/integration.test.ts`)
  - Test: full server starts and responds to /health
  - Test: /v1/models returns seeded model list
  - Test: /v1/chat/completions with mocked backend returns streamed response
  - Test: routing decision logged to request_log
  - Test: budget updated after request
  - Test: /stats returns usage data after requests

- [ ] **6.6** Final review and cleanup
  - Verify all tests pass: `npm test`
  - Verify build succeeds: `npm run build`
  - Verify dev mode starts: `npm run dev`
  - Review all files for consistency with PDR

**Phase 6 Checkpoint:** All tests pass, build succeeds, server starts cleanly. Final commit and tag.

---

## Summary

| Phase | Description | Steps | Status |
|-------|-------------|-------|--------|
| 1 | Project Foundation & Database Layer | 1.1–1.6 | **Complete** |
| 2 | Routing Engine | 2.1–2.9 | **Complete** |
| 3 | Backend Adapters | 3.1–3.5 | **Complete** |
| 4 | HTTP Server & API Endpoints | 4.1–4.5 | Not started |
| 5 | Health Monitoring & Budget Management | 5.1–5.3 | Not started |
| 6 | Integration & Assembly | 6.1–6.6 | Not started |
