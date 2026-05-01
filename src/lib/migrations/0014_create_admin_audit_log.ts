import type { Migration } from './types';

/**
 * Admin actions are recorded for auditability. Every mutation issued through
 * /api/admin/** writes one row here with the actor, the action key, the
 * target (user / workspace, optional), arbitrary JSON metadata for the
 * action's specifics, and the source IP.
 *
 * Append-only by design. There is no UI to delete rows.
 */
const migration: Migration = {
  id: '0014_create_admin_audit_log',
  description: 'Append-only log of admin actions for support / forensics',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id UUID NOT NULL REFERENCES collaborators(id),
        action TEXT NOT NULL,
        target_user_id UUID REFERENCES collaborators(id),
        target_workspace_id UUID REFERENCES workspaces(id),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip_address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_actor
        ON admin_audit_log (actor_user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_target_user
        ON admin_audit_log (target_user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_action
        ON admin_audit_log (action, created_at DESC)
    `);
  },
};

export default migration;
