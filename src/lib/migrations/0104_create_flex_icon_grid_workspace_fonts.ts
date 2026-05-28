import type { Migration } from './types';

/**
 * Workspace-scoped custom font registry (Phase 4.8b). Lets a user
 * upload a TTF/OTF/WOFF once and pick it from a chip row in later
 * thumbnails rather than re-uploading the same file each time.
 *
 * Schema choices mirror the sibling Flex Icon Grid asset tables:
 *  - workspace_id NOT NULL with CASCADE on workspaces (post-0013
 *    tenancy contract).
 *  - r2_key stores the R2 object key, not the presigned download
 *    URL — URLs expire, keys don't. Routes mint fresh presigned URLs
 *    on demand.
 *  - mime_type + size_bytes captured at upload time so the panel
 *    can show "DejaVu Sans · TTF · 540 KB" without re-fetching.
 *  - UNIQUE(workspace_id, name) so the picker can prevent duplicate
 *    chip labels.
 *  - Index on (workspace_id, updated_at DESC) for the recency sort.
 */
const migration: Migration = {
  id: '0104_create_flex_icon_grid_workspace_fonts',
  description: 'Create flex_icon_grid_workspace_fonts — workspace-scoped registry of reusable label fonts for the Flex Icon Grid format',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS flex_icon_grid_workspace_fonts (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        r2_key        TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        size_bytes    BIGINT NOT NULL CHECK (size_bytes >= 0),
        created_by    UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_flex_icon_grid_workspace_fonts_workspace
        ON flex_icon_grid_workspace_fonts (workspace_id, updated_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS flex_icon_grid_workspace_fonts CASCADE`);
  },
};

export default migration;
