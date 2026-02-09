# ── Stage 1: Builder ──
FROM node:22-bookworm AS builder

# Install build tools for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (including dev for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/

RUN npx tsc

# Prune devDependencies
RUN npm ci --omit=dev

# ── Stage 2: Runtime ──
FROM node:22-bookworm-slim

# Install tini for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/package.json ./package.json

# Create non-root user
RUN groupadd -r openclaw && useradd -r -g openclaw -m openclaw \
    && mkdir -p /data && chown openclaw:openclaw /data

USER openclaw

ENV NODE_ENV=production
ENV ROUTER_DB_PATH=/data/router.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
