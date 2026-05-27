/**
 * Read-only diagnostic for "Open in editor → many frames empty".
 *
 * For a given production-doc project id, dumps:
 *   - user_history row metadata (owner, workspace, kind, version, rows count)
 *   - the JSONB payload's legacy rowImages / rowOverlays / rowVideoClips maps
 *     (sizes + key samples — these should usually be empty post-backfill)
 *   - the project_assets table contents (count per slot, row_index sample)
 *   - a per-row-index hit/miss table: for each row index in doc.rows,
 *     does project_assets have an 'image' entry for it?
 *
 * Run:
 *   npx tsx scripts/diag-editor-empty-frames.ts <projectId>
 */
import { createClient } from '@vercel/postgres';

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    process.stderr.write('Usage: tsx scripts/diag-editor-empty-frames.ts <projectId>\n');
    process.exit(1);
  }
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('POSTGRES_URL_NON_POOLING / POSTGRES_URL not set');

  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    // 1. user_history metadata + payload shape probe.
    const hist = await client.query<{
      id: string;
      kind: string;
      workspace_id: string;
      collaborator_id: string;
      version: number;
      created_at: string;
      rows_count: number;
      row_images_count: number;
      row_overlays_count: number;
      row_clips_count: number;
      row_image_keys: string[] | null;
    }>(
      `SELECT id,
              kind,
              workspace_id,
              collaborator_id,
              version,
              created_at,
              jsonb_array_length(COALESCE(payload->'doc'->'rows', '[]'::jsonb))    AS rows_count,
              (SELECT count(*) FROM jsonb_object_keys(COALESCE(payload->'rowImages', '{}'::jsonb)))    AS row_images_count,
              (SELECT count(*) FROM jsonb_object_keys(COALESCE(payload->'rowOverlays', '{}'::jsonb)))  AS row_overlays_count,
              (SELECT count(*) FROM jsonb_object_keys(COALESCE(payload->'rowVideoClips', '{}'::jsonb))) AS row_clips_count,
              (SELECT array_agg(k ORDER BY k::int) FROM jsonb_object_keys(COALESCE(payload->'rowImages', '{}'::jsonb)) k) AS row_image_keys
         FROM user_history
        WHERE id = $1::uuid`,
      [projectId],
    );

    if (hist.rows.length === 0) {
      process.stdout.write(`No user_history row for id=${projectId}\n`);
      return;
    }
    const h = hist.rows[0];
    process.stdout.write(`\n=== user_history ===\n`);
    process.stdout.write(`id              : ${h.id}\n`);
    process.stdout.write(`kind            : ${h.kind}\n`);
    process.stdout.write(`workspace_id    : ${h.workspace_id}\n`);
    process.stdout.write(`collaborator_id : ${h.collaborator_id}\n`);
    process.stdout.write(`version         : ${h.version}\n`);
    process.stdout.write(`created_at      : ${h.created_at}\n`);
    process.stdout.write(`doc.rows count  : ${h.rows_count}\n`);
    process.stdout.write(`\n=== payload legacy asset maps (should be empty post-backfill) ===\n`);
    process.stdout.write(`rowImages keys     : ${h.row_images_count}\n`);
    process.stdout.write(`rowOverlays keys   : ${h.row_overlays_count}\n`);
    process.stdout.write(`rowVideoClips keys : ${h.row_clips_count}\n`);
    if (h.row_image_keys && h.row_image_keys.length > 0) {
      process.stdout.write(`rowImages key sample (first 20): ${h.row_image_keys.slice(0, 20).join(',')}\n`);
    }

    // 2. project_assets — per-slot counts + per-row hit table.
    const assets = await client.query<{
      row_index: number;
      slot: string;
      data_kind: string;
      data_preview: string;
    }>(
      `SELECT row_index,
              slot,
              jsonb_typeof(data) AS data_kind,
              left(data::text, 120) AS data_preview
         FROM project_assets
        WHERE project_id = $1::uuid
        ORDER BY row_index, slot`,
      [projectId],
    );

    const byRowSlot = new Map<string, { kind: string; preview: string }>();
    let imgCount = 0;
    let overlayCount = 0;
    let clipCount = 0;
    for (const a of assets.rows) {
      byRowSlot.set(`${a.row_index}:${a.slot}`, { kind: a.data_kind, preview: a.data_preview });
      if (a.slot === 'image') imgCount++;
      else if (a.slot === 'overlay') overlayCount++;
      else if (a.slot === 'clip') clipCount++;
    }

    process.stdout.write(`\n=== project_assets totals ===\n`);
    process.stdout.write(`image slots   : ${imgCount}\n`);
    process.stdout.write(`overlay slots : ${overlayCount}\n`);
    process.stdout.write(`clip slots    : ${clipCount}\n`);
    process.stdout.write(`rows total    : ${assets.rows.length}\n`);

    if (assets.rows.length > 0) {
      const idxs = assets.rows.map((r) => r.row_index);
      const min = Math.min(...idxs);
      const max = Math.max(...idxs);
      process.stdout.write(`row_index range: [${min}, ${max}]\n`);
    }

    // 3. per-doc-row hit table — alignment between doc.rows and assets.
    process.stdout.write(`\n=== doc.rows[i] vs project_assets coverage (first 30) ===\n`);
    process.stdout.write(`idx  image  overlay  clip\n`);
    const total = h.rows_count;
    const sampleN = Math.min(total, 30);
    let missingImages = 0;
    for (let i = 0; i < total; i++) {
      const hasImg = byRowSlot.has(`${i}:image`);
      if (!hasImg) missingImages++;
      if (i < sampleN) {
        const hasOv = byRowSlot.has(`${i}:overlay`);
        const hasCl = byRowSlot.has(`${i}:clip`);
        process.stdout.write(
          `${String(i).padStart(3, ' ')}  ${hasImg ? ' Y ' : ' . '}    ${hasOv ? ' Y ' : ' . '}     ${hasCl ? ' Y ' : ' . '}\n`,
        );
      }
    }
    process.stdout.write(`\nDoc rows missing an image slot: ${missingImages} / ${total}\n`);

    // 4. preview of first few image data values to verify shape.
    process.stdout.write(`\n=== sample image asset values (first 5) ===\n`);
    let shown = 0;
    for (const a of assets.rows) {
      if (a.slot !== 'image') continue;
      process.stdout.write(`  [row ${a.row_index}] kind=${a.data_kind} value=${a.data_preview}\n`);
      shown++;
      if (shown >= 5) break;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  process.stderr.write(`\nError: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
