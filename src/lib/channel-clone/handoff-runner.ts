/**
 * Channel-clone handoff runner.
 *
 * Promotes a rowified channel-clone job into the existing auto-
 * pipeline so the regular image-gen → thumbnail → SEO → editor
 * flow can take over. The handoff:
 *
 *   1. Picks the workspace's first pipeline_preset (v1 simplification —
 *      a future iteration can let the user pick).
 *   2. Creates a `projects` row (title, niche, topic, draft status).
 *   3. Creates a `scripts` row (version 1, active, content = approved
 *      script text).
 *   4. Creates a stub `video_ideas` row — the auto-pipeline schema
 *      requires idea_id semantically even though downstream stages
 *      don't read it on the continue path.
 *   5. Creates a `pipeline_runs` row (status='running').
 *   6. Creates a `pipeline_run_videos` row directly at stage
 *      `generating_production_doc_images` — we already have the doc
 *      so we skip narration_complete + generating_production_doc.
 *   7. Persists the rowified doc onto `pipeline_stage_artefacts` at
 *      stage='generating_production_doc' so the image-gen handler
 *      reads it on its next claim.
 *
 * The cron's next tick picks up the video, finds the production_doc
 * artefact, and runs `generate-production-doc-images.ts` against
 * our rows. From there it's just the existing pipeline.
 *
 * Re-handoff is supported: each call creates a new pipeline_run +
 * pipeline_run_videos pair. The previous `state.handoff` (if any)
 * gets pushed onto `state.handoffHistory` and `state.handoff` is
 * overwritten with the new record. The old pipeline_run_video keeps
 * running on its own — the cron doesn't care that the channel-clone
 * job re-pointed elsewhere. The user might want the old run dead;
 * that's a manual auto-pipeline action.
 */

import { createClient } from '@vercel/postgres';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import { countWords, estimateDuration } from '@/lib/utils';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
  setChannelCloneJobStatus,
} from './job-store';
import type { ChannelCloneJobState } from './types';

export interface RunHandoffOptions {
  jobId: string;
  workspaceId: string;
  userId: string;
  /** Optional explicit preset id override. When omitted the runner
   *  picks the workspace's first preset by created_at. */
  presetId?: string;
}

export interface HandoffResult {
  pipelineRunId: string;
  pipelineRunVideoId: string;
  projectId: string;
  scriptId: string;
  ideaId: string;
  presetId: string;
  handedOffAt: string;
}

