import 'dotenv/config';
import { sql } from '@vercel/postgres';

async function main() {
  const batchId = process.argv[2] || '41808d2a-47f1-4a97-a01c-852e17ffb02c';

  const batch = await sql`
    SELECT id, workspace_id, status, defaults, totals
      FROM shorts_batches
     WHERE id = ${batchId}::uuid
  `;
  const b: any = batch.rows[0];
  console.log('batch.workspace_id:', b?.workspace_id, '| status:', b?.status);

  if (b?.workspace_id) {
    const defaults = await sql`
      SELECT scope, model_id FROM workspace_model_defaults
       WHERE workspace_id = ${b.workspace_id}::uuid
       ORDER BY scope
    `;
    console.log('\nworkspace_model_defaults:');
    for (const r of defaults.rows as any[]) {
      console.log(' ', r.scope, '→', r.model_id);
    }
  }

  const { rows } = await sql`
    SELECT id, title, hook,
           short_script IS NULL as no_script,
           voiceover_audio_url IS NULL as no_voiceover,
           seo_result IS NULL as no_seo,
           rendered_video_url IS NULL as no_render,
           ai_model,
           generation_progress,
           created_at, updated_at
      FROM shorts
     WHERE batch_id = ${batchId}::uuid
     ORDER BY created_at
  `;
  console.log('\nshorts:', rows.length);
  for (const r of rows as any[]) {
    const gp = r.generation_progress || {};
    console.log('\n---');
    console.log('id:', r.id);
    console.log('title:', r.title || r.hook || '(untitled)');
    console.log('done:', {
      script: !r.no_script,
      voiceover: !r.no_voiceover,
      seo: !r.no_seo,
      render: !r.no_render,
    });
    console.log('ai_model (last writer):', r.ai_model);
    console.log('phase:', gp.phase, '| label:', gp.label);
    if (gp.error_message) console.log('ERROR:', gp.error_message);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
