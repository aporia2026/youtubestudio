import type { Migration } from './types';

/**
 * Schema-drift heal: restore `workspace_members.workspace_id` after the
 * live-site CASCADE described in 0036b's header.
 *
 * Background:
 *   - 0004 created `workspace_members (workspace_id, user_id, role,
 *     joined_at)` with the PK `(workspace_id, user_id, role)`.
 *   - During the live-site interlude (see 0036b's preamble), the
 *     auto-heal that fired on NOT NULL failures ran
 *     `ALTER TABLE ... DROP COLUMN workspace_id CASCADE` across many
 *     public-schema tables. `workspace_members` is intentionally NOT in
 *     `_workspace_scoped_tables.ts` (it links to a workspace via PK,
 *     not via a tenant column), so 0036b never re-added the column
 *     here. 0061's reheal also skipped it for the same reason.
 *   - Symptom: every authenticated request that goes through
 *     `findPrimaryWorkspaceForUser` (login, /api/auth/me, every
 *     workspace-scoped page) throws when it dereferences the missing
 *     column. The login route has no try/catch around it, so the user
 *     sees a generic "Sign in failed. Try again." with the password
 *     check having already succeeded.
 *
 * What this migration does:
 *   1. If the column already exists, no-op (idempotent — healthy DBs
 *      installed before the drift are untouched).
 *   2. Add the column nullable + the FK to `workspaces(id)`.
 *   3. Backfill — three cases:
 *        a. No rows in workspace_members → trivially nothing to do.
 *        b. Exactly ONE workspace exists in `workspaces` → assign
 *           every row to that workspace. Unambiguous.
 *        c. Multiple workspaces → refuse to guess. THROW with a clear
 *           message; an operator must reconcile by hand (the
 *           workspace_id was destructively lost in the CASCADE; there
 *           is no other source of truth).
 *   4. Enforce NOT NULL.
 *   5. Re-create the original PK `(workspace_id, user_id, role)`.
 *
 * The down migration drops the column. Same rationale as 0036b — once
 * the schema is healed, you don't roll back to broken.
 */
const migration: Migration = {
  id: '0068_restore_workspace_members_workspace_id',
  description: 'Restore workspace_members.workspace_id dropped by the live-site CASCADE',

  async up(client) {
    // -- Step 1: short-circuit if already restored -------------------------
    const { rows: colCheck } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'workspace_members'
            AND column_name = 'workspace_id'
       ) AS exists`,
    );
    if (colCheck[0]?.exists) return;

    // -- Step 2: add the column + FK --------------------------------------
    // The FK matches 0004's original `REFERENCES workspaces(id) ON DELETE
    // CASCADE` so the constraint shape is identical to a freshly migrated DB.
    await client.query(`
      ALTER TABLE workspace_members
        ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE
    `);

    // -- Step 3: backfill --------------------------------------------------
    const { rows: countRows } = await client.query<{
      member_count: string;
      ws_count: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id IS NULL)::text AS member_count,
        (SELECT COUNT(*) FROM workspaces)::text AS ws_count
    `);
    const memberCount = Number(countRows[0]?.member_count ?? '0');
    const wsCount = Number(countRows[0]?.ws_count ?? '0');

    if (memberCount > 0) {
      if (wsCount === 0) {
        // No workspaces but membership rows exist — the rows are
        // orphans from a dropped CASCADE. Safe to delete; no real data
        // is lost because the workspace they pointed at is gone.
        await client.query(
          `DELETE FROM workspace_members WHERE workspace_id IS NULL`,
        );
      } else if (wsCount === 1) {
        await client.query(`
          UPDATE workspace_members
             SET workspace_id = (SELECT id FROM workspaces LIMIT 1)
           WHERE workspace_id IS NULL
        `);
      } else {
        // Multi-workspace DB with lost membership mappings. We refuse
        // to guess — the operator must figure out which user belonged
        // to which workspace (look at audit log, application history,
        // or other side-channel evidence) and run the appropriate
        // UPDATEs by hand before re-running this migration.
        throw new Error(
          `workspace_members has ${memberCount} row(s) with NULL workspace_id ` +
          `and there are ${wsCount} workspace(s) — cannot disambiguate. ` +
          `Reconcile manually (UPDATE workspace_members SET workspace_id = '<uuid>' ` +
          `WHERE user_id = '<uuid>'), then re-run \`npm run db:migrate\`.`,
        );
      }
    }

    // -- Step 4: enforce NOT NULL -----------------------------------------
    await client.query(`
      ALTER TABLE workspace_members
        ALTER COLUMN workspace_id SET NOT NULL
    `);

    // -- Step 5: re-create the original PK --------------------------------
    // 0004's PK was (workspace_id, user_id, role); the CASCADE dropped it
    // along with the column. DROP IF EXISTS guards the rare case where
    // an operator added a different PK by hand during the broken window.
    await client.query(
      `ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_pkey`,
    );
    await client.query(`
      ALTER TABLE workspace_members
        ADD PRIMARY KEY (workspace_id, user_id, role)
    `);
  },

  async down(client) {
    await client.query(
      `ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_pkey`,
    );
    await client.query(
      `ALTER TABLE workspace_members DROP COLUMN IF EXISTS workspace_id`,
    );
  },
};

export default migration;
