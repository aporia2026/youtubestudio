import type { Migration } from './types';

/**
 * Shorts everywhere v1 — Phase 1 schema. See
 * `_plans/2026-06-02-shorts-everywhere-v1.md` §5 for the medium-primitive
 * rationale and §7 Phase 1 §1 for the column-by-column list.
 *
 * Adds a `medium` field on `shorts` so prompts/scorers/renderers can
 * dispatch by content medium instead of growing an `if (kind === ...)`
 * branch in every section. Also introduces `'channel_clip_recommendation'`
 * as a third `kind` value for Mode A (find-a-clip-from-channel-video)
 * rows that carry a YouTube source + timecodes instead of a script.
 *
 * Schema choices:
 *
 *   - `medium TEXT NOT NULL DEFAULT 'short_native'`. Three values:
 *     'long_form' (reserved — long-form artifacts never land in this
 *     table today, but the strategy dispatcher uses the same enum), and
 *     'short_clip' (Mode A recommendations attached to an existing
 *     YouTube video) and 'short_native' (Mode C — a fresh Short the app
 *     generated and can render). Backfill maps existing rows:
 *     `kind='extracted'` → 'short_native' (they have a script + can
 *     render); `kind='external_seo'` → 'short_native' as well, since
 *     they live on the user's own Shorts pipeline.
 *
 *   - `'channel_clip_recommendation'` added to `shorts_kind_check`.
 *     Constraint is dropped + re-added because Postgres has no
 *     `ALTER CONSTRAINT ... ADD VALUE` for CHECK. Re-creation is
 *     guarded by the same DO $$ ... IF NOT EXISTS pattern migration
 *     0108 used.
 *
 *   - `source_youtube_video_id TEXT`. The YouTube video this Short was
 *     clipped from. NOT a FK — YouTube's video id is a string we don't
 *     mirror in our tables. Indexed for the "list candidates for this
 *     channel video" query.
 *
 *   - `clip_start_ms INTEGER` / `clip_end_ms INTEGER`. Timecodes into the
 *     source video for the recommended Mode A moment. Nullable because
 *     `short_native` and `external_seo` rows have no source clip.
 *
 *   - `hook_score REAL`. 0–1 score from `hook-scoring.ts`. Surfaced in
 *     both the project detail page and the global Shorts inbox (ORDER BY
 *     hook_score DESC NULLS LAST). Nullable so back-filled scoring can
 *     be progressive.
 *
 *   - `dismissed_at TIMESTAMPTZ`. The global Shorts inbox's "sweep stale
 *     candidate" button sets this so the row is hidden from the inbox
 *     but NOT deleted (the user may want to recover or grade it later).
 *     Inbox queries filter `dismissed_at IS NULL`.
 *
 *   - `workspaces.shorts_settings JSONB`. Per-workspace shorts settings
 *     (auto-fan-out toggle, candidate count, hook threshold, etc.). One
 *     JSONB column matches the pattern of `workspaces.tts_settings`
 *     (migration 0089) per the explicit guidance in migration 0102's
 *     comment. Free-form shape lets Phase 2 add style picker defaults
 *     without another migration.
 *
 * Indexes:
 *
 *   - `(workspace_id, medium, created_at DESC) WHERE dismissed_at IS NULL`
 *     — backs the global Shorts inbox query (per-workspace, per-medium,
 *     newest-first, non-dismissed). Partial on `dismissed_at IS NULL`
 *     because the dismissed rows are cold storage.
 *
 *   - `(source_youtube_video_id) WHERE source_youtube_video_id IS NOT NULL`
 *     — backs "list candidates for this channel video" on the Mode A UI.
 *     Partial because most rows are short_native and have no source.
 *
 * Down migration is best-effort: it removes the new columns + the index,
 * restores the CHECK to the prior two-value form. It does NOT restore
 * the prior NOT NULL on short_script (matching 0108's posture) and does
 * NOT remove the workspaces.shorts_settings column if other migrations
 * have started reading it (harmless to leave behind on rollback).
 */
const migration: Migration = {
  id: '0109_shorts_medium_primitive',
  description: 'shorts.medium + channel_clip_recommendation kind + hook_score + dismissed_at + source_youtube_video_id + clip timecodes + workspaces.shorts_settings',

  async up(client) {
    // ── shorts table ────────────────────────────────────────────────────
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS medium TEXT NOT NULL DEFAULT 'short_native'`,
    );
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS source_youtube_video_id TEXT`,
    );
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS clip_start_ms INTEGER`,
    );
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS clip_end_ms INTEGER`,
    );
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS hook_score REAL`,
    );
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ`,
    );

    // Replace the kind CHECK constraint to include 'channel_clip_recommendation'.
    // Postgres can't add a value to an existing CHECK in place, so we
    // drop-and-recreate. The IF EXISTS makes it idempotent for re-runs.
    await client.query(
      `ALTER TABLE shorts DROP CONSTRAINT IF EXISTS shorts_kind_check`,
    );
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'shorts_kind_check'
        ) THEN
          ALTER TABLE shorts
            ADD CONSTRAINT shorts_kind_check
            CHECK (kind IN ('extracted', 'external_seo', 'channel_clip_recommendation'));
        END IF;
      END$$;
    `);

    // Add a medium CHECK constraint so the enum is enforced in the DB.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'shorts_medium_check'
        ) THEN
          ALTER TABLE shorts
            ADD CONSTRAINT shorts_medium_check
            CHECK (medium IN ('long_form', 'short_clip', 'short_native'));
        END IF;
      END$$;
    `);

    // Inbox index. Partial on dismissed_at IS NULL — dismissed rows are
    // cold and shouldn't bloat the hot read path.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_inbox
        ON shorts(workspace_id, medium, created_at DESC)
       WHERE dismissed_at IS NULL
    `);

    // Mode A "list candidates for this channel video" index.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_source_youtube_video
        ON shorts(source_youtube_video_id)
       WHERE source_youtube_video_id IS NOT NULL
    `);

    // ── workspaces table ────────────────────────────────────────────────
    await client.query(
      `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS shorts_settings JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_shorts_source_youtube_video`);
    await client.query(`DROP INDEX IF EXISTS idx_shorts_inbox`);
    await client.query(`ALTER TABLE shorts DROP CONSTRAINT IF EXISTS shorts_medium_check`);
    await client.query(`ALTER TABLE shorts DROP CONSTRAINT IF EXISTS shorts_kind_check`);
    // Restore the prior two-value CHECK so a rolled-back deploy sees
    // the same constraint it had under 0108.
    await client.query(`
      ALTER TABLE shorts
        ADD CONSTRAINT shorts_kind_check
        CHECK (kind IN ('extracted', 'external_seo'))
    `);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS dismissed_at`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS hook_score`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS clip_end_ms`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS clip_start_ms`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS source_youtube_video_id`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS medium`);
    // workspaces.shorts_settings deliberately NOT dropped on rollback —
    // mirrors the 0108 posture for short_script NOT NULL. Safer to leave
    // an unused JSONB column than to lose user settings.
  },
};

export default migration;
