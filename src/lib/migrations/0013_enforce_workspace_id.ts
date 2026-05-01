import type { Migration, MigrationClient } from './types';
import { ALL_TENANT_TABLES } from './_workspace_scoped_tables';

/**
 * Lock down `workspace_id`: make it NOT NULL and add an index for the scoping
 * query that every authenticated route will issue. Runs only after 0012 has
 * populated every existing row — Postgres enforces the NOT NULL at ALTER time
 * by scanning, so any orphan row would fail this migration loudly. That's the
 * desired behaviour: better a loud failure than silent multi-tenant leakage.
 *
 * Tables that don't physically exist on the target DB are skipped — a fresh
 * install hasn't yet run its lazy ensure*Schema() helpers for optional
 * features (templates, activity_events, narration_take_comments, etc.), so
 * we check information_schema before issuing each statement. ALTER TABLE has
 * an IF EXISTS form; CREATE INDEX does not, so the existence check is the
 * reliable gate for both.
 */
const migration: Migration = {
  id: '0013_enforce_workspace_id',
  description: 'Set workspace_id NOT NULL on every tenant-scoped table and add the scoping index',

  async up(client) {
    const exists = await getExistingTables(client);
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
