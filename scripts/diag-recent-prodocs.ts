/**
 * Read-only: list recent production_doc rows for the contact@wellnessbees.com
 * account so we can identify the doc the user opened in the editor.
 *
 * Run: npx tsx --env-file=.env.local scripts/diag-recent-prodocs.ts
 */
import { createClient } from '@vercel/postgres';

async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('POSTGRES_URL_NON_POOLING / POSTGRES_URL not set');

  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    const rows = await client.query<{
      id: string;
      version: number;
      created_at: string;
      title: string | null;
      rows_count: number;
      legacy_image_keys: number;
      assets_image_count: string;
    }>(
      `WITH me AS (
         SELECT id FROM collaborators WHERE email = 'contact@wellnessbees.com' LIMIT 1
       )
       SELECT h.id,
              h.version,
              h.created_at::text AS created_at,
              h.payload->'doc'->>'title' AS title,
              jsonb_array_length(COALESCE(h.payload->'doc'->'rows', '[]'::jsonb)) AS rows_count,
              (SELECT count(*)::int FROM jsonb_object_keys(COALESCE(h.payload->'rowImages', '{}'::jsonb))) AS legacy_image_keys,
              (SELECT count(*)::text FROM project_assets pa
                 WHERE pa.project_id = h.id AND pa.slot = 'image') AS assets_image_count
         FROM user_history h
         JOIN me ON me.id = h.collaborator_id
        WHERE h.kind = 'production_doc'
        ORDER BY h.created_at DESC
        LIMIT 15`,
    );
    if (rows.rows.length === 0) {
      process.stdout.write('No production_doc rows for contact@wellnessbees.com\n');
      return;
    }
    process.stdout.write('Recent production_doc rows (newest first):\n');
    process.stdout.write('id                                    rows  imgs(assets)  legacy(payload)  created_at                title\n');
    for (const r of rows.rows) {
      process.stdout.write(
        `${r.id}  ${String(r.rows_count).padStart(4)}  ${String(r.assets_image_count).padStart(12)}  ${String(r.legacy_image_keys).padStart(15)}  ${r.created_at}  ${r.title ?? ''}\n`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  process.stderr.write(`\nError: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
