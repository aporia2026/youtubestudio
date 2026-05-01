import type { Migration } from './types';

/**
 * Postgres-backed rate-limit storage.
 *
 * One row per (bucket_key, window_start) — the runner-bookkeeping pattern
 * used in `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`
 * gives an atomic increment that is concurrency-safe across serverless
 * function instances. The Vercel-hobby in-memory rate limiter from the
 * legacy code path (src/lib/rate-limit.ts) does NOT survive cold starts;
 * this table fixes that.
 *
 * The window_start index is for cleanup, not lookup. Lookups go straight
 * at the primary key.
 */
const migration: Migration = {
  id: '0015_create_rate_limits',
  description: 'Concurrency-safe rate-limit buckets (postgres atomic upsert)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket_key TEXT NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_key, window_start)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
        ON rate_limits (window_start)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS rate_limits`);
  },
};

export default migration;
