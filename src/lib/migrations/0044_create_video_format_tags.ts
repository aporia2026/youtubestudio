import type { Migration } from './types';

/**
 * Phase 9.4 — auto-tagged format / topic per video.
 *
 * Every published video gets ONE primary format tag (explainer / list
 * / story / tutorial / commentary / interview / vlog / showcase) and
 * a small set of topic tags. The tags are derived once per video by
 * an AI call over title + description + script (when available) — we
 * don't recompute on stat changes because format doesn't change.
 *
 * One row per (workspace, youtube_video_id) — UPSERT path lets a
 * worker re-tag a video if the title is edited.
 *
 * The `format` is a small enum stored as TEXT (validated at
 * application level) so the dashboard can group on it cheaply with a
 * btree index. `topics` is an array of free-form lowercase tokens
 * (e.g. `[ai, agents, claude]`) — used for similarity, not strict
 * grouping.
 *
 * `tagged_at` lets us re-tag stale entries (>30d old) when the
 * tagger changes (model upgrade, prompt revision).
 */
const migration: Migration = {
  id: '0044_create_video_format_tags',
  description: 'Phase 9.4 — auto-tagged format + topic per video for attribution analytics',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_format_tags (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        youtube_video_id TEXT NOT NULL,
        channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,

        -- One of: explainer, list, story, tutorial, commentary,
        -- interview, vlog, showcase, other. Application-validated.
        format TEXT NOT NULL,

        -- Free-form lowercase tokens. ['ai', 'agents', 'claude'].
        topics TEXT[] NOT NULL DEFAULT '{}',

        -- Confidence 0..1 from the model — lets the panel filter out
        -- the model's "not sure" calls when aggregating.
        confidence NUMERIC(3,2) NOT NULL DEFAULT 0.5,

        ai_model TEXT NOT NULL,
        tagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (workspace_id, youtube_video_id)
      )
    `);

    // Per-format aggregation (the dashboard panel groups by format
    // and computes mean AVP / CTR per group).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_format_tags_workspace_format
        ON video_format_tags(workspace_id, format)
    `);
    // Per-channel aggregation for the channel-level slice.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_format_tags_channel_format
        ON video_format_tags(workspace_id, channel_id, format)
        WHERE channel_id IS NOT NULL
    `);
    // Restamping: find videos tagged before a given threshold.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_format_tags_workspace_tagged
        ON video_format_tags(workspace_id, tagged_at)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS video_format_tags`);
  },
};

export default migration;
