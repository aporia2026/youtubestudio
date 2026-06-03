import type { Migration } from './types';

/**
 * Plan: `_plans/2026-06-04-pipeline-preset-pacing-profile.md`.
 *
 * Adds `pacing_profile` to `pipeline_presets` so the auto-pipeline's
 * production-doc handler honours a preset-configured pace instead of
 * the hardcoded 'fast' it shipped with. The manual /api/generate/
 * production-doc route already exposes the same three values
 * ('standard' | 'fast' | 'very_fast') through the page's
 * PacingProfilePanel; this column extends the same pick to preset-
 * driven runs.
 *
 * Nullable on purpose: existing presets read as "no opinion" and the
 * handler falls back to 'fast', preserving byte-identical behavior for
 * every preset that doesn't pick. The CHECK constraint is the DB-
 * level defense in depth alongside the application-side
 * `parsePacingProfile` whitelist.
 */
const migration: Migration = {
  id: '0116_add_pipeline_preset_pacing_profile',
  description: 'pipeline_presets.pacing_profile (TEXT, nullable, check-constrained)',

  async up(client) {
    await client.query(`
      ALTER TABLE pipeline_presets
        ADD COLUMN IF NOT EXISTS pacing_profile TEXT
    `);
    // Drop-and-recreate so re-running the migration after a manual
    // edit doesn't trip on a duplicate constraint name. The IF EXISTS
    // form keeps the up-migration idempotent.
    await client.query(`
      ALTER TABLE pipeline_presets
        DROP CONSTRAINT IF EXISTS pipeline_presets_pacing_profile_check
    `);
    await client.query(`
      ALTER TABLE pipeline_presets
        ADD CONSTRAINT pipeline_presets_pacing_profile_check
        CHECK (pacing_profile IS NULL OR pacing_profile IN ('standard', 'fast', 'very_fast'))
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE pipeline_presets
        DROP CONSTRAINT IF EXISTS pipeline_presets_pacing_profile_check
    `);
    await client.query(`
      ALTER TABLE pipeline_presets DROP COLUMN IF EXISTS pacing_profile
    `);
  },
};

export default migration;
