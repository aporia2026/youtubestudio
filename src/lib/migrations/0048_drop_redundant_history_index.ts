import type { Migration } from './types';

/**
 * Phase 9.8.3 — drop the redundant per-video index on
 * `video_analytics_history`.
 *
 * Migration 0041 created `idx_video_analytics_history_video_time` on
 * (workspace_id, youtube_video_id, captured_at DESC). The table's
 * PRIMARY KEY is the same column set in the same order — Postgres
 * can read a btree backwards efficiently, so the explicit index is
 * pure write amplification (every INSERT writes to two indexes
 * instead of one) with zero read benefit.
 *
 * The QA review of Phase 9 surfaced this. Dropping is safe — the PK
 * itself supports every `ORDER BY captured_at DESC` query that hit
 * this index.
 *
 * The other 0041 index (`idx_video_analytics_history_channel_time`
 * partial on `WHERE channel_id IS NOT NULL`) STAYS — it supports
 * 9.5's per-channel velocity-percentile lookup which the PK
 * doesn't cover.
 */
const migration: Migration = {
  id: '0048_drop_redundant_history_index',
  description: 'Phase 9.8.3 — drop video_analytics_history per-video index that duplicates the PK',

  async up(client) {
    await client.query(`
      DROP INDEX IF EXISTS idx_video_analytics_history_video_time
    `);
  },

  async down(client) {
    // Recreate exactly as 0041 had it, in case a rollback is needed.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_analytics_history_video_time
        ON video_analytics_history(workspace_id, youtube_video_id, captured_at DESC)
    `);
  },
};

export default migration;
