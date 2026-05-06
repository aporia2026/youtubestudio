import type { Migration } from './types';

/**
 * Phase 9.2 — traffic source breakdown per video.
 *
 * YouTube Analytics' `insightTrafficSourceType` dimension exposes how
 * a video's views are distributed across Browse Features, Suggested
 * Videos, YouTube Search, External, Shorts Feed, Channel Pages,
 * Playlists, and a few others. Suggested-feed share is the single
 * highest-leverage signal of channel health: it's the algorithm's
 * vote for whether the video is "promotable" to fresh audiences.
 *
 * We store it on the LIVE `video_analytics` row (not history) because:
 *   - Distribution shifts slowly within a video's lifecycle, so the
 *     latest snapshot is the useful one.
 *   - Storing it in the history table would inflate every snapshot
 *     row with a JSONB blob.
 *
 * Shape (jsonb): `{ "BROWSE": 12345, "SEARCH": 5678, "SUGGESTED": 9876,
 * "EXTERNAL": 432, "SHORTS_FEED": 0, "OTHER": 100 }` — keys are
 * YouTube's source-type enum values (uppercased), values are absolute
 * view counts. Percentages are computed at read time so we never have
 * to re-store on view-count drift. NULL until first sync writes it.
 */
const migration: Migration = {
  id: '0042_add_traffic_source_breakdown',
  description: 'Phase 9.2 — add traffic_source_breakdown jsonb to video_analytics',

  async up(client) {
    await client.query(`
      ALTER TABLE IF EXISTS video_analytics
        ADD COLUMN IF NOT EXISTS traffic_source_breakdown JSONB
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE IF EXISTS video_analytics
        DROP COLUMN IF EXISTS traffic_source_breakdown
    `);
  },
};

export default migration;
