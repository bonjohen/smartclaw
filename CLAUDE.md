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
