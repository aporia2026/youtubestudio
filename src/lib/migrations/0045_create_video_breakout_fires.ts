import type { Migration } from './types';

/**
 * Phase 9.5 — record of breakout-detector fires.
 *
 * The detector walks the first-48h velocity of every recent video and
 * fires `video_breakout_detected` when the value exceeds the channel's
 * 90th percentile across the last 90 days. We need a record of fires
 * so we can:
 *
 *   1. Ensure each video fires AT MOST ONCE — a slow-burn breakout
 *      that creeps above the percentile every 6h would otherwise spam.
 *   2. Show the "recent breakouts" list on the dashboard / digest
 *      without re-running the percentile math.
 *
 * UNIQUE on (workspace, youtube_video_id) is the idempotency guarantee:
 * a second cron run that re-detects the same video gets ON CONFLICT
 * DO NOTHING.
 *
 * Indexed by `fired_at` per workspace so the digest can pull "fires
 * in the last 7 days" cheaply.
 */
const migration: Migration = {
  id: '0045_create_video_breakout_fires',
  description: 'Phase 9.5 — log of breakout-detector fires (one row per video)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_breakout_fires (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        youtube_video_id TEXT NOT NULL,
        channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,

        -- Snapshot of the math at fire time so the dashboard / digest
        -- doesn't have to recompute.
        velocity_views_per_hour NUMERIC(14,2) NOT NULL,
        percentile NUMERIC(4,3) NOT NULL,
        channel_p90 NUMERIC(14,2) NOT NULL,
        hours_since_publish NUMERIC(6,2) NOT NULL,

        fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (workspace_id, youtube_video_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_breakout_fires_workspace_time
        ON video_breakout_fires(workspace_id, fired_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_breakout_fires_channel_time
        ON video_breakout_fires(workspace_id, channel_id, fired_at DESC)
        WHERE channel_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS video_breakout_fires`);
  },
};

export default migration;
