/**
 * Read-only: for a given project, list which row indices have an image
 * in project_assets vs. which row indices have one in the legacy
 * payload->'rowImages' map, and identify the gap.
 */
import { createClient } from '@vercel/postgres';

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error('Usage: tsx scripts/diag-asset-vs-payload-keys.ts <projectId>');
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('POSTGRES_URL_NON_POOLING / POSTGRES_URL not set');

  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    const { rows: rowCountRows } = await client.query<{ n: number }>(
      `SELECT jsonb_array_length(COALESCE(payload->'doc'->'rows','[]'::jsonb)) AS n
         FROM user_history WHERE id = $1::uuid`,
      [projectId],
    );
    const docRowCount = rowCountRows[0]?.n ?? 0;

    const { rows: assetRows } = await client.query<{ row_index: number }>(
      `SELECT row_index FROM project_assets
        WHERE project_id = $1::uuid AND slot = 'image'
        ORDER BY row_index`,
      [projectId],
    );
    const assetIdx = new Set(assetRows.map((r) => r.row_index));

    const { rows: legacyRows } = await client.query<{ k: string }>(
      `SELECT jsonb_object_keys(COALESCE(payload->'rowImages', '{}'::jsonb)) AS k
         FROM user_history WHERE id = $1::uuid`,
      [projectId],
    );
    const legacyIdx = new Set(
      legacyRows
        .map((r) => Number(r.k))
        .filter((n) => Number.isInteger(n) && n >= 0),
    );

    const onlyAssets: number[] = [];
    const onlyLegacy: number[] = [];
    const both: number[] = [];
    const neither: number[] = [];
    for (let i = 0; i < docRowCount; i++) {
      const a = assetIdx.has(i);
      const l = legacyIdx.has(i);
      if (a && l) both.push(i);
      else if (a) onlyAssets.push(i);
      else if (l) onlyLegacy.push(i);
      else neither.push(i);
    }

    process.stdout.write(`Doc rows           : ${docRowCount}\n`);
    process.stdout.write(`assets only        : ${onlyAssets.length}\n`);
    process.stdout.write(`legacy only        : ${onlyLegacy.length}   <-- these render EMPTY in editor\n`);
    process.stdout.write(`both               : ${both.length}\n`);
    process.stdout.write(`neither            : ${neither.length}\n`);

    if (onlyLegacy.length > 0) {
      process.stdout.write(`\nFirst 30 legacy-only indices: ${onlyLegacy.slice(0, 30).join(',')}\n`);
    }
    if (onlyAssets.length > 0) {
      process.stdout.write(`First 30 assets-only indices: ${onlyAssets.slice(0, 30).join(',')}\n`);
    }

    // Sample a few legacy values to confirm they're real URLs.
    if (onlyLegacy.length > 0) {
      const sampleIdx = onlyLegacy.slice(0, 3);
      for (const i of sampleIdx) {
        const { rows: v } = await client.query<{ v: string | null }>(
          `SELECT payload->'rowImages'->>$2 AS v
             FROM user_history WHERE id = $1::uuid`,
          [projectId, String(i)],
        );
        const val = v[0]?.v;
        process.stdout.write(`  legacy [${i}] : ${val ? `${val.slice(0, 100)}${val.length > 100 ? '…' : ''}` : '(null)'}\n`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  process.stderr.write(`\nError: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
