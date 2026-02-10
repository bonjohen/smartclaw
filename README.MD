# OpenClaw Smart Router

A TypeScript proxy server that routes LLM requests to the optimal backend (local, LAN, or cloud) using a SQLite-backed model registry and three-tier decision engine.

Point any OpenAI-compatible client at the router and it automatically picks the cheapest, fastest model that can handle the request — local Ollama first, LAN machines second, cloud APIs only when necessary.

## How It Works

```
Client  POST /v1/chat/completions
  │
  ▼
┌─────────────────────────────────────┐
│  Tier 1: Deterministic Rules (0ms)  │  ← heartbeats, greetings, slash commands
│  Match source/pattern/media → model │     resolves 40-60% of requests
└──────────────┬──────────────────────┘
               │ no match
               ▼
┌─────────────────────────────────────┐
│  Tier 2: LLM Classification (50ms) │  ← DeepSeek-R1-1.5B via local Ollama
│  complexity + task_type → quality   │     determines quality floor + capability
│  floor + required capability        │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Candidate Selection                │  ← rank by location (local>LAN>cloud),
│  Filter: quality, health, budget,   │     then cost, then quality
│  capability, context window         │
└──────────────┬──────────────────────┘
               │ no candidates
               ▼
┌─────────────────────────────────────┐
│  Tier 3: Fallback                   │  ← configured default model
└─────────────────────────────────────┘
```

## Supported Models

| Model | Location | Quality | Cost |
|-------|----------|---------|------|
| DeepSeek R1 1.5B | Local (Ollama) | 25 | Free |
| DeepSeek R1 7B | Local (Ollama) | 45 | Free |
| DeepSeek R1 32B | LAN (MBP M4) | 68 | Free |
| DeepSeek R1 70B | LAN (DGX Spark) | 78 | Free |
| Claude Haiku | Cloud (Anthropic) | 55 | $ |
| Claude Sonnet | Cloud (Anthropic) | 82 | $$$ |
| Claude Opus | Cloud (Anthropic) | 95 | $$$$$ |
| GPT-4o | Cloud (OpenAI) | 76 | $$ |
| GPT-5.2 | Cloud (OpenAI) | 92 | $$$$ |

Models are stored in SQLite and can be added/modified via SQL.

## Quick Start

```bash
# Install dependencies
npm install

# Create database and run migrations
npm run migrate

# Copy and configure environment
cp .env.example .env
# Edit .env with your API keys and endpoints

# Start in development mode (hot reload)
npm run dev
```

The server starts on port 3000 by default. Send requests to it like any OpenAI API:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

If `ROUTER_API_KEY` is set, include a bearer token:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/v1/chat/completions` | POST | Yes | OpenAI-compatible chat completions (streaming + non-streaming) |
| `/v1/models` | GET | Yes | List available models |
| `/health` | GET | No | Proxy status, model health, budget info |
| `/stats` | GET | Yes | Routing distribution, cost breakdown, model usage |

All endpoints except `/health` require a bearer token when `ROUTER_API_KEY` is configured. Response headers include `X-Router-Model` and `X-Router-Tier` for debugging which model handled the request and how it was selected.

## Configuration

All configuration via environment variables (or `.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTER_PORT` | `3000` | Server listen port |
| `ROUTER_DB_PATH` | `~/.openclaw/router/router.db` | SQLite database path |
| `ROUTER_OLLAMA_ENDPOINT` | `http://127.0.0.1:11434` | Local Ollama for Tier 2 classification |
| `ROUTER_MODEL_NAME` | `deepseek-r1:1.5b` | Classification model |
| `HEALTH_CHECK_INTERVAL_MS` | `60000` | Health check interval (minimum 1000) |
| `ROUTER_API_KEY` | — | Bearer token for API authentication (all routes except `/health`) |
| `ANTHROPIC_API_KEY` | — | Anthropic API key for cloud models |
| `ANTHROPIC_API_VERSION` | `2023-06-01` | Anthropic Messages API version header |
| `OPENAI_API_KEY` | — | OpenAI API key for cloud models |

## Docker

```bash
# Build and run with docker-compose
docker compose up -d

# Or build manually
docker build -t openclaw-router .
docker run -p 3000:3000 --env-file .env openclaw-router
```

The Docker setup uses `extra_hosts` to allow the container to reach local/LAN Ollama instances via `host.docker.internal`. SQLite data persists in a named volume.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled server |
| `npm run migrate` | Initialize database + run migrations |
| `npm test` | Run test suite |
| `npm run test:watch` | Run tests in watch mode |

## Testing

```bash
npm test

# With coverage report
npx vitest run --coverage
```

250 tests across 13 test files covering all layers: database, routing engine (tiers 1-3), backend adapters (OpenAI + Anthropic streaming and non-streaming), HTTP endpoints, health monitoring, budget tracking, authentication, input validation, and end-to-end integration. All tests use in-memory SQLite for isolation. Overall statement coverage: 91.6%.

## Project Structure

```
src/
  config.ts              # Environment configuration
  db.ts                  # SQLite initialization + migrations
  index.ts               # Application entry point
  server.ts              # Fastify server setup
  types.ts               # Shared TypeScript types
  router/
    router.ts            # Tier 1 → 2 → 3 orchestrator
    tier1-rules.ts       # Deterministic SQL rule matching
    tier2-classify.ts    # LLM classification via Ollama
    tier3-fallback.ts    # Fallback model selection
    candidate-select.ts  # Model ranking + filtering
  backends/
    backend.ts           # Backend interface + factory
    openai-backend.ts    # OpenAI/Ollama streaming adapter
    anthropic-backend.ts # Anthropic Messages API translator
    route-with-retry.ts  # Candidate iteration + error handling
  routes/
    chat-completions.ts  # POST /v1/chat/completions
    models.ts            # GET /v1/models
    health.ts            # GET /health
    stats.ts             # GET /stats
  health/
    health-checker.ts    # Background health monitoring (60s loop)
    budget-tracker.ts    # Cost accumulation + budget gating
migrations/
  001_initial.sql        # Database schema
  002_seed.sql           # Model registry + routing rules
```

## Key Behaviors

- **Quality tolerance** (default ±5): LAN models with quality 78 can handle requests needing quality 80, avoiding unnecessary cloud spend
- **Automatic failover**: On backend failure, tries the next candidate — never fails without exhausting the full list + fallback
- **Budget gating**: Cloud models are excluded from candidates when daily or monthly spend limits are exceeded
- **Health monitoring**: Background loop pings models every 60s; 3 consecutive failures mark a model unhealthy
- **Streaming passthrough**: SSE chunks are piped through without buffering — the router never holds a full response in memory
- **Rate limit auto-recovery**: Providers marked rate-limited (429) auto-clear after 60 seconds — no manual intervention needed
- **Request validation**: JSON Schema validation on chat completions prevents malformed requests from reaching backends
- **Log retention**: Health logs auto-purge after 7 days, request logs after 30 days to prevent unbounded DB growth

## License

Private.
