/**
 * Postgres-backed fixed-window rate limiter. Concurrency-safe across
 * serverless function instances via a single atomic upsert per request.
 *
 * Why fixed-window and not sliding: a fixed window can be exploited at
 * the boundary (full burst at the end of window N + full burst at the
 * start of window N+1 yields 2× limit briefly). For the threat we care
 * about — brute-forcing a 12-char-min bcrypt-cost-11 password — that
 * boundary effect is not exploitable in practice. A sliding window can
 * be added later without changing the table shape.
 *
 * Bucket key shape: `${endpoint}:${identifier}` where identifier is an IP
 * for unauthenticated routes (login, forgot-password) and a user id for
 * authenticated routes (AI generation, uploads).
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';

export interface RateLimitOptions {
  /** Logical bucket key (e.g. "auth.login:1.2.3.4"). */
  key: string;
  /** Max number of hits permitted within the window. */
  limit: number;
  /** Window length in milliseconds (1m, 5m, etc.). */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: Date;
  count: number;
  limit: number;
}

/** Window start for `now`, aligned to a multiple of windowMs from epoch. */
export function windowStartFor(now: number, windowMs: number): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}

/**
 * Atomically count this hit against the bucket. Returns `ok: false` when
 * the count exceeds the limit. Always increments — by design, every
 * attempt counts toward the limit, even rejected ones, to slow down
 * brute-force probing.
 */
export async function checkAndIncrementRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = windowStartFor(now, opts.windowMs);
  const resetAt = new Date(windowStart.getTime() + opts.windowMs);

  try {
    const { rows } = await sql<{ count: number }>`
      INSERT INTO rate_limits (bucket_key, window_start, count)
      VALUES (${opts.key}, ${windowStart.toISOString()}::timestamptz, 1)
      ON CONFLICT (bucket_key, window_start)
      DO UPDATE SET count = rate_limits.count + 1
      RETURNING count
    `;
    const count = rows[0]?.count ?? 0;
    return {
      ok: count <= opts.limit,
      remaining: Math.max(0, opts.limit - count),
      resetAt,
      count,
      limit: opts.limit,
    };
  } catch (err) {
    // Fail open: if the rate-limit table is unreachable we'd rather let
    // the request through than 500 the user. The logger captures the issue.
    logger.error('rate-limit upsert failed; failing open', {
      detail: err instanceof Error ? err.message : String(err),
      key: opts.key,
    });
    return {
      ok: true,
      remaining: opts.limit,
      resetAt,
      count: 0,
      limit: opts.limit,
    };
  }
}

/**
 * Delete buckets whose window_start is older than `olderThan`. Best-effort
 * cleanup — never throws. Run periodically via a cron or invoke at the
 * end of any rate-limit check.
 */
export async function pruneOldRateLimitBuckets(olderThan: Date): Promise<number> {
  try {
    const result = await sql`
      DELETE FROM rate_limits WHERE window_start < ${olderThan.toISOString()}::timestamptz
    `;
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn('rate-limit prune failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Build the standard rate-limit response headers used by route handlers
 * that have applied a rate limit. Mirrors the conventions in
 * draft-ietf-httpapi-ratelimit-headers.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))),
  };
}
