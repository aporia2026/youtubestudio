import type { Migration } from './types';

/**
 * Adds `production_doc_style_override_id` to `pipeline_run_videos` so
 * a user can pick a different visual style for ONE video without
 * editing the run's preset. Mirrors `script_style_preset_override_id`
 * (migration 0094) — but applies to the production-doc handler
 * instead of the script-generation handler.
 *
 * Effective visual-style chain inside `handleGenerateProductionDoc`:
 *
 *   1. video.production_doc_style_override_id  (per-video — new)
 *   2. preset.production_doc_style_id          (per-preset — mig 0052)
 *   3. null                                     (no style preset)
 *
 * ON DELETE SET NULL — deleting a style shouldn't break the video's
 * resolvable state. Sibling to `script_style_preset_override_id`.
 */
const migration: Migration = {
  id: '0096_add_pipeline_video_visual_style_override',
  description: 'pipeline_run_videos.production_doc_style_override_id for per-video visual-style override',

  async up(client) {
    await client.query(`
      ALTER TABLE pipeline_run_videos
        ADD COLUMN IF NOT EXISTS production_doc_style_override_id UUID
        REFERENCES production_doc_styles(id) ON DELETE SET NULL
    `);
  },

  async down(client) {
    await client.query(`ALTER TABLE pipeline_run_videos DROP COLUMN IF EXISTS production_doc_style_override_id`);
  },
};

export default migration;
