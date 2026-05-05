import type { Migration } from './types';

/**
 * Phase 9.7 — saved filter combinations for the catalog explorer.
 *
 * The catalog explorer at `/insights/catalog` lets users slice every
 * published video by channel / format / date / metric thresholds.
 * Power users want to bookmark specific slices ("Channel A long-form
 * videos with AVP < 35% from the last 90 days") rather than rebuild
 * the filter set every visit.
 *
 * Per-user, per-workspace. The `created_by_user_id` is informational
 * (so a teammate can see "saved by Alice") rather than enforcing
 * private views — a workspace-mate can read every saved view in
 * their workspace.
 *
 * Filters + sort are stored as opaque JSONB. The shape is owned by
 * the catalog-explorer lib; if we change it, we update the lib's
 * defensive parser to handle legacy shapes (rather than migrating).
 */
const migration: Migration = {
  id: '0047_create_saved_catalog_views',
  description: 'Phase 9.7 — saved catalog-explorer filter combinations',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_catalog_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_by_user_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,

        name TEXT NOT NULL,
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        sort JSONB NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // List by workspace, newest first.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_saved_catalog_views_workspace_time
        ON saved_catalog_views(workspace_id, updated_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS saved_catalog_views`);
  },
};

export default migration;
