import type Database from 'better-sqlite3';

interface EnabledModel {
  model_id: string;
  endpoint_url: string;
}

interface HealthLogEntry {
  consecutive_failures: number;
}

const UNHEALTHY_THRESHOLD = 3;
const HEALTH_LOG_RETENTION_DAYS = 7;
const REQUEST_LOG_RETENTION_DAYS = 30;

/**
 * Start the background health check loop.
 * Returns a stop function for graceful shutdown.
 */
export function startHealthCheckLoop(
  db: Database.Database,
  intervalMs: number
): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const run = async () => {
    if (running) return; // skip if previous check still in progress
    running = true;
    try {
      await checkAllModels(db);
    } catch (err) {
      console.error('[health-checker] Loop error:', err);
    } finally {
      running = false;
    }
  };

  // Run immediately on start, then on interval
  run();
  timer = setInterval(run, intervalMs);

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Ping all enabled models and update their health status.
 */
export async function checkAllModels(db: Database.Database): Promise<void> {
  const models = db.prepare(
    'SELECT model_id, endpoint_url FROM models WHERE is_enabled = 1'
  ).all() as EnabledModel[];

  const results = await Promise.allSettled(
    models.map(async (model) => {
      const start = Date.now();
      await fetch(`${model.endpoint_url}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      return { model, latencyMs: Date.now() - start };
    })
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      markHealthy(db, result.value.model.model_id, result.value.latencyMs);
    } else {
      const errorMsg = result.reason?.message ?? String(result.reason);
      markUnhealthyCheck(db, models[i].model_id, errorMsg);
    }
  }
}

/**
 * Mark a model as healthy: reset consecutive failures, log the check, update model state.
 */
export function markHealthy(
  db: Database.Database,
  modelId: string,
  latencyMs: number
): void {
  db.prepare(`
    INSERT INTO model_health_log (model_id, is_healthy, latency_ms, consecutive_failures)
    VALUES (?, 1, ?, 0)
  `).run(modelId, latencyMs);

  db.prepare(`
    UPDATE models
    SET is_healthy = 1,
        last_health_check = CURRENT_TIMESTAMP
    WHERE model_id = ?
  `).run(modelId);
}

/**
 * Record a failed health check: increment consecutive failures, mark unhealthy after threshold.
 */
export function markUnhealthyCheck(
  db: Database.Database,
  modelId: string,
  errorMsg: string
): void {
  // Get current consecutive failure count from the most recent log entry
  const lastEntry = db.prepare(`
    SELECT consecutive_failures FROM model_health_log
    WHERE model_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(modelId) as HealthLogEntry | undefined;

  const consecutiveFailures = (lastEntry?.consecutive_failures ?? 0) + 1;

  db.prepare(`
    INSERT INTO model_health_log (model_id, is_healthy, error_msg, consecutive_failures)
    VALUES (?, 0, ?, ?)
  `).run(modelId, errorMsg, consecutiveFailures);

  // Mark model unhealthy after threshold consecutive failures
  if (consecutiveFailures >= UNHEALTHY_THRESHOLD) {
    db.prepare(`
      UPDATE models
      SET is_healthy = 0,
          last_health_check = CURRENT_TIMESTAMP
      WHERE model_id = ?
    `).run(modelId);
  } else {
    // Update timestamp but keep current health status
    db.prepare(`
      UPDATE models
      SET last_health_check = CURRENT_TIMESTAMP
      WHERE model_id = ?
    `).run(modelId);
  }
}

/**
 * Delete old entries from model_health_log and request_log to prevent unbounded growth.
 * Returns the number of rows deleted from each table.
 */
export function cleanupOldLogs(db: Database.Database): { healthLogsDeleted: number; requestLogsDeleted: number } {
  const healthResult = db.prepare(
    `DELETE FROM model_health_log WHERE checked_at < datetime('now', ? || ' days')`
  ).run(`-${HEALTH_LOG_RETENTION_DAYS}`);

  const requestResult = db.prepare(
    `DELETE FROM request_log WHERE request_at < datetime('now', ? || ' days')`
  ).run(`-${REQUEST_LOG_RETENTION_DAYS}`);

  return {
    healthLogsDeleted: healthResult.changes,
    requestLogsDeleted: requestResult.changes,
  };
}

/**
 * Start a periodic log cleanup loop. Runs daily.
 */
export function startCleanupLoop(
  db: Database.Database,
  intervalMs = 24 * 60 * 60 * 1000
): { stop: () => void } {
  const timer = setInterval(() => {
    try {
      const result = cleanupOldLogs(db);
      if (result.healthLogsDeleted > 0 || result.requestLogsDeleted > 0) {
        console.log(`[cleanup] Deleted ${result.healthLogsDeleted} health logs, ${result.requestLogsDeleted} request logs`);
      }
    } catch (err) {
      console.error('[cleanup] Error:', err);
    }
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
