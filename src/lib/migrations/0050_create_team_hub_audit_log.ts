import type { Migration } from './types';

/**
 * Phase 12 — Team Hub: audit log for "Act as <collaborator>" actions.
 *
 * The /team-hub cockpit lets the workspace owner write a narrator/editor/
 * reviewer's comment, take resolution, or version approval *as* that
 * collaborator. Every escalated action writes one row here so the trail
 * is honest about who actually pressed the button. The user-decided rule
 * is "always audit" — both successful and failed attempts are logged so
 * intent is captured even when the underlying mutation never committed.
 *
 * Reference shape mirrors `admin_audit_log` (migration 0014) but is
 * scoped per-workspace (the audit lives inside the same tenancy boundary
 * as the action) and carries a result + error_message pair.
 *
 * Companion change: a `posted_by_owner` flag on the three comment tables
 * the escalation can write into. The flag lets the rendering layer surface
 * a small "posted by owner on behalf of <name>" hint without joining the
 * audit log on every render.
 *
 * FK behaviour:
 *   - workspace_id ON DELETE CASCADE — audit dies with its workspace.
 *   - actor_user_id NOT NULL with default NO ACTION — the owner is the
 *     workspace owner and won't be deleted in normal operation; if they
 *     are, that's a serious enough event to require manual cleanup.
 *   - target_collaborator_id nullable with ON DELETE SET NULL — narrators/
 *     editors/clients are routinely deleted (revokeAllAccess cleans up
 *     their share links and assignments). The audit trail must survive
 *     that deletion as orphan rows so the historical record is preserved.
 */
const migration: Migration = {
  id: '0050_create_team_hub_audit_log',
  description: 'Phase 12 — team hub: append-only audit log for "Act as <collaborator>" + posted_by_owner flag on comment tables',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_hub_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        actor_user_id UUID NOT NULL REFERENCES collaborators(id),
        target_collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        action_type TEXT NOT NULL,
        surface TEXT NOT NULL,
        target_id UUID,
        result TEXT NOT NULL CHECK (result IN ('success','failure')),
        error_message TEXT,
        performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Per-workspace audit feed — used by the (future) admin view of all
    // act-as actions in a workspace. DESC ordering matches the typical
    // "newest first" read pattern.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_team_hub_audit_workspace_time
        ON team_hub_audit_log (workspace_id, performed_at DESC)
    `);

    // Per-collaborator activity feed — used by the Activity tab on the
    // command center. Orphan rows (target_collaborator_id IS NULL after
    // a delete) drop out of the index naturally.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_team_hub_audit_target_time
        ON team_hub_audit_log (target_collaborator_id, performed_at DESC)
        WHERE target_collaborator_id IS NOT NULL
    `);

    // posted_by_owner flag on each comment table the escalation can write
    // into. Default false so existing rows are unambiguous (every comment
    // ever posted before this migration was posted by the named author).
    // Idempotent ALTERs so reruns are safe.
    await client.query(`
      ALTER TABLE narration_take_comments
        ADD COLUMN IF NOT EXISTS posted_by_owner BOOLEAN NOT NULL DEFAULT false
    `);
    await client.query(`
      ALTER TABLE review_comments
        ADD COLUMN IF NOT EXISTS posted_by_owner BOOLEAN NOT NULL DEFAULT false
    `);
    await client.query(`
      ALTER TABLE narrator_comments
        ADD COLUMN IF NOT EXISTS posted_by_owner BOOLEAN NOT NULL DEFAULT false
    `);
  },

  async down(client) {
    // Reverse order of `up`: drop the column first (cheap), then the table.
    await client.query(`ALTER TABLE narrator_comments DROP COLUMN IF EXISTS posted_by_owner`);
    await client.query(`ALTER TABLE review_comments DROP COLUMN IF EXISTS posted_by_owner`);
    await client.query(`ALTER TABLE narration_take_comments DROP COLUMN IF EXISTS posted_by_owner`);
    await client.query(`DROP TABLE IF EXISTS team_hub_audit_log`);
  },
};

export default migration;
