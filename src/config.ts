import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import os from 'node:os';

loadDotenv();

export interface Config {
  port: number;
  dbPath: string;
  ollamaEndpoint: string;
  routerModelName: string;
  healthCheckIntervalMs: number;
  apiKey?: string;
}

function resolveDbPath(raw: string): string {
  if (raw.startsWith('~')) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return path.resolve(raw);
}

export function loadConfig(): Config {
  const port = parseInt(process.env.ROUTER_PORT ?? '3000', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ROUTER_PORT: ${process.env.ROUTER_PORT}`);
  }

  const dbPath = resolveDbPath(process.env.ROUTER_DB_PATH ?? '~/.openclaw/router/router.db');
  const ollamaEndpoint = process.env.ROUTER_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';
  const routerModelName = process.env.ROUTER_MODEL_NAME ?? 'deepseek-r1:1.5b';

  const healthCheckIntervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS ?? '60000', 10);
  if (isNaN(healthCheckIntervalMs) || healthCheckIntervalMs < 1000) {
    throw new Error(`Invalid HEALTH_CHECK_INTERVAL_MS: ${process.env.HEALTH_CHECK_INTERVAL_MS}`);
  }

  const apiKey = process.env.ROUTER_API_KEY || undefined;

  return {
    port,
    dbPath,
    ollamaEndpoint,
    routerModelName,
    healthCheckIntervalMs,
    apiKey,
  };
}
