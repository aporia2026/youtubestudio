import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import { sql } from '@vercel/postgres';

async function main() {
  const r = await sql<any>`
    SELECT id, short_id, status, progress, lambda_render_id, lambda_bucket,
           to_timestamp(started_at / 1000.0) AS started,
           to_timestamp(finished_at / 1000.0) AS finished,
           ((extract(epoch from now()) * 1000 - started_at) / 1000)::int AS age_seconds,
           estimated_cost, error
    FROM render_jobs
    WHERE status = 'rendering' AND lambda_render_id IS NOT NULL
    ORDER BY started_at DESC
  `;
  console.log('stuck-in-rendering count:', r.rows.length);
  for (const row of r.rows) {
    console.log('---');
    console.log('  id:', row.id);
    console.log('  short_id:', row.short_id);
    console.log('  status:', row.status, '| progress:', row.progress);
    console.log('  lambda_render_id:', row.lambda_render_id);
    console.log('  bucket:', row.lambda_bucket);
    console.log('  started:', row.started, '| finished:', row.finished);
    console.log('  age_seconds:', row.age_seconds);
    console.log('  estimated_cost:', row.estimated_cost);
    if (row.error) console.log('  error:', String(row.error).slice(0, 300));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
