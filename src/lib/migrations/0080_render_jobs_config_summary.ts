import type { Migration } from './types';

/**
 * Phase A of `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`.
 *
 * Add a `config_summary` column to `render_jobs` that captures a
 * REDACTED, summarised view of the final `VideoConfig` that hit
 * Remotion. The render-config-drop bug (rendered MP4 missing voiceover
 * audio, missing motion, or showing suppressed text) has multiple
 * plausible drop points across the pipeline; without persisted
 * diagnostics we cannot tell whether the bug is in the production-doc
 * page state, the `productionDocToVideoConfig` builder, the
 * `/api/render/video` server-side rewrites, or the Remotion scene
 * router.
 *
 * Stored as JSONB so we can query individual fields cheaply if the
 * bug recurs after the first fix. Nullable: legacy rows + Lambda
 * kickoff paths that didn't yet write it stay valid.
 *
 * Redaction: the summary deliberately omits secrets — voiceoverUrl
 * captures presence + origin host only (NOT presigned signatures or
 * full paths), and per-shot URLs are recorded as booleans (present
 * vs absent), not as the full URL string.
 */
const migration: Migration = {
  id: '0080_render_jobs_config_summary',
  description: 'Add `config_summary` JSONB column to render_jobs for render-bug diagnostics',

  async up(client) {
    await client.query(`
      ALTER TABLE render_jobs
        ADD COLUMN IF NOT EXISTS config_summary JSONB
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE render_jobs
        DROP COLUMN IF EXISTS config_summary
    `);
  },
};

export default migration;
