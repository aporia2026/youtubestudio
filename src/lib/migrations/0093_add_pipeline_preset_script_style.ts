import type { Migration } from './types';

/**
 * Plan: `_plans/2026-05-27-pipeline-script-style-preset-and-gate-deadend-fix.md`.
 *
 * Adds `script_style_preset_id` to `pipeline_presets` so a preset can
 * point the script-generation stage at a `production_doc_styles` row
 * (built-in slug or workspace-saved style). The script handler reads
 * this and injects the style's label/description/mixing_rules into the
 * STYLE PRESET prompt block — exactly like the standalone Script
 * Generator at `/api/generate/script` does.
 *
 * Sibling to `production_doc_style_id` (added in migration 0052). The
 * stage handler falls back to `production_doc_style_id` when this
 * column is null, so existing presets keep the same script-gen
 * behavior they had pre-migration (no style injection) until the user
 * opts in via the preset form.
 *
 * ON DELETE SET NULL — deleting a style shouldn't break presets that
 * happened to reference it. Matches the production_doc_style_id rule.
 */
const migration: Migration = {
  id: '0093_add_pipeline_preset_script_style',
  description: 'pipeline_presets.script_style_preset_id for per-preset script-stage style',

  async up(client) {
    await client.query(`
      ALTER TABLE pipeline_presets
        ADD COLUMN IF NOT EXISTS script_style_preset_id UUID
        REFERENCES production_doc_styles(id) ON DELETE SET NULL
    `);
  },

  async down(client) {
    await client.query(`ALTER TABLE pipeline_presets DROP COLUMN IF EXISTS script_style_preset_id`);
  },
};

export default migration;
