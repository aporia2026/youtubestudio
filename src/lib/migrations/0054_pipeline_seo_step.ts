import type { Migration } from './types';

/**
 * Auto-pipeline SEO step (added 2026-05-12, after thumbnail / editor
 * landed in 0053).
 *
 * New stage `generating_seo` runs at the end of the flow — after the
 * editor assignment, before `done`. The pre-set SEO **template**
 * lives in the existing global `prompt_templates` table
 * (field_type='seo'), so this migration only needs to thread a
 * nullable FK from pipeline_presets to that table.
 *
 *   pipeline_presets.seo_template_id (UUID, nullable)
 *     references prompt_templates(id) ON DELETE SET NULL
 *
 * Null = no SEO step (pipeline transitions editor → done). When the
 * user wants the SEO step but no specific hard-rules template, they
 * can create an empty/minimal SEO template and link it.
 *
 * The stage name + failure stage live in TypeScript only (TEXT
 * column on pipeline_run_videos.stage, no enum to extend).
 *
 * No new artefact table — SEO output is persisted on the existing
 * `pipeline_stage_artefacts` row (stage='generating_seo',
 * artefact_kind='seo_output', metadata_jsonb=<result>). The video
 * card UI reads it from there.
 *
 * `prompt_templates` is **not** workspace-scoped (existing global
 * design choice — see src/lib/templates-db.ts). The pipeline_preset
 * IS workspace-scoped, so workspace isolation is preserved at the
 * preset level; cross-workspace template picking is permitted by
 * the same rule the rest of the app uses.
 */
const migration: Migration = {
  id: '0054_pipeline_seo_step',
  description: 'Auto-pipeline: seo_template_id FK on pipeline_presets for the new generating_seo stage',

  async up(client) {
    // The `prompt_templates` table is created lazily by
    // `ensureTemplatesSchema()` in templates-db.ts. To guarantee
    // it exists before we FK to it, replicate the CREATE here
    // (idempotent — IF NOT EXISTS).
    await client.query(`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        field_type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE pipeline_presets
        ADD COLUMN IF NOT EXISTS seo_template_id UUID
          REFERENCES prompt_templates(id) ON DELETE SET NULL
    `);
  },

  async down(client) {
    await client.query(`ALTER TABLE pipeline_presets DROP COLUMN IF EXISTS seo_template_id`);
  },
};

export default migration;
