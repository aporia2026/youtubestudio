import type { Migration } from './types';

/**
 * Cached YouTube comments + AI triage for the in-app comment management
 * surface.
 *
 * One row per comment (top-level OR reply — `parent_yt_comment_id` is
 * null for top-level). We sync from YouTube's `commentThreads.list`
 * (public API key, no OAuth needed for read), then layer AI intent
 * classification on top, then provide write operations (reply,
 * moderate) via the channel's OAuth token.
 *
 * Why cache instead of calling YouTube every page load:
 *   - YouTube Data API quota is 10K units/day default. Each
 *     commentThreads.list = 1 unit; each list call returns up to 100
 *     comments. Caching lets us page locally without burning quota on
 *     re-renders.
 *   - The AI triage step is the expensive one (LLM token spend) — we
 *     classify ONCE per comment and store the result. Re-classifying
 *     is opt-in.
 *
 * `replied_with_yt_comment_id` records the id of OUR reply on YouTube,
 * so we can correlate "we replied to X with comment Y" without scanning
 * all comments.
 *
 * `moderation_status` mirrors YouTube's: 'heldForReview' | 'published'
 * | 'rejected' | 'likelySpam' | null. Setting it to 'rejected' calls
 * comments.setModerationStatus on YouTube via the channel OAuth.
 *
 * `youtube_comment_id` is unique per workspace — a comment id never
 * legitimately appears twice for the same workspace, so this lets us
 * use ON CONFLICT for cheap upserts during sync.
 *
 * Pinning is NOT modelled here — YouTube's public API doesn't expose
 * comment pinning (it's a Studio UI-only operation as of May 2026).
 */
const migration: Migration = {
  id: '0031_create_youtube_comments',
  description: 'Cached YouTube comments with AI intent triage + reply/moderation tracking',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS youtube_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        channel_db_id UUID REFERENCES channels(id) ON DELETE SET NULL,

        youtube_video_id TEXT NOT NULL,
        youtube_comment_id TEXT NOT NULL,
        parent_yt_comment_id TEXT,

        author_name TEXT,
        author_channel_id TEXT,
        text TEXT NOT NULL,
        like_count INTEGER NOT NULL DEFAULT 0,
        reply_count INTEGER NOT NULL DEFAULT 0,
        published_at TIMESTAMPTZ,
        updated_at_yt TIMESTAMPTZ,

        moderation_status TEXT,
        author_is_channel_owner BOOLEAN NOT NULL DEFAULT FALSE,

        intent TEXT,
        intent_confidence NUMERIC(4,3),
        intent_classified_at TIMESTAMPTZ,
        suggested_reply TEXT,
        ai_model TEXT,

        replied BOOLEAN NOT NULL DEFAULT FALSE,
        replied_at TIMESTAMPTZ,
        replied_with_yt_comment_id TEXT,
        our_reply_text TEXT,

        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT youtube_comments_workspace_yt_id_unique
          UNIQUE (workspace_id, youtube_comment_id),
        CONSTRAINT youtube_comments_intent_chk
          CHECK (intent IS NULL OR intent IN ('question','support','troll','fan','spam','feedback','self_promo','other'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_comments_workspace_video
        ON youtube_comments(workspace_id, youtube_video_id, published_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_comments_channel
        ON youtube_comments(channel_db_id, published_at DESC) WHERE channel_db_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_comments_intent
        ON youtube_comments(workspace_id, intent) WHERE intent IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_comments_unreplied
        ON youtube_comments(workspace_id, published_at DESC) WHERE replied = FALSE AND parent_yt_comment_id IS NULL
    `);

    /**
     * Per-(workspace, video) sync attempt log. We don't go nuts here —
     * one row per sync run with totals + duration is enough to debug
     * "why didn't my comments load" without storing per-comment audit.
     */
    await client.query(`
      CREATE TABLE IF NOT EXISTS comment_sync_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        channel_db_id UUID REFERENCES channels(id) ON DELETE SET NULL,
        youtube_video_id TEXT NOT NULL,

        status TEXT NOT NULL DEFAULT 'running',
        error_message TEXT,
        comments_fetched INTEGER NOT NULL DEFAULT 0,
        comments_inserted INTEGER NOT NULL DEFAULT 0,
        comments_updated INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,

        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,

        CONSTRAINT comment_sync_runs_status_chk
          CHECK (status IN ('running','completed','failed'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_comment_sync_runs_workspace
        ON comment_sync_runs(workspace_id, started_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS comment_sync_runs`);
    await client.query(`DROP TABLE IF EXISTS youtube_comments`);
  },
};

export default migration;
