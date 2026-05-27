import type { Migration } from './types';

/**
 * Plan: `_plans/2026-05-27-pipeline-edit-and-rerun-existing-runs.md`
 * (extended in the 2026-05-27 follow-up round).
 *
 * Adds `script_additional_context_override` to `pipeline_run_videos` so
 * a user can paste custom script-writing instructions for ONE video
 * (or one regen) without editing the run's preset. The script handler
 * reads this and substitutes it for the preset's
 * `script_rules_jsonb.additionalContext` when set.
 *
 * Effective additionalContext chain inside `handleGenerateScript`:
 *
 *   1. video.script_additional_context_override (per-video — new)
 *   2. preset.script_rules_jsonb.additionalContext (per-preset)
 *   3. undefined — no additionalContext block injected
 *
 * Text column (not JSONB) because the prompt template just splices the
 * value verbatim; no structure needed. NULL = no override; empty
 * string = "explicitly clear it" (rarely useful, but supported). The
 * column has no length cap because the prompt builder already truncates
 * upstream; storing the unbounded value lets us preserve the user's
 * full text without lossy round-trips.
 */
const migration: Migration = {
  id: '0095_add_pipeline_video_custom_instructions',
  description: 'pipeline_run_videos.script_additional_context_override for per-video custom script instructions',

  async up(client) {
    await client.query(`
      ALTER TABLE pipeline_run_videos
        ADD COLUMN IF NOT EXISTS script_additional_context_override TEXT
    `);
  },

  async down(client) {
    await client.query(`ALTER TABLE pipeline_run_videos DROP COLUMN IF EXISTS script_additional_context_override`);
  },
};

export default migration;
