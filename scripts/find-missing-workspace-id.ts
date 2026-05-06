/**
 * Identify every table that has a *parent FK* into projects/channels/workspaces
 * but is missing the workspace_id column.
 *
 * Run after a partial heal to find tables created by migrations after the
 * 0011/0012/0013 rollout (ab_tests, critic_panels, etc) that today's
 * live-site DROP COLUMN walked over.
 */
import { createClient } from '@vercel/postgres';

async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('POSTGRES_URL_NON_POOLING not set');
  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    // Look at every public table the migration runner cares about — i.e.
    // every CREATE TABLE inside src/lib/migrations/. For our purposes we
    // can ask: "what tables exist that DON'T have a workspace_id column
    // but reference workspaces or projects?"
    const { rows: tables } = await client.query<{ table_name: string }>(
      `SELECT t.table_name
         FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_name NOT IN ('schema_migrations', 'workspaces', 'workspace_members', 'collaborators', 'schedule_item_channels', 'schedule_item_dependencies', 'narrator_profiles')
        ORDER BY t.table_name`,
    );

    const { rows: cols } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'workspace_id' AND table_schema = 'public'`,
    );
    const haveWs = new Set(cols.map((r) => r.table_name));

    process.stdout.write(`All public tables (excluding non-tenant ones): ${tables.length}\n`);
    process.stdout.write(`Tables WITH workspace_id: ${haveWs.size}\n\n`);

    process.stdout.write(`Tables MISSING workspace_id:\n`);
    for (const t of tables) {
      if (!haveWs.has(t.table_name)) {
        process.stdout.write(`  - ${t.table_name}\n`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
