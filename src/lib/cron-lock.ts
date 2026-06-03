/**
 * Single-flight guard for Vercel crons that drain a shared queue.
 *
 * Vercel cron fires "at-least-once" and a slow tick can still be
 * running when the next tick starts. Two ticks draining the same
 * `pipeline_run_videos` queue at the same time is a recipe for
 * double-charges (cron A claims a row, cron B claims the same row
 * before A's transaction commits, both call generateText, both
 * charge cost). Per-row `SELECT FOR UPDATE SKIP LOCKED` handles
 * the row-level race; this helper handles the *invocation-level*
 * race so the second tick exits cleanly instead of fighting for
 * rows alongside the first.
 *
 * Uses Postgres `pg_try_advisory_lock`, which is non-blocking and
 * session-scoped. A dedicated client owns the lock for the entire
 * critical section — the lock has to live on a single connection
 * (the migration runner's pattern at [./migrations/index.ts]
 * established the convention; we follow it for the same reason:
 * the default `@vercel/postgres` pool can hand out a different
 * connection per query, which would let the lock auto-release the
 * moment the connection was returned to the pool).
 *
 * The work inside `fn()` uses the pool freely. Advisory locks are
 * global to the Postgres instance, not per-connection-scope —
 * holding it on the dedicated client is enough to block other
 * invocations.
 *
 * Each cron picks its own `lockKey` so crons don't block each
 * other. Reserved keys live in `CRON_LOCK_KEYS` below; add a new
 * one (not a literal at the call site) whenever a new cron joins.
 *
 * Returns `{ ran: true, result }` when the lock was acquired and
 * `fn` completed. Returns `{ ran: false }` when another tick was
 * already in flight — the caller should respond 200 (not an
 * error) so Vercel doesn't retry the no-op.
 */
import { createClient } from '@vercel/postgres';
import { logger } from './logger';

/**
 * Reserved advisory-lock keys, one per cron that needs single-flight
 * semantics. Treat as append-only — never renumber.
 *
 * The pipeline-runner lock key is the first entry; subsequent crons
 * that need single-flight can claim the next integer. Migrations use
 * a separate, much larger key (`MIGRATION_LOCK_ID` in
 * [./migrations/index.ts]) so the pipeline cron and migration runs
 * can never block each other.
 */
export const CRON_LOCK_KEYS = {
  pipelineRunner: 8201,
  shortsAssetRunner: 8202,
} as const;

export type CronLockOutcome<T> = { ran: true; result: T } | { ran: false };

export async function withCronLock<T>(
  lockKey: number,
  fn: () => Promise<T>,
  opts: { connectionString?: string } = {},
): Promise<CronLockOutcome<T>> {
  const connectionString =
    opts.connectionString ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error(
      'POSTGRES_URL_NON_POOLING (preferred) or POSTGRES_URL must be set to acquire a cron advisory lock.',
    );
  }

  const client = createClient({ connectionString });
  await client.connect();
  try {
    // pg_try_advisory_lock(key) returns true on acquisition, false if
    // another session already holds the same key. Non-blocking.
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [lockKey],
    );
    const locked = rows[0]?.locked === true;

    if (!locked) {
      logger.info('cron-lock: skipped — another tick in flight', { lock_key: lockKey });
      return { ran: false };
    }

    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      // Release the lock even if `fn` threw. The dedicated client
      // would also release it on `end()` below, but releasing
      // explicitly is cheap and makes the intent obvious.
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
      } catch (err) {
        logger.warn('cron-lock: unlock query failed', {
          lock_key: lockKey,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    // end() closes the connection. If the unlock above failed,
    // end() also releases the lock (advisory locks are released on
    // backend exit). Wrap in try/catch so the outer caller sees
    // the work's result, not a connection-cleanup error.
    try {
      await client.end();
    } catch (err) {
      logger.warn('cron-lock: client.end failed', {
        lock_key: lockKey,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
