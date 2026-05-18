import type { Migration } from './types';

/**
 * Deep YouTube video analyzer cache (Phase 1 of
 * `_plans/2026-05-18-youtube-deep-analyzer.md`).
 *
 * Stores one row per analyzed YouTube video per workspace. The
 * `(workspace_id, video_id, analyzer_version, prompt_version)` UNIQUE
 * constraint gives us cache-forever-by-version automatically: bump
 * `analyzer_version` or `prompt_version` when the prompt or schema
 * changes and the old rows become orphans (not auto-evicted; the
 * /analyze page reads only rows that match the current version pair).
 *
 * No `blob_url` column — Gemini ingests the YouTube URL natively via
 * `fileData: { fileUri, mimeType: 'video/*' }` (see `analyzeYouTubeVideo`
 * in src/lib/ai.ts). No video download step.
 *
 * Stage values:
 *   - `analyzing` — POST handler is currently running Gemini on this row
 *   - `done`      — `result_jsonb` is populated and structurally valid
 *   - `failed`    — `failure_reason` carries the message
 *
 * No mid-flight reclaim logic (no cron orchestrator yet): if a request
 * dies mid-analyze, the row stays at `analyzing` until the operator
 * forces a re-run, which DELETEs the stuck row first (see POST route's
 * `force` flag).
 */
const migration: Migration = {
  id: '0074_create_youtube_analyses',
  description: 'Deep YouTube video analyzer result cache (workspace-scoped, keyed by videoId + version pair)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS youtube_analyses (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        requested_by     TEXT NOT NULL,
        video_id         TEXT NOT NULL,
        video_url        TEXT NOT NULL,
        video_title      TEXT,
        channel_title    TEXT,
        model_id         TEXT NOT NULL,
        analyzer_version TEXT NOT NULL DEFAULT 'v1',
        prompt_version   TEXT NOT NULL,
        stage            TEXT NOT NULL,
        failure_reason   TEXT,
        result_jsonb     JSONB,
        cost_usd         NUMERIC(10, 4) NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at     TIMESTAMPTZ,
        CONSTRAINT youtube_analyses_workspace_video_version_unique
          UNIQUE (workspace_id, video_id, analyzer_version, prompt_version)
      )
    `);

    // Supports the recent-analyses list on /analyze and the niche-finder
    // deep-link case (workspace-scoped reverse-chrono).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_analyses_workspace_created
        ON youtube_analyses (workspace_id, created_at DESC)
    `);

    // Supports the cache-hit lookup before each new POST and the
    // niche-finder "has this been analyzed already" badge.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_analyses_workspace_video
        ON youtube_analyses (workspace_id, video_id)
    `);

    // Supports the daily-cap count query in the POST handler.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_analyses_workspace_user_recent
        ON youtube_analyses (workspace_id, requested_by, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS youtube_analyses`);
  },
};

export default migration;
