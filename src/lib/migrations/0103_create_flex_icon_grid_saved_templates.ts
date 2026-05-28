import type { Migration } from './types';

/**
 * Workspace-scoped saved starting templates for the Flex Icon Grid
 * thumbnail format (Phase 4.7c). Companion to the
 * `flex_icon_grid_saved_palettes` table (migration 0099): instead of
 * just colour lists, a template stores the whole config (grid size,
 * default cell shape, ring style, label style, title bar settings,
 * etc.) — but NOT the per-cell content. Loading a template hydrates
 * a fresh thumbnail with the user's preferred layout and styling
 * defaults so they can start from "their look" rather than the
 * package default.
 *
 * Per-cell content (labels, icon names, uploaded images, sticker
 * prompts) is intentionally excluded from the saved template — those
 * are video-specific and would clutter the picker. Users who want to
 * save a complete thumbnail-as-template can use the existing history
 * entry which round-trips the full config.
 *
 * Schema choices mirror `flex_icon_grid_saved_palettes`:
 *   - workspace_id NOT NULL with CASCADE on workspaces.
 *   - config_jsonb stores the trimmed config blob (without cells).
 *   - UNIQUE(workspace_id, name) so the picker can prevent dupes.
 *   - Index on (workspace_id, updated_at DESC) for recency sort.
 */
const migration: Migration = {
  id: '0103_create_flex_icon_grid_saved_templates',
  description: 'Create flex_icon_grid_saved_templates — workspace-scoped reusable starting templates for the Flex Icon Grid format',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS flex_icon_grid_saved_templates (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        config_jsonb  JSONB NOT NULL,
        created_by    UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_flex_icon_grid_saved_templates_workspace
        ON flex_icon_grid_saved_templates (workspace_id, updated_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS flex_icon_grid_saved_templates CASCADE`);
  },
};

export default migration;