export async function runHandoff(opts: RunHandoffOptions): Promise<void> {
  const { jobId, workspaceId, userId } = opts;
  logger.info('[channel-clone handoff] start', { jobId, workspaceId, userId });
  await setChannelCloneJobStatus(jobId, workspaceId, 'handoff_running');

  const job = await getChannelCloneJob(jobId, workspaceId);
  if (!job) {
    logger.error('[channel-clone handoff] job missing', { jobId });
    return;
  }
  const { analysis, topics, hooks, selectedTopicIndex, selectedHookIndex, approvedScript, productionRows, chosenStylePresetId, intake } = job.state_jsonb;
  if (!analysis || !approvedScript || !productionRows || productionRows.length === 0 || !chosenStylePresetId) {
    return failJob(jobId, workspaceId, 'Cannot hand off: analysis + approvedScript + productionRows + chosenStylePresetId are all required.');
  }
  if (!topics || !selectedTopicIndex || !hooks || !selectedHookIndex) {
    return failJob(jobId, workspaceId, 'Cannot hand off: a topic + hook must have been selected.');
  }

  const topic = topics[selectedTopicIndex - 1];
  const hook = hooks[selectedHookIndex - 1];

  // 1. Pick a preset. The user can supply one explicitly; otherwise
  //    we take the workspace's first preset by created_at. No preset
  //    → typed error so the user sees what to do.
  let presetId: string;
  if (opts.presetId) {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id::text AS id FROM pipeline_presets WHERE id = $1::uuid AND workspace_id = $2::uuid LIMIT 1`,
      [opts.presetId, workspaceId],
    );
    if (rows.length === 0) {
      return failJob(jobId, workspaceId, `Pipeline preset ${opts.presetId} not found in this workspace.`);
    }
    presetId = rows[0].id;
  } else {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id::text AS id FROM pipeline_presets WHERE workspace_id = $1::uuid ORDER BY created_at ASC LIMIT 1`,
      [workspaceId],
    );
    if (rows.length === 0) {
      return failJob(jobId, workspaceId, 'No pipeline presets in this workspace. Create one in Auto-pipeline → Presets first.');
    }
    presetId = rows[0].id;
  }
  logger.info('[channel-clone handoff] preset resolved', { jobId, presetId });

  // 2-7. Insert all the rows inside a single transaction. Prior to the
  // 2026-06-05 QA pass this was a sequential series of `sql.query`
  // calls with a misleading comment claiming "@vercel/postgres
  // doesn't expose BEGIN/COMMIT cleanly" — it does (see
  // `src/lib/migrations/index.ts:291` for the existing pattern).
  // Without a transaction, a failed pipeline_run_videos insert at
  // step 5 of 6 would leave orphaned projects + scripts + ideas +
  // pipeline_runs rows with no way to roll them back. Now: BEGIN
  // before insert 1; COMMIT after persistArtefact; ROLLBACK on any
  // throw.
  const connectionString =
    process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) {
    return failJob(jobId, workspaceId, 'POSTGRES_URL not configured — cannot start handoff transaction.');
  }
  const client = createClient({ connectionString });
  await client.connect();

  const projectTitle = `Channel clone — ${topic.title}`.slice(0, 200);
  const projectNiche = analysis.niche;
  const projectTopic = topic.title;

  let projectId: string;
  let scriptId: string;
  let ideaId: string;
  let pipelineRunId: string;
  let pipelineRunVideoId: string;
  try {
    await client.query('BEGIN');

    const { rows: projRows } = await client.query<{ id: string }>(
      `
      INSERT INTO projects (workspace_id, title, niche, topic, status)
      VALUES ($1::uuid, $2, $3, $4, 'draft')
      RETURNING id::text AS id
      `,
      [workspaceId, projectTitle, projectNiche, projectTopic],
    );
    projectId = projRows[0].id;

    const scriptText = approvedScript.text;
    const wordCount = countWords(scriptText);
    const durationSec = estimateDuration(wordCount);
    // Stamp the actual model that produced the audit-approved script
    // (resolved from auditHistory's modelUsed if present), not the
    // hardcoded string the original commit used.
    const auditModel = job.state_jsonb.analysis?.modelUsed ?? 'claude-opus-4-8';
    const { rows: scriptRows } = await client.query<{ id: string }>(
      `
      INSERT INTO scripts (project_id, version, content, word_count, estimated_duration_seconds, ai_model, is_active, workspace_id)
      VALUES ($1::uuid, 1, $2, $3, $4, $5, true, $6::uuid)
      RETURNING id::text AS id
      `,
      [projectId, scriptText, wordCount, durationSec, `${auditModel} (channel-clone)`, workspaceId],
    );
    scriptId = scriptRows[0].id;

    const { rows: ideaRows } = await client.query<{ id: string }>(
      `
      INSERT INTO video_ideas (niche, title, hook, is_saved, workspace_id)
      VALUES ($1, $2, $3, true, $4::uuid)
      RETURNING id::text AS id
      `,
      [analysis.niche, topic.title.slice(0, 200), hook.text.slice(0, 500), workspaceId],
    );
    ideaId = ideaRows[0].id;

    const { rows: runRows } = await client.query<{ id: string }>(
      `
      INSERT INTO pipeline_runs (workspace_id, preset_id, ideas_count, status, created_by)
      VALUES ($1::uuid, $2::uuid, 1, 'running', $3::uuid)
      RETURNING id::text AS id
      `,
      [workspaceId, presetId, userId],
    );
    pipelineRunId = runRows[0].id;

    const { rows: vidRows } = await client.query<{ id: string }>(
      `
      INSERT INTO pipeline_run_videos
        (workspace_id, pipeline_run_id, priority, stage, idea_id, project_id, script_id)
      VALUES ($1::uuid, $2::uuid, 1, 'generating_production_doc_images', $3::uuid, $4::uuid, $5::uuid)
      RETURNING id::text AS id
      `,
      [workspaceId, pipelineRunId, ideaId, projectId, scriptId],
    );
    pipelineRunVideoId = vidRows[0].id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    return failJob(jobId, workspaceId, `Handoff transaction failed during row inserts: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Compose the production-doc artefact metadata. The image-gen
  // stage reads `metadata.doc.rows[i].ai_image_prompt` — that's the
  // minimum contract. We also surface `style_id` so the style suffix
  // gets injected on each image gen call, plus a few summary fields
  // (title, niche, total_words) for the editor UI's headers.
  const docMetadata = {
    doc: {
      title: topic.title,
      niche: analysis.niche,
      style_id: chosenStylePresetId,
      total_words: approvedScript.wordCount,
      speaking_pace_wpm: Math.round(analysis.wpsEstimate * 60),
      // Map channel-clone rows into the minimal shape the existing
      // image-gen stage expects. image_url empty so the stage knows
      // to generate.
      rows: productionRows.map((r) => ({
        timecode: r.timecode,
        script_text: r.script_text,
        visual_type: r.visual_type,
        visual_description: r.visual_description,
        stock_search_terms: r.stock_search_terms,
        ai_image_prompt: r.ai_image_prompt,
        on_screen_text: r.on_screen_text,
        notes: r.notes,
        image_url: '',
      })),
    },
    channel_clone: {
      job_id: jobId,
      source_channel_url: intake?.sourceChannelUrl ?? null,
      source_channel_name: intake?.sourceChannelName ?? null,
      selected_topic_index: selectedTopicIndex,
      selected_hook_index: selectedHookIndex,
      audit_overall_score: approvedScript.finalScore,
    },
  };

  try {
    await client.query(
      `
      INSERT INTO pipeline_stage_artefacts
        (pipeline_run_video_id, stage, attempt_number, artefact_kind, cost_usd, metadata_jsonb)
      VALUES ($1::uuid, 'generating_production_doc', 1, 'production_doc', 0, $2::jsonb)
      ON CONFLICT (pipeline_run_video_id, stage, attempt_number, artefact_kind) DO NOTHING
      `,
      [pipelineRunVideoId, JSON.stringify(docMetadata)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    return failJob(jobId, workspaceId, `Handoff transaction failed at production_doc artefact persistence: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // end() is idempotent on already-ended clients; guarding the
    // ROLLBACK path above means this only fires on the success path.
    await client.end().catch(() => {});
  }

  const result: HandoffResult = {
    pipelineRunId,
    pipelineRunVideoId,
    projectId,
    scriptId,
    ideaId,
    presetId,
    handedOffAt: new Date().toISOString(),
  };

  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) return;
  // Push the prior handoff (if any) onto history before overwriting
  // state.handoff. Older runs stay queryable in the UI's
  // handoff-history view; the auto-pipeline still owns them.
  const nextHistory = [
    ...(fresh.state_jsonb.handoffHistory ?? []),
    ...(fresh.state_jsonb.handoff ? [fresh.state_jsonb.handoff] : []),
  ];
  const nextState: ChannelCloneJobState = {
    ...fresh.state_jsonb,
    handoff: result,
    handoffHistory: nextHistory.length > 0 ? nextHistory : undefined,
  };
  await replaceChannelCloneJobState(jobId, workspaceId, nextState);
  await setChannelCloneJobStatus(jobId, workspaceId, 'handoff_complete');
  logger.info('[channel-clone handoff] done', {
    jobId,
    pipelineRunVideoId,
    projectId,
    scriptId,
    ideaId,
    presetId,
    rowCount: productionRows.length,
  });
}

async function failJob(jobId: string, workspaceId: string, message: string): Promise<void> {
  logger.error('[channel-clone handoff] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'handoff_failed', { lastError: message });
}
