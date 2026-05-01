import type { Migration } from './types';

/**
 * User-defined visual styles for the Production Doc generator.
 *
 * A "style" used to be a single hardcoded suffix string keyed by id
 * (cinematic, animation_2d, etc.) that was appended verbatim to every
 * AI image prompt. This table lets workspaces save their own styles —
 * each one richer than the legacy preset:
 *
 *   ai_image_suffix    — appended verbatim to every AI image prompt
 *                        (same role as the old hardcoded suffix)
 *   mixing_rules       — free-form instructions injected into the
 *                        system prompt that tell the model WHEN to mix
 *                        AI-generated visuals with real stock assets
 *                        (logos, screenshots, photos). Without this
 *                        slot the model defaults to "Animation only".
 *   allow_overlay_stock — when true, the model is allowed to populate
 *                        the per-row `overlay_stock_terms` field so the
 *                        editor can composite a real asset on top of
 *                        the AI-generated doodle in post.
 *
 * Built-in styles (cinematic, animation_2d, doodle_explainer, …) live
 * in src/lib/production-doc-styles.ts as constants — they're not
 * inserted into this table. This table is exclusively for user-saved
 * styles. A consumer that wants the full universe should call
 * `listStyles(workspaceId)` which merges the two lists.
 *
 * `name` is unique per workspace so a user can't end up with two
 * styles called "Doodle Pirate" and have the picker silently choose
 * the older one. Renaming is allowed — uniqueness is enforced at the
 * row level, not the historical level.
 */
const migration: Migration = {
  id: '0022_create_production_doc_styles',
  description: 'Workspace-scoped saved visual styles for Production Doc',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_doc_styles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

        name TEXT NOT NULL,
        description TEXT,

        ai_image_suffix TEXT NOT NULL,
        mixing_rules TEXT,
        allow_overlay_stock BOOLEAN NOT NULL DEFAULT FALSE,

        based_on_built_in TEXT,

        created_by UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT production_doc_styles_workspace_name_unique
          UNIQUE (workspace_id, name)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_production_doc_styles_workspace
        ON production_doc_styles(workspace_id, updated_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS production_doc_styles`);
  },
};

export default migration;
