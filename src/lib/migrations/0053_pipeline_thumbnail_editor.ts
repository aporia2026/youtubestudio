import type { Migration } from './types';

/**
 * Auto-pipeline extensions (added 2026-05-12):
 *
 *  - Thumbnail step between production-doc and editor assignment.
 *    New stage names persisted as TEXT in pipeline_run_videos.stage
 *    (no enum, no migration to extend). What this migration adds:
 *      * `thumbnail_url TEXT` on pipeline_run_videos for the
 *        generated image URL.
 *      * `editor_assignment_id UUID` FK on pipeline_run_videos so
 *        the auto-assign step can link back to the row created in
 *        editor_assignments.
 *  - Auto-assign to a pre-configured video editor after the
 *    thumbnail completes. Wires from a new
 *    `video_editor_collaborator_id` on pipeline_presets.
 *  - New `thumbnail_template_presets` table backs the user's
 *    "save reusable thumbnail templates" side feature. Each
 *    template carries reference images, free-text context, and
 *    an include_text toggle. Linked from pipeline_presets via
 *    `thumbnail_template_id`.
 *
 * Schema-only — no handler code lands in this migration. The
 * thumbnail + editor stage handlers are stubs in v1 (advance the
 * stage so the state machine completes); real implementations come
 * in a follow-up push when the user is ready to design the
 * thumbnail-template CRUD UI.
 *
 * Tenancy: thumbnail_template_presets has its own workspace_id with
 * CASCADE; pipeline_presets.thumbnail_template_id is SET NULL on
 * template deletion so a deleted template doesn't orphan the
 * pipeline_preset row.
 *
 * editor_assignments is the existing table from Phase 11 (lives in
 * editor-db.ts under a not-yet-numbered ensure-schema; the table
 * has been in production since 11.1). The FK reference here adopts
 * ON DELETE SET NULL so a deleted assignment doesn't cascade-wipe
 * the pipeline row (the pipeline row's audit value persists).
 */
const migration: Migration = {
  id: '0053_pipeline_thumbnail_editor',
  description: 'Auto-pipeline: thumbnail step + auto-editor-assignment + thumbnail_template_presets table',

  async up(client) {
    // ─── thumbnail_template_presets (side feature) ───────────────────
    //
    // Reusable thumbnail configurations. The CRUD surface + the
    // pipeline thumbnail handler that consumes these will land in a
    // follow-up push; this migration creates the table so the
    // pipeline_presets FK can reference it from the same migration
    // (cleaner than two migrations that have to land in order).
    await client.query(`
      CREATE TABLE IF NOT EXISTS thumbnail_template_presets (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name                        TEXT NOT NULL,
        image_references_jsonb      JSONB,
        context_description         TEXT,
        include_text                BOOLEAN NOT NULL DEFAULT false,
        text_overlay_config_jsonb   JSONB,
        created_by                  UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (workspace_id, name)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_thumbnail_template_presets_workspace
        ON thumbnail_template_presets (workspace_id, updated_at DESC)
    `);

    // ─── pipeline_presets additions ─────────────────────────────────
    //
    // video_editor_collaborator_id is nullable → null means "don't
    // auto-assign; terminate at 'done' after thumbnail." Lets a user
    // opt out of the editor step on a per-preset basis without
    // needing a separate boolean flag.
    //
    // thumbnail_template_id is nullable → null means "use the
    // workspace-default thumbnail configuration" (TBD; in v1 the
    // handler stubs to a sensible default).
    await client.query(`
      ALTER TABLE pipeline_presets
        ADD COLUMN IF NOT EXISTS video_editor_collaborator_id UUID
          REFERENCES collaborators(id) ON DELETE SET NULL
    `);
    await client.query(`
      ALTER TABLE pipeline_presets
        ADD COLUMN IF NOT EXISTS thumbnail_template_id UUID
          REFERENCES thumbnail_template_presets(id) ON DELETE SET NULL
    `);

    // ─── pipeline_run_videos additions ──────────────────────────────
    //
    // thumbnail_url is a plain TEXT — generated thumbnails are
    // hosted at a URL (Kie.ai returns one); there is no separate
    // thumbnails table to FK against today. If we move to a
    // formal thumbnails registry later, a follow-up migration can
    // promote this to a FK without changing the application's
    // read shape.
    //
    // editor_assignment_id FKs to the existing editor_assignments
    // table (Phase 11). ON DELETE SET NULL so a deleted
    // assignment doesn't cascade-wipe the pipeline row.
    await client.query(`
      ALTER TABLE pipeline_run_videos
        ADD COLUMN IF NOT EXISTS thumbnail_url TEXT
    `);
    await client.query(`
      ALTER TABLE pipeline_run_videos
        ADD COLUMN IF NOT EXISTS editor_assignment_id UUID
          REFERENCES editor_assignments(id) ON DELETE SET NULL
    `);
  },

  async down(client) {
    // Reverse order of `up`: pipeline_run_videos columns first
    // (they don't FK to anything we're dropping), then
    // pipeline_presets columns (one of them FKs to the
    // thumbnail_template_presets table), then the table itself.
    await client.query(`ALTER TABLE pipeline_run_videos DROP COLUMN IF EXISTS editor_assignment_id`);
    await client.query(`ALTER TABLE pipeline_run_videos DROP COLUMN IF EXISTS thumbnail_url`);
    await client.query(`ALTER TABLE pipeline_presets DROP COLUMN IF EXISTS thumbnail_template_id`);
    await client.query(`ALTER TABLE pipeline_presets DROP COLUMN IF EXISTS video_editor_collaborator_id`);
    await client.query(`DROP TABLE IF EXISTS thumbnail_template_presets`);
  },
};

export default migration;
