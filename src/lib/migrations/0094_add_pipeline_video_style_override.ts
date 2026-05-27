import type { Migration } from './types';

/**
 * Plan: `_plans/2026-05-27-pipeline-edit-and-rerun-existing-runs.md`.
 *
 * Adds `script_style_preset_override_id` to `pipeline_run_videos` so a
 * user can pick a different script style for ONE video in a batch
 * without changing the batch's preset (or affecting any other video
 * in the same run).
 *
 * Effective-style resolution chain inside `handleGenerateScript`:
 *
 *   1. video.script_style_preset_override_id (per-video — new)
 *   2. preset.script_style_preset_id (per-preset, migration 0093)
 *   3. preset.production_doc_style_id (per-preset, migration 0052)
 *   4. null — no style preset injected
 *
 * ON DELETE SET NULL — deleting a style shouldn't break the video's
 * resolvable state; the chain just falls through to the next layer.
 * Matches the rule on the sibling columns (production_doc_style_id,
 * script_style_preset_id).
 */
const migration: Migration = {
  id: '0094_add_pipeline_video_style_override',
  description: 'pipeline_run_videos.script_style_preset_override_id for per-video script-style override',

  async up(client) {
    await client.query(`
      ALTER TABLE pipeline_run_videos
        ADD COLUMN IF NOT EXISTS script_style_preset_override_id UUID
        REFERENCES production_doc_styles(id) ON DELETE SET NULL
    `);
  },

  async down(client) {
    await client.query(`ALTER TABLE pipeline_run_videos DROP COLUMN IF EXISTS script_style_preset_override_id`);
  },
};

export default migration;
