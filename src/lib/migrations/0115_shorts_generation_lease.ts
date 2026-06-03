import type { Migration } from './types';

/**
 * Phase 15.16 — lease columns so the background cron can claim, drive,
 * and heal Short style-asset generation jobs across ticks.
 *
 * The old model ran the whole pipeline (plan + base + N variants) inside
 * one 300s serverless request. A single slow vendor leg blew the budget,
 * Vercel hard-killed the function before its `.catch` could write an error
 * state, and the row froze mid-phase with every completed variant
 * discarded. See `_plans/2026-06-03-shorts-asset-generation-reliability.md`.
 *
 * The fix moves the work to `/api/cron/run-shorts-assets`, which claims a
 * short, advances it by a bounded amount, persists incrementally, and
 * releases. These two columns are the claim lease:
 *
 *   - generation_claimed_at      — when the current tick claimed the row.
 *                                  A row is claimable when this is NULL or
 *                                  older than the lease window, so a tick
 *                                  that died mid-work doesn't strand the
 *                                  job: the next tick reclaims and finishes
 *                                  it. THIS is what heals stuck jobs.
 *   - generation_claimed_by_tick — opaque tick id, for log correlation.
 *
 * The partial index speeds the claim scan to only rows with an in-flight
 * `generation_progress.phase`. Down migration drops both cleanly.
 */
const migration: Migration = {
  id: '0115_shorts_generation_lease',
  description: 'shorts generation lease columns + queue index for the background asset cron (Phase 15.16)',

  async up(client) {
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS generation_claimed_at TIMESTAMPTZ`,
    );
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS generation_claimed_by_tick TEXT`,
    );
    // Partial index: the cron's claim query filters on an in-flight phase,
    // which is a tiny fraction of all shorts. Indexing only those rows
    // keeps the scan cheap as the shorts table grows.
    await client.query(
      `CREATE INDEX IF NOT EXISTS shorts_generation_queue_idx
         ON shorts ((generation_progress->>'phase'))
       WHERE generation_progress ? 'phase'`,
    );
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS shorts_generation_queue_idx`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS generation_claimed_by_tick`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS generation_claimed_at`);
  },
};

export default migration;
