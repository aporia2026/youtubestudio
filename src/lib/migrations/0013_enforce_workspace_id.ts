import type { Migration } from './types';
import { ALL_TENANT_TABLES } from './_workspace_scoped_tables';

/**
 * Lock down `workspace_id`: make it NOT NULL and add an index for the scoping
 * query that every authenticated route will issue. Runs only after 0012 has
 * populated every existing row — Postgres enforces the NOT NULL at ALTER time
 * by scanning, so any orphan row would fail this migration loudly. That's the
 * desired behaviour: better a loud failure than silent multi-tenant leakage.
 *
 * `ALTER TABLE IF EXISTS` skips tables that don't exist on the target DB
 * (cleanly handles installations that never invoked the legacy ensure*Schema
 * helpers for an optional feature like activity_events).
 *
 * The index name follows the existing `idx_<table>_<column>` convention used
 * elsewhere in the schema.
 */
const migration: Migration = {
  id: '0013_enforce_workspace_id',
  description: 'Set workspace_id NOT NULL on every tenant-scoped table and add the scoping index',

  async up(client) {
    for (const table of ALL_TENANT_TABLES) {
      // For tables that don't exist yet (e.g. activity_events on a fresh DB),
      // the ALTER and CREATE INDEX both no-op via IF EXISTS.
      await client.query(
        `ALTER TABLE IF EXISTS ${table} ALTER COLUMN workspace_id SET NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_workspace ON ${table}(workspace_id)`,
      );
    }
  },
};

export default migration;
