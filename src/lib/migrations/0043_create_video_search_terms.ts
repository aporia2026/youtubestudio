import type { Migration } from './types';

/**
 * Phase 9.3 — search-query tracking.
 *
 * YouTube Analytics' `insightTrafficSourceDetail` dimension, filtered
 * by `insightTrafficSourceType==YT_SEARCH`, exposes the actual search
 * queries that surfaced the video. Pairs with impression / view / CTR
 * metrics so we can find HIGH-impression, LOW-CTR queries — the
 * canonical SEO opportunity (the audience is searching for it but
 * the title isn't compelling enough to click).
 *
 * Storage: append-only with composite PK on (workspace, video, term,
 * captured_at). Each sync writes ONE row per (video, query) pair, so
 * we have query-level trajectory just like the video-level history.
 *
 * Most videos have ≤20 queries that drive measurable traffic; we cap
 * the per-sync write at 50 rows defensively. The captured_at
 * timestamp + the existing video_analytics.published_at give the
 * digest writer everything it needs to surface "queries that started
 * driving traffic THIS week."
 *
 * No FK to video_analytics: that table's PK is (workspace,
 * youtube_video_id) which we mirror here. Cascade-delete on workspace
 * suffices.
 */
const migration: Migration = {
  id: '0043_create_video_search_terms',
  description: 'Phase 9.3 — per-video search-term performance from insightTrafficSourceDetail',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_search_terms (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        youtube_video_id TEXT NOT NULL,
        channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,

        -- The search query string itself. Lowercased on write so
        -- "AI agents" and "ai agents" don't fragment the trajectory.
        search_term TEXT NOT NULL,

        impressions BIGINT,
        views BIGINT,
        -- CTR is recomputed at write time as views/impressions*100
        -- (the API doesn't return it for the detail dimension).
        ctr_percentage NUMERIC(6,3),

        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (workspace_id, youtube_video_id, search_term, captured_at)
      )
    `);

    // Per-video read for the SEO suggestions panel.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_search_terms_video_time
        ON video_search_terms(workspace_id, youtube_video_id, captured_at DESC)
    `);

    // Per-channel cross-section so the digest can roll up search-term
    // coverage across a channel's recent videos.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_search_terms_channel_time
        ON video_search_terms(workspace_id, channel_id, captured_at DESC)
        WHERE channel_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS video_search_terms`);
  },
};

export default migration;
