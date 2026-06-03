import { createClient } from '@vercel/postgres';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(process.cwd(), '.env.local') });

// Read-only diagnostic for the "Generating variant N of 6" hang.
// Surfaces every shorts row whose generation_progress is mid-flight or
// errored, plus how stale it is, so we can tell a frozen row (function
// died, never cleared) from one that's genuinely still working.
async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('no POSTGRES_URL');
  const client = createClient({ connectionString: cs });
  await client.connect();

  process.stdout.write(`\n=== Shorts stuck in style-asset generation ===\n`);

  // Any row whose progress phase is set and not terminal-success
  // (cleared rows have generation_progress = '{}').
  const rows = await client.query(`
    SELECT
      id::text,
      workspace_id::text,
      title,
      style_id,
      generation_progress->>'phase'          AS phase,
      generation_progress->>'current'        AS current,
      generation_progress->>'total'          AS total,
      generation_progress->>'label'          AS label,
      generation_progress->>'error_message'  AS error_message,
      generation_progress->>'started_at'     AS started_at,
      generation_progress->>'updated_at'     AS updated_at,
      jsonb_array_length(COALESCE(style_assets->'doodle'->'variants', style_assets->'paint'->'variants', '[]'::jsonb)) AS variants_persisted,
      updated_at                             AS row_updated_at,
      EXTRACT(EPOCH FROM (NOW() - (generation_progress->>'updated_at')::timestamptz))::int AS seconds_since_progress
    FROM shorts
    WHERE generation_progress ? 'phase'
      AND generation_progress->>'phase' IS NOT NULL
    ORDER BY (generation_progress->>'updated_at')::timestamptz DESC NULLS LAST
    LIMIT 50
  `);

  process.stdout.write(`\n[in-flight / errored rows] ${rows.rows.length}\n`);
  for (const r of rows.rows) {
    process.stdout.write(`\n  short ${r.id} (${r.title ?? 'untitled'})\n`);
    process.stdout.write(`    style=${r.style_id} phase=${r.phase} variant=${r.current ?? '-'}/${r.total ?? '-'}\n`);
    process.stdout.write(`    label="${r.label ?? ''}"\n`);
    process.stdout.write(`    variants_persisted=${r.variants_persisted}\n`);
    process.stdout.write(`    started_at=${r.started_at} updated_at=${r.updated_at}\n`);
    process.stdout.write(`    seconds_since_last_progress_write=${r.seconds_since_progress}\n`);
    if (r.error_message) process.stdout.write(`    error_message=${r.error_message}\n`);
  }

  // Phase distribution so we can see if this is one-off or systemic.
  const dist = await client.query(`
    SELECT generation_progress->>'phase' AS phase, COUNT(*)::int AS cnt
      FROM shorts
     WHERE generation_progress ? 'phase'
     GROUP BY 1
     ORDER BY 2 DESC
  `);
  process.stdout.write(`\n[phase distribution]\n`);
  for (const r of dist.rows) process.stdout.write(`  ${r.phase}: ${r.cnt}\n`);

  await client.end();
}

main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
