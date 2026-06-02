import { createClient } from '@vercel/postgres';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(process.cwd(), '.env.local') });

async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('no POSTGRES_URL');
  const client = createClient({ connectionString: cs });
  await client.connect();

  process.stdout.write(`\n=== Verifying narrator_assignments_one_active_per_project ===\n`);

  // 1) Index exists?
  const idx = await client.query(`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE tablename = 'narrator_assignments'
       AND indexname = 'narrator_assignments_one_active_per_project'
  `);
  process.stdout.write(`\n[index] ${idx.rows.length} row(s)\n`);
  for (const r of idx.rows) process.stdout.write(`  ${JSON.stringify(r)}\n`);

  // 2) Any active duplicates left?
  const dupes = await client.query(`
    SELECT project_id::text, COUNT(*)::int AS cnt
      FROM narrator_assignments
     WHERE status IN ('assigned','received','recording','submitted','revisions')
     GROUP BY project_id
    HAVING COUNT(*) > 1
  `);
  process.stdout.write(`\n[active duplicates remaining] ${dupes.rows.length}\n`);

  // 3) The user's project — confirm the surviving assignment.
  const a = await client.query(`
    SELECT a.id::text, a.status, a.created_at, a.updated_at, a.full_audio_take_id::text,
           (SELECT COUNT(*)::int FROM narrator_takes t
              JOIN narrator_sections s ON s.id = t.section_id
             WHERE s.assignment_id = a.id) AS take_count
      FROM narrator_assignments a
     WHERE a.project_id = '444519e2-7c08-4b6f-954b-866efcc2d5e7'::uuid
     ORDER BY a.updated_at DESC
  `);
  process.stdout.write(`\n[project 444519e2 assignments] ${a.rows.length} row(s)\n`);
  for (const r of a.rows) process.stdout.write(`  ${JSON.stringify(r)}\n`);

  await client.end();
}

main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
