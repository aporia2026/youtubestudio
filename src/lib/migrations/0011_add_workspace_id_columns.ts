import type { Migration } from './types';
import { ALL_TENANT_TABLES } from './_workspace_scoped_tables';

/**
 * Add a nullable `workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE`
 * column to every tenant-scoped table.
 *
 * Nullable here, NOT NULL after the backfill in 0013. Keeping it nullable
 * for the duration of 0012's backfill means the legacy app code (which knows
 * nothing about workspace_id) keeps inserting and reading rows without
 * failure.
 *
 * `ON DELETE CASCADE` means deleting a workspace removes all of its data —
 * the right behaviour for tenant deletion via /admin. Confirmation gates
 * for that destructive action live in the admin panel (PR #6), not here.
 *
 * `ALTER TABLE IF EXISTS` keeps the migration safe when an optional table
 * (e.g. activity_events on a never-booted DB) is missing — the migration
 * silently skips it instead of failing. The complementary
 * `ADD COLUMN IF NOT EXISTS` makes the per-table step idempotent.
 */
const migration: Migration = {
  id: '0011_add_workspace_id_columns',
  description: 'Add nullable workspace_id column (FK ON DELETE CASCADE) to every tenant-scoped table',

  async up(client) {
    for (const table of ALL_TENANT_TABLES) {
      // The table identifier comes from a hardcoded const list validated at
      // module-load time — never user input. Safe to interpolate.
      await client.query(
        `ALTER TABLE IF EXISTS ${table}
           ADD COLUMN IF NOT EXISTS workspace_id UUID
           REFERENCES workspaces(id) ON DELETE CASCADE`,
      );
    }
  },

  // No `down` — removing workspace_id from rows that have already been
  // tenant-scoped would conflate ownership across workspaces.
};

export default migration;
