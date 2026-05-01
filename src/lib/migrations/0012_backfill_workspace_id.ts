import type { Migration } from './types';
import { ROOT_TENANT_TABLES, CHILD_TENANT_TABLES } from './_workspace_scoped_tables';

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
 *
 * On a fresh install with no pre-existing data, every UPDATE affects 0 rows
 * — the migration is a near-no-op but still runs (idempotent).
 */
const migration: Migration = {
  id: '0012_backfill_workspace_id',
  description: 'Populate workspace_id on existing rows (root tables → bootstrap; children → parent)',

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

    // -- Root tables --------------------------------------------------------
    for (const table of ROOT_TENANT_TABLES) {
      await client.query(
        `UPDATE ${table} SET workspace_id = $1 WHERE workspace_id IS NULL`,
        [bootstrapWorkspaceId],
      );
    }

    // -- Children, depth 1 -> 4 --------------------------------------------
    const maxDepth = Math.max(...CHILD_TENANT_TABLES.map((c) => c.depth));
    for (let depth = 1; depth <= maxDepth; depth++) {
      for (const c of CHILD_TENANT_TABLES.filter((c) => c.depth === depth)) {
        await client.query(
          `UPDATE ${c.table} AS t
             SET workspace_id = parent.workspace_id
             FROM ${c.parentTable} AS parent
            WHERE parent.id = t.${c.fkColumn}
              AND t.workspace_id IS NULL`,
        );
      }
    }
  },
};

export default migration;
