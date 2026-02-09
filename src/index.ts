import { loadConfig } from './config.js';
import { initDb, setDb, closeDb } from './db.js';
import { createServer } from './server.js';
import { startHealthCheckLoop } from './health/health-checker.js';
import { registerStats } from './routes/stats.js';

async function main() {
  const config = loadConfig();

  // Initialize database and run migrations
  const db = initDb(config.dbPath);
  setDb(db);
  console.log(`Database initialized at ${config.dbPath}`);

  // Build router options from config
  const routerOptions = {
    classifyOptions: {
      ollamaEndpoint: config.ollamaEndpoint,
      modelName: config.routerModelName,
    },
  };

  // Create and configure the server
  const app = createServer({ db, routerOptions });

  // Register the stats endpoint (bonus)
  registerStats(app, db);

  // Start background health check loop
  const healthChecker = startHealthCheckLoop(db, config.healthCheckIntervalMs);
  console.log(`Health check loop started (interval: ${config.healthCheckIntervalMs}ms)`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    healthChecker.stop();
    await app.close();
    closeDb();
    console.log('Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start listening
  try {
    const address = await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`OpenClaw Smart Router listening on ${address}`);
    console.log(`  POST ${address}/v1/chat/completions`);
    console.log(`  GET  ${address}/v1/models`);
    console.log(`  GET  ${address}/health`);
    console.log(`  GET  ${address}/stats`);
  } catch (err) {
    console.error('Failed to start server:', err);
    healthChecker.stop();
    closeDb();
    process.exit(1);
  }
}

main();
