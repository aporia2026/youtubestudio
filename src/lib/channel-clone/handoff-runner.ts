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
 * Re-handoff is blocked: if `state_jsonb.handoff` is already set,
 * the runner short-circuits with a friendly error so we don't end
 * up with two parallel pipeline_run_videos for one channel-clone job.
 */

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
  const { analysis, topics, hooks, selectedTopicIndex, selectedHookIndex, approvedScript, productionRows, chosenStylePresetId, intake, handoff } = job.state_jsonb;
  if (handoff) {
    return failJob(jobId, workspaceId, `Already handed off (pipeline_run_video ${handoff.pipelineRunVideoId}). Delete or re-rowify before handing off again.`);
  }
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

  // 2-7. Insert all the rows. Done sequentially because we need
  // each FK chain — no transaction wrapper because @vercel/postgres
  // doesn't expose BEGIN/COMMIT cleanly from a function-level call.
  // The handoff is idempotent at the channel-clone level (we check
  // for an existing handoff above), so a partial-write recovery is
  // a manual cleanup rather than a code path.

  const projectTitle = `Channel clone — ${topic.title}`.slice(0, 200);
  const projectNiche = analysis.niche;
  const projectTopic = topic.title;

  const { rows: projRows } = await sql.query<{ id: string }>(
    `
    INSERT INTO projects (workspace_id, title, niche, topic, status)
    VALUES ($1::uuid, $2, $3, $4, 'draft')
    RETURNING id::text AS id
    `,
    [workspaceId, projectTitle, projectNiche, projectTopic],
  );
  const projectId = projRows[0].id;

  const scriptText = approvedScript.text;
  const wordCount = countWords(scriptText);
  const durationSec = estimateDuration(wordCount);
  const { rows: scriptRows } = await sql.query<{ id: string }>(
    `
    INSERT INTO scripts (project_id, version, content, word_count, estimated_duration_seconds, ai_model, is_active, workspace_id)
    VALUES ($1::uuid, 1, $2, $3, $4, $5, true, $6::uuid)
    RETURNING id::text AS id
    `,
    [projectId, scriptText, wordCount, durationSec, 'claude-opus-4-8 (channel-clone)', workspaceId],
  );
  const scriptId = scriptRows[0].id;

  // Stub idea row. Hook + title from the chosen topic + hook so a
  // human glancing at the auto-pipeline dashboard sees a meaningful
  // label rather than "Untitled".
  const { rows: ideaRows } = await sql.query<{ id: string }>(
    `
    INSERT INTO video_ideas (niche, title, hook, is_saved, workspace_id)
    VALUES ($1, $2, $3, true, $4::uuid)
    RETURNING id::text AS id
    `,
    [analysis.niche, topic.title.slice(0, 200), hook.text.slice(0, 500), workspaceId],
  );
  const ideaId = ideaRows[0].id;

  const { rows: runRows } = await sql.query<{ id: string }>(
    `
    INSERT INTO pipeline_runs (workspace_id, preset_id, ideas_count, status, created_by)
    VALUES ($1::uuid, $2::uuid, 1, 'running', $3::uuid)
    RETURNING id::text AS id
    `,
    [workspaceId, presetId, userId],
  );
  const pipelineRunId = runRows[0].id;

  const { rows: vidRows } = await sql.query<{ id: string }>(
    `
    INSERT INTO pipeline_run_videos
      (workspace_id, pipeline_run_id, priority, stage, idea_id, project_id, script_id)
    VALUES ($1::uuid, $2::uuid, 1, 'generating_production_doc_images', $3::uuid, $4::uuid, $5::uuid)
    RETURNING id::text AS id
    `,
    [workspaceId, pipelineRunId, ideaId, projectId, scriptId],
  );
  const pipelineRunVideoId = vidRows[0].id;

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

  await sql.query(
    `
    INSERT INTO pipeline_stage_artefacts
      (pipeline_run_video_id, stage, attempt_number, artefact_kind, cost_usd, metadata_jsonb)
    VALUES ($1::uuid, 'generating_production_doc', 1, 'production_doc', 0, $2::jsonb)
    ON CONFLICT (pipeline_run_video_id, stage, attempt_number, artefact_kind) DO NOTHING
    `,
    [pipelineRunVideoId, JSON.stringify(docMetadata)],
  );

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
  const nextState: ChannelCloneJobState = {
    ...fresh.state_jsonb,
    handoff: result,
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
