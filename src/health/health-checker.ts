import type Database from 'better-sqlite3';

interface EnabledModel {
  model_id: string;
  endpoint_url: string;
}

interface HealthLogEntry {
  consecutive_failures: number;
}

const UNHEALTHY_THRESHOLD = 3;

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

  for (const model of models) {
    const start = Date.now();
    try {
      await fetch(`${model.endpoint_url}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      markHealthy(db, model.model_id, latencyMs);
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      markUnhealthyCheck(db, model.model_id, errorMsg);
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
