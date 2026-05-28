import type { Migration } from './types';

/**
 * Workspace-scoped saved palettes for the Flex Icon Grid thumbnail
 * format (Phase 4 start). Lets a user save the current grid's custom
 * palette under a name and reuse it on later thumbnails — same
 * pattern as `thumbnail_template_presets` (migration 0053).
 *
 * Schema choices:
 *  - workspace_id NOT NULL with CASCADE on workspaces (matches the
 *    post-0013 tenancy contract).
 *  - colors_jsonb stores an ordered array of hex strings. The
 *    adjacency engine in `flex-icon-grid-palettes.ts` consumes the
 *    array verbatim — no further shape assumed.
 *  - UNIQUE(workspace_id, name) so the editor surface can prevent
 *    "Rainbow" from being saved twice in one workspace.
 *  - Index on (workspace_id, updated_at DESC) so the picker's
 *    "recently used" sort stays fast at scale.
 */
const migration: Migration = {
  id: '0099_create_flex_icon_grid_saved_palettes',
  description: 'Create flex_icon_grid_saved_palettes — workspace-scoped reusable palettes for the Flex Icon Grid format',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS flex_icon_grid_saved_palettes (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        colors_jsonb  JSONB NOT NULL,
        created_by    UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_flex_icon_grid_saved_palettes_workspace
        ON flex_icon_grid_saved_palettes (workspace_id, updated_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS flex_icon_grid_saved_palettes CASCADE`);
  },
};

export default migration;
