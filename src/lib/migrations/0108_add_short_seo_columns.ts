import type { Migration } from './types';

/**
 * Shorts SEO Optimizer — see `_plans/2026-06-01-shorts-seo-optimizer.md`.
 *
 * Extends the existing `shorts` table to also hold "external" Shorts the
 * user already made elsewhere and wants SEO help on, alongside the
 * extracted Shorts the table was built for.
 *
 * - `kind` discriminates the two row types. 'extracted' is the legacy
 *   extractor output (has a `short_script`, can be voiced + rendered).
 *   'external_seo' is a Short the user entered by hand for SEO
 *   optimization (no script — just title/description/length + the AI's
 *   graded title/description/hashtag options in `seo_result`).
 * - `short_script` drops its NOT NULL because external_seo rows have no
 *   script. Extracted rows still always write it at the application
 *   layer, so the contract is unchanged for them.
 * - The source long-form video link reuses the existing `project_id`
 *   FK (already ON DELETE CASCADE to projects); `source_script_id`
 *   stays NULL for external rows.
 */
const migration: Migration = {
  id: '0108_add_short_seo_columns',
  description: 'Extend shorts for externally-made Shorts + graded SEO optimization output',

  async up(client) {
    await client.query(`ALTER TABLE shorts ALTER COLUMN short_script DROP NOT NULL`);

    await client.query(`
      ALTER TABLE shorts
        ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'extracted'
    `);
    // Constraint added separately + guarded: ADD COLUMN ... CHECK can't be
    // re-run idempotently, and a named constraint lets the down() drop it.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'shorts_kind_check'
        ) THEN
          ALTER TABLE shorts
            ADD CONSTRAINT shorts_kind_check
            CHECK (kind IN ('extracted', 'external_seo'));
        END IF;
      END$$;
    `);

    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS source_title TEXT`);
    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS source_description TEXT`);
    await client.query(`ALTER TABLE shorts ADD COLUMN IF NOT EXISTS seo_result JSONB`);
  },

  async down(client) {
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS seo_result`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS source_description`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS source_title`);
    await client.query(`ALTER TABLE shorts DROP CONSTRAINT IF EXISTS shorts_kind_check`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS kind`);
    // Note: short_script's NOT NULL is intentionally NOT restored — doing
    // so would fail if any external_seo rows remain. The application layer
    // still always writes short_script for extracted rows.
  },
};

export default migration;
