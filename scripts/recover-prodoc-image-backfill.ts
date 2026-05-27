/**
 * One-shot recovery for the "Open in editor renders empty frames" bug
 * caused by the early-skip in `backfillFromPayload`. See the rewritten
 * docblock at `src/lib/project/assets.ts:182-209` for the bug history.
 *
 * For every `production_doc` row that still carries legacy asset maps
 * on `user_history.payload`, this runs the same per-row merge the
 * fixed helper now performs at load time:
 *
 *   INSERT INTO project_assets (project_id, row_index, slot, data)
 *   SELECT ...
 *     FROM jsonb_array_elements(legacy maps as batch)
 *    ON CONFLICT (project_id, row_index, slot) DO NOTHING
 *
 * Idempotent. Re-running is safe — the unique index makes every
 * already-present (project_id, row_index, slot) a no-op. Existing
 * post-extraction rows always win.
 *
 * Defaults to filtering by `--email`. Pass `--all` to walk every
 * production_doc in the table (operator-only). Pass `--dry-run` to
 * count without writing.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/recover-prodoc-image-backfill.ts \
 *     --email contact@wellnessbees.com
 */
import { createClient } from '@vercel/postgres';

interface LegacyMaps {
  rowImages: Record<string, unknown>;
  rowOverlays: Record<string, unknown>;
  rowVideoClips: Record<string, unknown>;
}

type Slot = 'image' | 'overlay' | 'clip';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

function buildBatch(maps: LegacyMaps): Array<{ row_index: number; slot: Slot; data: unknown }> {
  const out: Array<{ row_index: number; slot: Slot; data: unknown }> = [];
  for (const [k, v] of Object.entries(maps.rowImages ?? {})) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (typeof v !== 'string' || v.length === 0) continue;
    out.push({ row_index: idx, slot: 'image', data: v });
  }
  for (const [k, v] of Object.entries(maps.rowOverlays ?? {})) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (!v || typeof v !== 'object') continue;
    out.push({ row_index: idx, slot: 'overlay', data: v });
  }
  for (const [k, v] of Object.entries(maps.rowVideoClips ?? {})) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (!v || typeof v !== 'object') continue;
    out.push({ row_index: idx, slot: 'clip', data: v });
  }
  return out;
}

async function main() {
  const email = arg('--email');
  const all = process.argv.includes('--all');
  const dryRun = process.argv.includes('--dry-run');
  if (!email && !all) {
    process.stderr.write('Pass --email <addr> or --all\n');
    process.exit(1);
  }
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('POSTGRES_URL_NON_POOLING / POSTGRES_URL not set');

  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    const projects = email
      ? await client.query<{
          id: string;
          title: string | null;
          payload: LegacyMaps;
        }>(
          `SELECT h.id,
                  h.payload->'doc'->>'title' AS title,
                  jsonb_build_object(
                    'rowImages',     COALESCE(h.payload->'rowImages', '{}'::jsonb),
                    'rowOverlays',   COALESCE(h.payload->'rowOverlays', '{}'::jsonb),
                    'rowVideoClips', COALESCE(h.payload->'rowVideoClips', '{}'::jsonb)
                  ) AS payload
             FROM user_history h
             JOIN collaborators c ON c.id = h.collaborator_id
            WHERE h.kind = 'production_doc' AND c.email = $1`,
          [email],
        )
      : await client.query<{
          id: string;
          title: string | null;
          payload: LegacyMaps;
        }>(
          `SELECT h.id,
                  h.payload->'doc'->>'title' AS title,
                  jsonb_build_object(
                    'rowImages',     COALESCE(h.payload->'rowImages', '{}'::jsonb),
                    'rowOverlays',   COALESCE(h.payload->'rowOverlays', '{}'::jsonb),
                    'rowVideoClips', COALESCE(h.payload->'rowVideoClips', '{}'::jsonb)
                  ) AS payload
             FROM user_history h
            WHERE h.kind = 'production_doc'`,
        );

    process.stdout.write(`Scanning ${projects.rows.length} production_doc rows${dryRun ? ' (dry-run)' : ''}.\n`);

    let totalInserted = 0;
    let touched = 0;
    let untouched = 0;

    for (const proj of projects.rows) {
      const batch = buildBatch(proj.payload);
      if (batch.length === 0) {
        untouched++;
        continue;
      }
      if (dryRun) {
        process.stdout.write(`  ${proj.id}  candidates=${batch.length}  title=${proj.title ?? ''}\n`);
        touched++;
        continue;
      }

      const result = await client.query<{ row_index: number }>(
        `INSERT INTO project_assets (project_id, row_index, slot, data)
         SELECT $1::uuid,
                (r->>'row_index')::int,
                r->>'slot',
                r->'data'
           FROM jsonb_array_elements($2::jsonb) AS r
         ON CONFLICT (project_id, row_index, slot) DO NOTHING
         RETURNING row_index`,
        [proj.id, JSON.stringify(batch)],
      );
      const inserted = result.rowCount ?? result.rows.length;
      totalInserted += inserted;
      touched++;
      if (inserted > 0) {
        process.stdout.write(`  ${proj.id}  inserted=${inserted}  candidates=${batch.length}  title=${proj.title ?? ''}\n`);
      }
    }

    process.stdout.write(`\nDone. projects_touched=${touched} projects_already_clean=${untouched} rows_inserted=${totalInserted}\n`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  process.stderr.write(`\nError: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
