import type { Migration, MigrationClient } from './types';
import {
  ALL_TENANT_TABLES,
  ROOT_TENANT_TABLES,
  CHILD_TENANT_TABLES,
} from './_workspace_scoped_tables';

/**
 * Schema-drift heal: re-add the `workspace_id` column on every tenant-scoped
 * table after the live-site interlude dropped them.
 *
 * Background:
 *   - Phase-1 migrations 0011/0012/0013 added the column, backfilled it, and
 *     enforced NOT NULL. All three are recorded as applied in schema_migrations.
 *   - For a few weeks of live-site deployment, the app was single-user and
 *     unaware of workspace_id. INSERTs failing on the NOT NULL constraint
 *     led to a self-heal that ran `ALTER TABLE ... DROP COLUMN workspace_id
 *     CASCADE` against every public-schema table that had the column.
 *   - schema_migrations still says 0011-0013 are applied, but the physical
 *     schema disagrees. On a flip back to phase-1-foundation the runner
 *     would skip those migrations, leaving the app dereferencing a column
 *     that doesn't exist.
 *
 * What this migration does:
 *   1. Re-adds the column (idempotent — `ADD COLUMN IF NOT EXISTS`).
 *   2. Backfills NULL rows the same way 0012 did: root tables → bootstrap
 *      workspace, children → parent's workspace_id, then a final sweep for
 *      orphans.
 *   3. Re-enforces NOT NULL and re-creates the listing index from 0013.
 *
 * Why a separate migration ID instead of resetting 0011-0013:
 *   - schema_migrations is append-only by convention. Deleting historical
 *     rows would bypass the runner's ordering check and create a foot-gun
 *     for anyone debugging later.
 *   - This migration's id sorts between 0036 and 0037 (the next pending
 *     one), so it runs before any of the new pending migrations that
 *     reference workspace_id in their own DDL.
 *
 * Idempotent on a properly-migrated DB: every step uses IF NOT EXISTS or
 * works on rows where workspace_id IS NULL — both no-ops once the column
 * exists and is fully populated.
 */
const migration: Migration = {
  id: '0036b_reheal_workspace_id_post_live_site',
  description: 'Re-add workspace_id + backfill + NOT NULL after live-site interlude dropped the columns',

  async up(client) {
    // -- Step 1: Re-add the column on every tenant table -------------------
    // ALTER TABLE IF EXISTS keeps the migration safe when an optional table
    // (e.g. activity_events) is missing on a fresh DB.
    for (const table of ALL_TENANT_TABLES) {
      await client.query(
        `ALTER TABLE IF EXISTS ${table}
           ADD COLUMN IF NOT EXISTS workspace_id UUID
           REFERENCES workspaces(id) ON DELETE CASCADE`,
      );
    }

    // -- Step 2: Resolve the bootstrap workspace --------------------------
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1`,
    );
    const bootstrapWorkspaceId = rows[0]?.id;
    if (!bootstrapWorkspaceId) {
      throw new Error(
        'No workspace exists. Migration 0005 must have created one — refusing to heal into a phantom workspace.',
      );
    }

    const exists = await getExistingTables(client);

    // -- Step 3: Backfill root tables → bootstrap -------------------------
    for (const table of ROOT_TENANT_TABLES) {
      if (!exists.has(table)) continue;
      await client.query(
        `UPDATE ${table} SET workspace_id = $1 WHERE workspace_id IS NULL`,
        [bootstrapWorkspaceId],
      );
    }

    // -- Step 4: Backfill children depth 1 → max --------------------------
    // A child can only be backfilled when both itself AND its parent table
    // physically exist. Skipping a child whose parent is missing is safe:
    // such a row cannot exist (FK would have prevented it pre-drop, and
    // post-drop CASCADE removed the FKs but the data is still parented).
    const maxDepth = Math.max(...CHILD_TENANT_TABLES.map((c) => c.depth));
    for (let depth = 1; depth <= maxDepth; depth++) {
      for (const c of CHILD_TENANT_TABLES.filter((c) => c.depth === depth)) {
        if (!exists.has(c.table) || !exists.has(c.parentTable)) continue;
        await client.query(
          `UPDATE ${c.table} AS t
             SET workspace_id = parent.workspace_id
             FROM ${c.parentTable} AS parent
            WHERE parent.id = t.${c.fkColumn}
              AND t.workspace_id IS NULL`,
        );
      }
    }

    // -- Step 5: Final sweep ----------------------------------------------
    // Catch any still-NULL row across every tenant table (rows whose parent
    // FK was nullable and unset, or orphans whose parent was deleted) and
    // attribute it to the bootstrap workspace.
    for (const table of ALL_TENANT_TABLES) {
      if (!exists.has(table)) continue;
      await client.query(
        `UPDATE ${table} SET workspace_id = $1 WHERE workspace_id IS NULL`,
        [bootstrapWorkspaceId],
      );
    }

    // -- Step 6: NOT NULL + listing index ---------------------------------
    // Postgres enforces NOT NULL at ALTER time by scanning. If any row is
    // still NULL after the sweep, this fails loudly — the right behaviour.
    // CREATE INDEX IF NOT EXISTS on the same name as 0013 is a no-op when
    // the index survived.
    for (const table of ALL_TENANT_TABLES) {
      if (!exists.has(table)) continue;
      await client.query(
        `ALTER TABLE ${table} ALTER COLUMN workspace_id SET NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_workspace ON ${table}(workspace_id)`,
      );
    }
  },
};

async function getExistingTables(client: MigrationClient): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ANY (current_schemas(false))`,
  );
  return new Set(rows.map((r) => r.table_name));
}

export default migration;
