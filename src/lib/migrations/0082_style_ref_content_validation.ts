import type { Migration } from './types';

/**
 * Post-upload content-validation columns on `style_reference_images`.
 *
 * Background (QA finding I12): the ref-upload endpoint validates the
 * client-DECLARED `contentType` at presign time, but R2 presigned PUTs
 * only enforce what the client puts on the wire — a malicious client
 * can declare `image/jpeg`, get the presigned URL, then PUT arbitrary
 * bytes (HTML, SVG, executable, anything). The bytes then flow to
 * Kie / ComfyUI as part of every subsequent generation.
 *
 * Mitigation: after the client confirms the PUT completed, fire a
 * server-side range-GET on the first ~16 bytes and magic-byte check
 * against the declared MIME type. Mismatch → mark the row invalid
 * via these columns + the dispatcher excludes it from generations
 * (same gate as `rejected_by_provider`).
 *
 * Columns:
 *
 *   - `content_validated`: NULL until validation runs; TRUE on
 *     magic-byte match; FALSE on mismatch / fetch failure. The
 *     dispatcher treats `content_validated = TRUE` as the only
 *     usable state; NULL is "not yet checked" (recently uploaded,
 *     validator may still be in flight) and FALSE is "actively
 *     rejected by sniff."
 *
 *   - `content_validation_error`: human-readable mismatch reason
 *     when `content_validated = FALSE`. E.g. `declared image/jpeg
 *     but bytes start with <html (text/html)`. Surfaced in the UI
 *     so users know why a ref didn't take.
 *
 *   - `content_validated_at`: timestamp of the last validation
 *     attempt. Helps the UI distinguish "never checked" from
 *     "checked and failed" without inferring from NULL.
 *
 * No backfill needed — existing rows stay `content_validated = NULL`
 * (treated as "needs check"). A separate one-shot script can sweep
 * them later if we want strict post-hoc validation.
 */
const migration: Migration = {
  id: '0082_style_ref_content_validation',
  description: 'Post-upload MIME sniff state on style_reference_images',

  async up(client) {
    await client.query(`
      ALTER TABLE style_reference_images
        ADD COLUMN IF NOT EXISTS content_validated BOOLEAN,
        ADD COLUMN IF NOT EXISTS content_validation_error TEXT,
        ADD COLUMN IF NOT EXISTS content_validated_at TIMESTAMPTZ
    `);
    // Partial index on the "not yet validated" subset — most refs
    // get validated within seconds of upload, so this set is small
    // and the index makes the "find pending validations" sweep
    // cheap when we add it.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_style_reference_images_pending_validation
        ON style_reference_images(created_at)
        WHERE content_validated IS NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_style_reference_images_pending_validation`);
    await client.query(`
      ALTER TABLE style_reference_images
        DROP COLUMN IF EXISTS content_validated_at,
        DROP COLUMN IF EXISTS content_validation_error,
        DROP COLUMN IF EXISTS content_validated
    `);
  },
};

export default migration;
