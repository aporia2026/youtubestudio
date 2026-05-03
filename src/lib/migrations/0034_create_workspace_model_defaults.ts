import type { Migration } from './types';

/**
 * Per-workspace AI model defaults with three scope tiers.
 *
 * Resolution order (highest precedence first):
 *   1. feature-specific:   scope = 'feature:<feature-id>'
 *   2. section-wide:       scope = 'section:create' | 'section:grow' | …
 *   3. workspace-wide:     scope = 'workspace'
 *   4. feature's hardcoded fallback (in src/lib/ai-models.ts)
 *
 * Each scope is a single row keyed by (workspace_id, scope). Removing a
 * row makes the resolver fall through to the next tier — that's how the
 * UI implements "revert to inherit" without nulls.
 *
 * Stored as TEXT (not enums) for both `scope` and `model_id` so adding
 * new sections, features, or models doesn't require a migration.
 */
const migration: Migration = {
  id: '0034_create_workspace_model_defaults',
  description: 'Per-workspace AI model defaults — workspace/section/feature scopes',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_model_defaults (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        model_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, scope)
      )
    `);

    /**
     * Lookup is always "give me every default for this workspace" — the
     * resolver loads them into a Map once per request. PK already covers
     * (workspace_id, scope) so no extra index is needed.
     */
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS workspace_model_defaults`);
  },
};

export default migration;
