/**
 * One-time backfill for `projects.current_stage`.
 *
 * Wave 3 of the Command Center plan added a cached `current_stage`
 * column on `projects` that every stage-changing path
 * (advanceVideo()) now dual-writes. This script populates the column
 * for every existing project so the cached value is available before
 * the first manual advance happens.
 *
 * Strategy: for each project, compute the canonical stage from the
 * same join sources `resolveStage()` uses in `src/lib/video-context.ts`
 * and `src/lib/command-center.ts`, then write it to the column. The
 * computation lives here as a self-contained SQL CASE chain so the
 * script doesn't depend on the runtime module — if the runtime logic
 * changes later, re-running this script reconciles every row to the
 * latest definition.
 *
 * Idempotent: re-running overwrites with the freshly-computed value.
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/backfill-project-current-stage.ts
 */
import { createClient } from '@vercel/postgres';

const connectionString =
  process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('POSTGRES_URL_NON_POOLING (preferred) or POSTGRES_URL must be set.');
}

async function main() {
  const client = createClient({ connectionString });
  await client.connect();
  process.stdout.write('Backfilling projects.current_stage…\n');

  // The same resolution priority as resolveStage() in video-context.ts
  // and command-center.ts, expressed as a SQL CASE chain. Update both
  // sides if the priority changes — there is no test enforcing parity.
  //
  // Priority:
  //   1. Active pipeline_run_videos.stage (mapped from pipeline → VideoStageId)
  //   2. Latest video_stage_transitions.to_stage
  //   3. schedule_items.status (mapped)
  //   4. Default 'script'
  const result = await client.query<{ updated: number }>(`
    WITH staged AS (
      SELECT
        p.id AS project_id,
        prv.stage AS pipeline_stage,
        vst.to_stage AS latest_transition_to_stage,
        si.status AS schedule_status
      FROM projects p
      LEFT JOIN LATERAL (
        SELECT stage
        FROM pipeline_run_videos
        WHERE project_id = p.id
        ORDER BY created_at DESC
        LIMIT 1
      ) prv ON true
      LEFT JOIN LATERAL (
        SELECT to_stage
        FROM video_stage_transitions
        WHERE project_id = p.id
        ORDER BY occurred_at DESC
        LIMIT 1
      ) vst ON true
      LEFT JOIN LATERAL (
        SELECT status
        FROM schedule_items
        WHERE project_id = p.id
        ORDER BY created_at DESC
        LIMIT 1
      ) si ON true
    )
    UPDATE projects p SET current_stage = CASE
      -- Pipeline 'done' → published
      WHEN s.pipeline_stage = 'done' THEN 'published'
      -- Pipeline active stages → mapped VideoStageId
      WHEN s.pipeline_stage IN ('queued', 'generating_idea') THEN 'idea'
      WHEN s.pipeline_stage IN ('generating_script', 'awaiting_script_gate') THEN 'script'
      WHEN s.pipeline_stage IN ('running_qa', 'qa_retry') THEN 'qa'
      WHEN s.pipeline_stage IN ('waiting_narration', 'narration_overdue', 'narration_complete') THEN 'voiceover'
      WHEN s.pipeline_stage = 'generating_production_doc' THEN 'production_doc'
      WHEN s.pipeline_stage = 'generating_thumbnail' THEN 'thumbnail'
      WHEN s.pipeline_stage = 'assigning_to_editor' THEN 'edit'
      WHEN s.pipeline_stage = 'generating_seo' THEN 'seo'
      -- Latest manual transition wins next
      WHEN s.latest_transition_to_stage IN ('idea','script','qa','voiceover','production_doc','thumbnail','edit','seo','scheduled','published') THEN s.latest_transition_to_stage
      -- Schedule status mapping
      WHEN s.schedule_status = 'idea' THEN 'idea'
      WHEN s.schedule_status = 'scripting' THEN 'script'
      WHEN s.schedule_status = 'recording' THEN 'voiceover'
      WHEN s.schedule_status = 'editing' THEN 'edit'
      WHEN s.schedule_status = 'ready' THEN 'seo'
      WHEN s.schedule_status IN ('upload_queue', 'scheduled') THEN 'scheduled'
      WHEN s.schedule_status = 'published' THEN 'published'
      -- Default
      ELSE 'script'
    END
    FROM staged s
    WHERE p.id = s.project_id
  `);

  process.stdout.write(`Done. Updated ${result.rowCount ?? 0} project(s).\n`);
  await client.end();
}

main().catch(err => {
  process.stderr.write(`Backfill failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
