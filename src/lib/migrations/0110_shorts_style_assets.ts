import type { Migration } from './types';

/**
 * Shorts everywhere v1 — Phase 15.3 schema.
 *
 * Adds `style_id` + `style_assets` to the `shorts` table so the user's
 * style picker choice (`minimal_gradient_v1` | `doodle_explainer_2_short`
 * | `paint_explainer_v1_short`) survives across page loads and the
 * generated Doodle frame URLs (1 base + N variants) have a home.
 *
 * Schema choices:
 *
 *   - `style_id TEXT` NULLABLE (no DEFAULT). NULL means "user hasn't
 *     picked yet" — UI prompts for a pick on render. We don't default
 *     to 'minimal_gradient_v1' at the DB layer because that hides the
 *     decision; a NULL is honest about "user chose nothing yet" and
 *     lets the UI show the picker on the first render attempt.
 *
 *   - `style_assets JSONB NOT NULL DEFAULT '{}'`. Free-form shape per
 *     style. For doodle_explainer_2_short the shape is:
 *       { doodle_frames: [{ url: string, scene_index: number,
 *                            caption_chunk_start_index: number }] }
 *     For minimal_gradient_v1 the column stays '{}' — no assets needed.
 *     For paint_explainer_v1_short (Phase 15.4) it'll add mouth-removed
 *     URL + per-beat prop URLs.
 *     Free-form means each style owns its asset contract without
 *     bringing other style fields into its parser.
 *
 *   - No CHECK on `style_id` enum at the DB level. The TS enum in
 *     `short-styles.ts` is the source of truth; widening the registry
 *     (Phase 15.3 -> 15.4) is a code change, not a migration. A DB
 *     CHECK would force a migration round-trip for every new style.
 *
 *   - No index on `style_id` — read patterns query by `(workspace_id,
 *     medium)` and surface style as a row property, not as a filter.
 *
 * Down migration drops both columns. Safe because the schema is
 * additive — pre-0110 callers don't reference these columns.
 */
const migration: Migration = {
  id: '0110_shorts_style_assets',
  description: 'shorts.style_id + shorts.style_assets JSONB for the Phase 15.3 style picker + Doodle asset cache',

  async up(client) {
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS style_id TEXT`,
    );
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS style_assets JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
  },

  async down(client) {
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS style_assets`);
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS style_id`);
  },
};

export default migration;
