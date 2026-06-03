import { createClient } from '@vercel/postgres';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(process.cwd(), '.env.local') });

// One-off cleanup: clear generation_progress on ABANDONED pre-cron rows so
// they stop poisoning the drain queue (the drain claims the oldest in-flight
// row first; a dead old-format row blocks real ones behind it). Targets only
// rows that are clearly stranded: an in-flight phase, NO `job` field (the
// background cron always sets one), and no update in >10 min. Live cron jobs
// (which carry `job` and heartbeat often) are never touched.
async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('no POSTGRES_URL');
  const client = createClient({ connectionString: cs });
  await client.connect();

  const { rows } = await client.query(`
    UPDATE shorts
       SET generation_progress = '{}'::jsonb,
           generation_claimed_at = NULL,
           generation_claimed_by_tick = NULL,
           updated_at = NOW()
     WHERE generation_progress ? 'phase'
       AND generation_progress->>'phase' IN ('planning', 'base', 'variant')
       AND (generation_progress->'job') IS NULL
       AND updated_at < NOW() - INTERVAL '10 minutes'
     RETURNING id::text, title
  `);

  process.stdout.write(`\n[cleared ${rows.length} abandoned pre-cron job row(s)]\n`);
  for (const r of rows) process.stdout.write(`  ${r.id} (${r.title ?? 'untitled'})\n`);

  await client.end();
}

main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
