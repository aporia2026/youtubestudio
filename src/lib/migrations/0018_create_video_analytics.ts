import type { Migration } from './types';

/**
 * Per-video analytics cache. One row per (workspace, youtube_video_id).
 *
 * Data is sourced from two YouTube APIs:
 *   - Data API v3 (`youtube.readonly`): public stats — views, likes,
 *     comments. Always available on any OAuth-connected channel.
 *   - Analytics API v2 (`yt-analytics.readonly`): performance metrics —
 *     impressions, CTR, average view duration / percentage, subscribers
 *     gained, retention curve. Requires the analytics scope, which the
 *     legacy OAuth flow did NOT include — channels connected before this
 *     PR will fall back to Data-API-only stats until the user re-auths.
 *
 * `data_source` records what we actually got: 'data' | 'analytics' |
 * 'mixed' | 'partial'. The UI uses it to show a "missing analytics —
 * re-connect channel" hint when a row is data-only.
 *
 * `retention_curve` is a JSONB array of { position, retention } points
 * (0..1 each). Sparse — typically 100 buckets but the Analytics API
 * returns fewer for shorter videos.
 *
 * Sync is idempotent: PRIMARY KEY (workspace_id, youtube_video_id) lets
 * us upsert on every call.
 */
const migration: Migration = {
  id: '0018_create_video_analytics',
  description: 'Per-video analytics cache (snapshot stats + retention curve)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_analytics (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        youtube_video_id TEXT NOT NULL,

        channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
        schedule_item_id UUID REFERENCES schedule_items(id) ON DELETE SET NULL,

        -- Public stats (Data API v3)
        views BIGINT,
        likes INTEGER,
        comments INTEGER,
        duration_seconds INTEGER,
        published_at TIMESTAMPTZ,
        title TEXT,
        thumbnail_url TEXT,

        -- Performance metrics (Analytics API v2)
        impressions BIGINT,
        ctr_percentage NUMERIC(6,3),
        average_view_duration_seconds INTEGER,
        average_view_percentage NUMERIC(6,3),
        subscribers_gained INTEGER,

        -- Retention curve: [{ position: 0..1, retention: 0..1 }, ...]
        retention_curve JSONB,

        data_source TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (workspace_id, youtube_video_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_analytics_schedule_item
        ON video_analytics(schedule_item_id) WHERE schedule_item_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_analytics_channel
        ON video_analytics(channel_id) WHERE channel_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_analytics_fetched
        ON video_analytics(workspace_id, fetched_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS video_analytics`);
  },
};

export default migration;
