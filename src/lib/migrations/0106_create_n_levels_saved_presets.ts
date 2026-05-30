import type { Migration } from './types';

/**
 * Workspace-scoped saved style presets for the N Levels Explained
 * format (port-plan Phase 4d). Sibling to
 * `topic_card_grid_saved_presets` (migration 0105): same schema, same
 * preset payload shape (postProcess + titleBar), but stored separately
 * so each format has its own preset library.
 *
 * Why separate tables rather than one polymorphic table:
 *   - Per-format workspace caps stay separable (a workspace can hit the
 *     N Levels cap without affecting Topic Card Grid presets).
 *   - List + delete queries don't need a format filter every time.
 *   - Future format-specific fields can be added without polluting the
 *     other format's schema.
 *
 * Schema choices mirror topic_card_grid_saved_presets exactly — see
 * migration 0105 for the rationale.
 */
const migration: Migration = {
  id: '0106_create_n_levels_saved_presets',
  description: 'Create n_levels_saved_presets — workspace-scoped reusable style presets for the N Levels Explained format',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS n_levels_saved_presets (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        preset_jsonb  JSONB NOT NULL,
        created_by    UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_n_levels_saved_presets_workspace
        ON n_levels_saved_presets (workspace_id, updated_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS n_levels_saved_presets CASCADE`);
  },
};

export default migration;
