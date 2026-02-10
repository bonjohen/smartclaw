import type Database from 'better-sqlite3';
import type { ChatRequest, RankedCandidate, StreamResponse } from '../types.js';
import { NoAvailableModelError } from '../types.js';
import { getBackend } from './backend.js';
import { markUnhealthyCheck } from '../health/health-checker.js';

/**
 * Try each candidate in ranked order. On failure, mark the provider/model
 * appropriately and move to the next candidate.
 */
export async function routeWithRetry(
  db: Database.Database,
  request: ChatRequest,
  candidates: RankedCandidate[]
): Promise<StreamResponse> {
  for (const candidate of candidates) {
    try {
      const backend = getBackend(candidate.model);
      const response = await backend.sendRequest(candidate.model, request);
      return { ...response, model: candidate.model };
    } catch (err: any) {
      logFailure(candidate, err);

      if (is429(err)) {
        markRateLimited(db, candidate.model.provider);
      } else if (isTimeout(err)) {
        markUnhealthy(db, candidate.model.model_id);
      } else if (isServerError(err)) {
        // Track consecutive server errors via health log (marks unhealthy after 3)
        const msg = err?.message ?? String(err);
        markUnhealthyCheck(db, candidate.model.model_id, msg);
      }

      continue;
    }
  }

  throw new NoAvailableModelError();
}

function logFailure(candidate: RankedCandidate, err: any): void {
  const msg = err?.message ?? String(err);
  // Use stderr for operational logging; structured logging handled at route level
  process.stderr.write(
    `[route-with-retry] Failed ${candidate.model.model_id} (rank ${candidate.rank}): ${msg}\n`
  );
}

/**
 * Check if an error represents an HTTP 429 rate limit response.
 */
export function is429(err: any): boolean {
  return err?.status === 429 ||
    err?.message?.includes('429') ||
    err?.message?.toLowerCase()?.includes('rate limit');
}

/**
 * Check if an error represents a timeout or connection failure.
 */
export function isTimeout(err: any): boolean {
  return err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'ETIMEDOUT' ||
    err?.cause?.code === 'ECONNREFUSED' ||
    err?.message?.toLowerCase()?.includes('timeout') ||
    err?.message?.toLowerCase()?.includes('econnrefused');
}

/**
 * Check if an error represents a server-side failure (5xx).
 */
export function isServerError(err: any): boolean {
  const status = err?.status ?? err?.statusCode;
  return typeof status === 'number' && status >= 500 && status < 600;
}

/**
 * Mark a provider as rate-limited in the database.
 */
export function markRateLimited(db: Database.Database, provider: string): void {
  db.prepare(`
    UPDATE provider_rate_limits
    SET is_rate_limited = 1,
        limited_since = CURRENT_TIMESTAMP,
        retry_after = datetime('now', '+60 seconds')
    WHERE provider = ?
  `).run(provider);
}

/**
 * Mark a model as unhealthy in the database.
 */
export function markUnhealthy(db: Database.Database, modelId: string): void {
  db.prepare(`
    UPDATE models
    SET is_healthy = 0,
        last_health_check = CURRENT_TIMESTAMP
    WHERE model_id = ?
  `).run(modelId);
}
