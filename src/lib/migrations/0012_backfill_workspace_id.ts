import type { Migration, MigrationClient } from './types';
import {
  ALL_TENANT_TABLES,
  ROOT_TENANT_TABLES,
  CHILD_TENANT_TABLES,
} from './_workspace_scoped_tables';

interface BootstrapWs {
  id: string;
}

/**
 * Backfill `workspace_id` on every tenant-scoped table.
 *
 * For pre-existing data (a single-tenant DB upgrading to multi-tenant), the
 * only workspace that exists at this point is the bootstrap workspace
 * created by 0005. All current rows therefore belong to that workspace.
 *
 * Backfill order:
 *   1. Root tables — set workspace_id directly to the bootstrap workspace.
 *   2. Children, deepest-first by their dependency depth (1 → 4). Each pass
 *      requires the previous pass to have completed (parent's workspace_id
 *      must exist before we can copy it down).
 *   3. Final-sweep fallback — any row that STILL has NULL workspace_id
 *      after the structured backfill (e.g. activity_events with NULL
 *      project_id, or rows whose parent FK was nullable and unset) is
 *      attributed to the bootstrap workspace. This is safe because we
 *      are upgrading a single-tenant DB; every existing row is owned by
 *      the bootstrap tenant by definition.
 *
 * On a fresh install with no pre-existing data, every UPDATE affects 0 rows
 * — the migration is a near-no-op but still runs (idempotent).
 *
 * Tables that don't physically exist on the target DB are skipped — some
 * tenant tables (templates, activity_events, narration_take_comments etc.)
 * are created lazily by ensure*Schema() helpers on first use, so a never-
 * exercised feature leaves its table absent. Migration 0011 handles this
 * with `ALTER TABLE IF EXISTS`; UPDATE has no such form, so we explicitly
 * check information_schema before issuing each UPDATE.
 */
const migration: Migration = {
  id: '0012_backfill_workspace_id',
  description: 'Populate workspace_id on existing rows (root tables → bootstrap; children → parent; sweep)',

  async up(client) {
    // Resolve the bootstrap workspace deterministically (oldest by created_at).
    const { rows } = await client.query<BootstrapWs>(
      `SELECT id FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1`,
    );
    const bootstrapWorkspaceId = rows[0]?.id;
    if (!bootstrapWorkspaceId) {
      throw new Error(
        'No workspace exists. Migration 0005 must run before 0012 — refusing to backfill into a phantom workspace.',
      );
    }

    const exists = await getExistingTables(client);

    // -- Root tables --------------------------------------------------------
    for (const table of ROOT_TENANT_TABLES) {
      if (!exists.has(table)) continue;
      await client.query(
        `UPDATE ${table} SET workspace_id = $1 WHERE workspace_id IS NULL`,
        [bootstrapWorkspaceId],
      );
    }

    // -- Children, depth 1 -> 4 --------------------------------------------
    // A child can only be backfilled when both itself AND its parent table
    // physically exist. Skipping a child whose parent is missing is safe:
    // such a row cannot exist (FK would have prevented it).
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

    // -- Final sweep --------------------------------------------------------
    // Catch every still-NULL row across every tenant table and attribute it
    // to the bootstrap workspace. Required for tables with nullable parent
    // FKs (activity_events.project_id is null for non-project notifications)
    // and for orphaned rows whose parent was deleted before the FK landed.
    for (const table of ALL_TENANT_TABLES) {
      if (!exists.has(table)) continue;
      await client.query(
        `UPDATE ${table} SET workspace_id = $1 WHERE workspace_id IS NULL`,
        [bootstrapWorkspaceId],
      );
    }
  },
};

/**
 * Pull the set of tables that physically exist in the current schema.
 * Cheap (one round-trip) and lets us gate every subsequent UPDATE without
 * a per-table information_schema query.
 */
async function getExistingTables(client: MigrationClient): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ANY (current_schemas(false))`,
  );
  return new Set(rows.map((r) => r.table_name));
}

export default migration;
