import 'dotenv/config';
import { sql } from '@vercel/postgres';

/**
 * Diagnose + recover stuck shorts in a bulk batch. Default mode is
 * read-only; pass `--requeue <short_id> [<short_id> ...]` to clear
 * `generation_progress` on those rows so the orchestrator picks them
 * back up on the next tick.
 */
async function main() {
  const args = process.argv.slice(2);
  const requeueIdx = args.indexOf('--requeue');
  const requeueIds = requeueIdx >= 0 ? args.slice(requeueIdx + 1) : [];
  const batchArg = requeueIdx >= 0 ? args.slice(0, requeueIdx)[0] : args[0];
  const batchId = batchArg || '41808d2a-47f1-4a97-a01c-852e17ffb02c';

  if (requeueIds.length > 0) {
    for (const id of requeueIds) {
      const { rowCount } = await sql`
        UPDATE shorts
           SET generation_progress = '{}'::jsonb,
               updated_at = NOW()
         WHERE id = ${id}::uuid AND batch_id = ${batchId}::uuid
      `;
      console.log(`requeue ${id}: ${rowCount === 1 ? 'ok' : 'NO MATCH'}`);
    }
    return;
  }

  const { rows } = await sql`
    SELECT id, title,
           short_script IS NULL as no_script,
           voiceover_audio_url IS NULL as no_voiceover,
           seo_result IS NULL as no_seo,
           rendered_video_url IS NULL as no_render,
           generation_progress
      FROM shorts
     WHERE batch_id = ${batchId}::uuid
     ORDER BY created_at
  `;
  console.log('batch:', batchId, 'shorts:', rows.length);
  for (const r of rows as any[]) {
    const gp = r.generation_progress || {};
    console.log('\n---');
    console.log('id:', r.id);
    console.log('title:', r.title || '(untitled)');
    console.log('done:', {
      script: !r.no_script, voiceover: !r.no_voiceover, seo: !r.no_seo, render: !r.no_render,
    });
    console.log('phase:', gp.phase, '| label:', gp.label);
    if (gp.error_message) console.log('ERROR:', gp.error_message);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
