/**
 * Read-only diagnostic — does the live DB still have workspace_id columns?
 *
 * Today's live-site self-heal dropped workspace_id from every public-schema
 * table that had it. If that ran, we expect zero rows here. If we're wrong
 * and the columns survived, we expect the full set listed in
 * _workspace_scoped_tables.
 */
import { createClient } from '@vercel/postgres';

async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('POSTGRES_URL_NON_POOLING not set');
  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    const { rows: wsCols } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'workspace_id' AND table_schema = 'public'
        ORDER BY table_name`,
    );
    process.stdout.write(`Tables with workspace_id column: ${wsCols.length}\n`);
    for (const r of wsCols) process.stdout.write(`  - ${r.table_name}\n`);

    const { rows: tenantTables } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN (
          'projects','scripts','qa_sessions','schedule_items','channels',
          'video_ideas','workflow_drafts','templates','media_assets',
          'workspaces','collaborators','workspace_members','workspace_model_defaults'
        )
        ORDER BY table_name`,
    );
    process.stdout.write(`\nKey tables that exist:\n`);
    for (const r of tenantTables) process.stdout.write(`  - ${r.table_name}\n`);

    // Sanity check — do we have an admin row + at least one workspace?
    const adminCount = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM collaborators WHERE system_role = 'admin'`,
    );
    process.stdout.write(`\nAdmin rows: ${adminCount.rows[0].c}\n`);
    const wsCount = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM workspaces`,
    );
    process.stdout.write(`Workspace rows: ${wsCount.rows[0].c}\n`);

    // Get the bootstrap workspace id (oldest)
    const bootstrap = await client.query<{ id: string; name: string; created_at: Date }>(
      `SELECT id, name, created_at FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1`,
    );
    if (bootstrap.rows[0]) {
      process.stdout.write(`Bootstrap workspace: ${bootstrap.rows[0].id} (${bootstrap.rows[0].name})\n`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
