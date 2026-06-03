import { createClient } from '@vercel/postgres';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(process.cwd(), '.env.local') });

// Why is a Short stuck at "Queued"? Tells us (a) whether migration 0115
// applied (lease columns exist), and (b) whether the cron has ever touched
// the queued row (claimed_at set, updated_at advancing past started_at).
async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('no POSTGRES_URL');
  const client = createClient({ connectionString: cs });
  await client.connect();

  // 1) Did migration 0115 apply? (recorded + columns present)
  const mig = await client.query(
    `SELECT id FROM schema_migrations WHERE id = '0115_shorts_generation_lease'`,
  );
  process.stdout.write(`\n[migration 0115 recorded] ${mig.rows.length === 1 ? 'YES' : 'NO'}\n`);

  const cols = await client.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'shorts'
       AND column_name IN ('generation_claimed_at', 'generation_claimed_by_tick')
  `);
  process.stdout.write(`[lease columns present] ${cols.rows.map((r) => r.column_name).join(', ') || 'NONE'}\n`);

  // 2) Current queued / in-flight rows + lease + heartbeat freshness.
  const rows = await client.query(`
    SELECT id::text, title,
           generation_progress->>'phase'      AS phase,
           generation_progress->>'started_at' AS started_at,
           generation_progress->>'updated_at' AS updated_at,
           (generation_progress->'job') IS NOT NULL AS has_job,
           generation_progress->'job'->>'niche' AS niche,
           generation_claimed_at,
           generation_claimed_by_tick,
           EXTRACT(EPOCH FROM (NOW() - (generation_progress->>'updated_at')::timestamptz))::int AS secs_since_update
      FROM shorts
     WHERE generation_progress ? 'phase'
     ORDER BY (generation_progress->>'started_at') DESC NULLS LAST
     LIMIT 20
  `);
  process.stdout.write(`\n[in-flight rows] ${rows.rows.length}\n`);
  for (const r of rows.rows) {
    process.stdout.write(`\n  ${r.id} (${r.title ?? 'untitled'})\n`);
    process.stdout.write(`    phase=${r.phase} has_job=${r.has_job} niche=${r.niche ?? '-'}\n`);
    process.stdout.write(`    started=${r.started_at}\n    updated=${r.updated_at} (${r.secs_since_update}s ago)\n`);
    process.stdout.write(`    claimed_at=${r.generation_claimed_at ?? 'NULL'} by_tick=${r.generation_claimed_by_tick ?? 'NULL'}\n`);
  }

  await client.end();
}

main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
