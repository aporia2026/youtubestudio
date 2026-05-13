import type { Migration } from './types';

/**
 * Phase 1 of the Lambda render migration (see `_plans/2026-05-13-lambda-render-migration.md`).
 *
 * `render_jobs` was never declared in a migration — both
 * `/api/render/video` and `/api/render/short` create it on demand via
 * `ensureTable()`. This migration adopts the table into the migrations
 * pipeline (so its shape is reviewable) and adds three Lambda-only
 * columns the route layer needs to track distributed renders:
 *
 *   - `lambda_render_id` — the id `renderMediaOnLambda` returns,
 *     distinct from our own `render_jobs.id` prefix scheme.
 *   - `lambda_bucket`    — the per-region Remotion S3 bucket
 *     `renderMediaOnLambda` writes into. `getRenderProgress` needs it
 *     alongside the renderId; storing it avoids re-deriving it on every
 *     poll.
 *   - `estimated_cost`   — populated on completion from
 *     `RenderProgress.costs.accruedSoFar`. Fuels the per-day spend cap
 *     enforced in Phase 5 of the same plan.
 *
 * The `CREATE TABLE IF NOT EXISTS` reproduces the exact shape both
 * routes already create on demand. Idempotent in both states:
 *  - fresh DB: creates the table, then adds the three new columns.
 *  - DB where `ensureTable()` already ran: CREATE is a no-op, ALTERs run.
 *
 * Once this migration is applied everywhere, the in-route
 * `ensureTable()` helpers become dead code — a follow-up can delete
 * them. Left alone here to keep the migration's blast radius minimal.
 */
const migration: Migration = {
  id: '0066_render_jobs_lambda_columns',
  description: 'Adopt render_jobs and add Lambda render-tracking columns',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS render_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        progress REAL NOT NULL DEFAULT 0,
        output_url TEXT,
        error TEXT,
        started_at BIGINT NOT NULL,
        finished_at BIGINT
      )
    `);
    await client.query(`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS lambda_render_id TEXT`);
    await client.query(`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS lambda_bucket    TEXT`);
    await client.query(`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS estimated_cost   REAL`);
  },

  async down(client) {
    await client.query(`ALTER TABLE render_jobs DROP COLUMN IF EXISTS estimated_cost`);
    await client.query(`ALTER TABLE render_jobs DROP COLUMN IF EXISTS lambda_bucket`);
    await client.query(`ALTER TABLE render_jobs DROP COLUMN IF EXISTS lambda_render_id`);
    // Intentionally NOT dropping the table — pre-existing rows from the
    // route's ensureTable() path predate this migration.
  },
};

export default migration;
