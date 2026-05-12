import type { Migration } from './types';

/**
 * Phase 13.2.W follow-up — user-saved outlier search presets.
 *
 * Each row is one named filter combination scoped to a niche. The
 * operator builds a query in the Outlier finder tab, dials in the
 * filters they like, and clicks "Save current search" to persist it.
 * Saved presets surface as chips alongside the built-in presets so
 * the operator can return to a previous configuration in one click.
 *
 * Workspace-scoped: presets are shared across the workspace, the
 * same way niche reports and watchlist are. UNIQUE (workspace_id,
 * name) collisions return 409 from the POST route so the operator
 * can rename before retry.
 *
 * The 100-row workspace cap (enforced at write-time in the route)
 * keeps a runaway script from ballooning the table.
 */
const migration: Migration = {
  id: '0060_create_niche_search_presets',
  description: 'Phase 13.2 follow-up — saved outlier search presets per workspace',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_search_presets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

        -- Display name, trimmed and capped to 80 chars at write time.
        name TEXT NOT NULL,

        -- The niche query the operator was searching when they saved.
        niche_query TEXT NOT NULL,

        -- OutlierFilters as JSON. Parsed at apply time so adding a new
        -- filter dimension doesn't require a migration.
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ,

        UNIQUE (workspace_id, name)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_search_presets_workspace_time
        ON niche_search_presets(workspace_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS niche_search_presets`);
  },
};

export default migration;
