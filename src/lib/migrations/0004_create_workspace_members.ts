import type { Migration } from './types';

/**
 * Workspace membership. One row per (workspace, user, role) — a single user
 * can hold multiple roles in the same workspace (e.g. owner + reviewer when
 * the channel owner reviews their own videos).
 *
 * `role` values are workspace-scoped (not the same set as `collaborators.role`,
 * which is the legacy workflow role kept for back-compat):
 *   - owner   — the channel-owning YouTuber; full control
 *   - member  — full collaborator access (e.g. an in-house editor / VA)
 *   - editor  — limited to projects assigned via editor_assignments
 *   - narrator — limited to narrator_assignments
 *   - reviewer — limited to review_share_links
 *   - client  — read-only review access
 */
const migration: Migration = {
  id: '0004_create_workspace_members',
  description: 'Create workspace_members linking users to workspaces with a role',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, user_id, role)
      )
    `);

    await client.query(`
      ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check
    `);
    await client.query(`
      ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
        CHECK (role IN ('owner','member','editor','narrator','reviewer','client'))
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workspace_members_user
        ON workspace_members (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace
        ON workspace_members (workspace_id)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS workspace_members`);
  },
};

export default migration;
