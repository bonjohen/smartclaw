import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// We need to re-import loadConfig fresh for each test, but the module caches dotenv.
// Instead, we directly test loadConfig by manipulating process.env before importing.

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all router-related env vars to test defaults
    delete process.env.ROUTER_PORT;
    delete process.env.ROUTER_DB_PATH;
    delete process.env.ROUTER_OLLAMA_ENDPOINT;
    delete process.env.ROUTER_MODEL_NAME;
    delete process.env.HEALTH_CHECK_INTERVAL_MS;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  // Dynamic import to get fresh module each time
  async function getLoadConfig() {
    // Reset module cache so loadConfig re-reads process.env
    const mod = await import('../src/config.js');
    return mod.loadConfig;
  }

  it('should return default values when no env vars set', async () => {
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.port).toBe(3000);
    expect(config.ollamaEndpoint).toBe('http://127.0.0.1:11434');
    expect(config.routerModelName).toBe('deepseek-r1:1.5b');
    expect(config.healthCheckIntervalMs).toBe(60000);
  });

  it('should use default DB path with ~ expansion', async () => {
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    const expected = path.join(os.homedir(), '.openclaw', 'router', 'router.db');
    expect(config.dbPath).toBe(expected);
  });

  it('should override port from ROUTER_PORT env var', async () => {
    process.env.ROUTER_PORT = '3000';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.port).toBe(3000);
  });

  it('should override DB path from ROUTER_DB_PATH', async () => {
    process.env.ROUTER_DB_PATH = '/tmp/test.db';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.dbPath).toBe(path.resolve('/tmp/test.db'));
  });

  it('should expand ~ in ROUTER_DB_PATH', async () => {
    process.env.ROUTER_DB_PATH = '~/mydata/router.db';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    const expected = path.join(os.homedir(), 'mydata', 'router.db');
    expect(config.dbPath).toBe(expected);
  });

  it('should override Ollama endpoint from ROUTER_OLLAMA_ENDPOINT', async () => {
    process.env.ROUTER_OLLAMA_ENDPOINT = 'http://192.168.1.100:11434';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.ollamaEndpoint).toBe('http://192.168.1.100:11434');
  });

  it('should override model name from ROUTER_MODEL_NAME', async () => {
    process.env.ROUTER_MODEL_NAME = 'llama3:8b';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.routerModelName).toBe('llama3:8b');
  });

  it('should override health check interval from HEALTH_CHECK_INTERVAL_MS', async () => {
    process.env.HEALTH_CHECK_INTERVAL_MS = '30000';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.healthCheckIntervalMs).toBe(30000);
  });

  it('should throw on invalid port (negative)', async () => {
    process.env.ROUTER_PORT = '-1';
    const loadConfig = await getLoadConfig();

    expect(() => loadConfig()).toThrow('Invalid ROUTER_PORT');
  });

  it('should throw on invalid port (too high)', async () => {
    process.env.ROUTER_PORT = '99999';
    const loadConfig = await getLoadConfig();

    expect(() => loadConfig()).toThrow('Invalid ROUTER_PORT');
  });

  it('should throw on invalid port (non-numeric)', async () => {
    process.env.ROUTER_PORT = 'abc';
    const loadConfig = await getLoadConfig();

    expect(() => loadConfig()).toThrow('Invalid ROUTER_PORT');
  });

  it('should throw on invalid health check interval (too low)', async () => {
    process.env.HEALTH_CHECK_INTERVAL_MS = '500';
    const loadConfig = await getLoadConfig();

    expect(() => loadConfig()).toThrow('Invalid HEALTH_CHECK_INTERVAL_MS');
  });

  it('should throw on invalid health check interval (non-numeric)', async () => {
    process.env.HEALTH_CHECK_INTERVAL_MS = 'fast';
    const loadConfig = await getLoadConfig();

    expect(() => loadConfig()).toThrow('Invalid HEALTH_CHECK_INTERVAL_MS');
  });

  it('should accept port at boundary (1)', async () => {
    process.env.ROUTER_PORT = '1';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.port).toBe(1);
  });

  it('should accept port at boundary (65535)', async () => {
    process.env.ROUTER_PORT = '65535';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.port).toBe(65535);
  });

  it('should accept minimum valid health check interval (1000)', async () => {
    process.env.HEALTH_CHECK_INTERVAL_MS = '1000';
    const loadConfig = await getLoadConfig();
    const config = loadConfig();

    expect(config.healthCheckIntervalMs).toBe(1000);
  });
});
