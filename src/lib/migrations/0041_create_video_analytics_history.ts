import type { Migration } from './types';

/**
 * Phase 9.1 — time-series snapshots of video stats.
 *
 * `video_analytics` is a per-video CACHE — one row per
 * (workspace, youtube_video_id), upserted on every sync. That makes
 * "what's the latest" cheap but loses every prior reading. Phase 9.5
 * (breakout detector) and 9.6 (weekly digest) need TRAJECTORY: views
 * gained per hour over the first 48h, CTR over time, sub velocity.
 *
 * `video_analytics_history` is the append-only twin. The Phase 9.1
 * cron snapshots tracked videos every ~6 hours and inserts one row
 * per snapshot. Schema mirrors the live `video_analytics` table for
 * the columns that change over time (views, likes, comments,
 * impressions, CTR, AVD, AVP, subs gained); we deliberately skip the
 * retention curve (heavy JSONB; only the latest is useful for the
 * predictor — the live row already stores it).
 *
 * Composite PK `(workspace_id, youtube_video_id, captured_at)` lets
 * us insert without conflict (each cron tick is a new captured_at)
 * AND lets the read path use index-only scans for "trajectory of
 * THIS video over the last N days".
 *
 * The (workspace_id, channel_id, captured_at DESC) index supports
 * 9.5's per-channel velocity-percentile computation, where we need
 * "every snapshot for every video on this channel in the last 48h."
 */
const migration: Migration = {
  id: '0041_create_video_analytics_history',
  description: 'Phase 9.1 — append-only time-series snapshots of video_analytics for velocity/trajectory features',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_analytics_history (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        youtube_video_id TEXT NOT NULL,

        -- denormalised for cheap channel-level aggregations (9.5).
        -- Mirrors video_analytics.channel_id; ON DELETE SET NULL because
        -- a deleted channel shouldn't drop history (the videos may
        -- still be live and queryable by youtube_video_id alone).
        channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,

        -- Stats that change over time. Retention curve deliberately
        -- omitted — only the latest matters for the predictor + we
        -- don't want a JSONB blob in every snapshot row.
        views BIGINT,
        likes INTEGER,
        comments INTEGER,
        impressions BIGINT,
        ctr_percentage NUMERIC(6,3),
        average_view_duration_seconds INTEGER,
        average_view_percentage NUMERIC(6,3),
        subscribers_gained INTEGER,

        data_source TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (workspace_id, youtube_video_id, captured_at)
      )
    `);

    // Trajectory of one video, newest-first. Index-only scan for the
    // dashboard's velocity sparkline + 9.5's percentile lookup.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_analytics_history_video_time
        ON video_analytics_history(workspace_id, youtube_video_id, captured_at DESC)
    `);

    // Per-channel cross-section for 9.5's "what's the channel's 90th
    // percentile velocity in the last 48h" query.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_analytics_history_channel_time
        ON video_analytics_history(workspace_id, channel_id, captured_at DESC)
        WHERE channel_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS video_analytics_history`);
  },
};

export default migration;
