/**
 * Batch-creation entry point — `createPipelineRun`.
 *
 * Two mutually-exclusive modes in v1 (the user explicitly accepted
 * this constraint; mixed mode is a v1.1 ticket if they ask):
 *
 *   - **Fresh** — `countToGenerate > 0`. N videos start at
 *     `stage='queued'` with no idea_id. The orchestrator's first
 *     active stage runs idea-gen for each.
 *
 *   - **Existing** — `existingIdeaIds: string[]`. Each id becomes
 *     one video at `stage='generating_script'` with `idea_id`
 *     pre-populated. The orchestrator skips idea-gen entirely.
 *
 * Mixed input (both non-zero) is rejected with a clear error. The
 * v1 batch is single-mode by design.
 *
 * Priority is 1-indexed within the run. The caller supplies the
 * priority order — for fresh mode that's "the order they should
 * be processed once ideas are generated and ranked"; for existing
 * mode it's the user's drag-rank order from the UI.
 *
 * Workspace tenancy: the preset is loaded with a workspace filter
 * (cross-workspace presets return 404, not 403, per Phase 8.1).
 * Existing-idea ids are verified to belong to the same workspace —
 * a request that names an idea from another workspace gets a
 * "no such idea" error, no existence leak.
 */
import { sql } from '@vercel/postgres';
import { logger } from '../logger';
import { getPresetForWorkspace } from './db';
import type {
  CreatePipelineRunInput,
  CreatePipelineRunResult,
  PipelineStage,
} from './types';

export class CreatePipelineRunError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CreatePipelineRunError';
  }
}

/**
 * Validate the input shape. Pure function — exposed so tests can
 * exercise every rejection path without DB calls.
 */
export function validateCreatePipelineRunInput(
  input: CreatePipelineRunInput,
): { ok: true; mode: 'fresh'; count: number } | { ok: true; mode: 'existing'; ideaIds: string[] } | { ok: false; code: string; message: string } {
  const count = input.countToGenerate ?? 0;
  const ideas = input.existingIdeaIds ?? [];

  if (count === 0 && ideas.length === 0) {
    return { ok: false, code: 'no_input', message: 'Must provide either countToGenerate or existingIdeaIds.' };
  }
  if (count > 0 && ideas.length > 0) {
    return { ok: false, code: 'mixed_mode_not_supported', message: 'Cannot mix countToGenerate with existingIdeaIds in v1. Pick one mode.' };
  }
  if (count < 0 || count > 50) {
    return { ok: false, code: 'count_out_of_range', message: 'countToGenerate must be between 1 and 50.' };
  }
  if (ideas.length > 50) {
    return { ok: false, code: 'too_many_ideas', message: 'existingIdeaIds must have at most 50 entries.' };
  }
  // Dedupe — running the same idea twice in one batch is almost
  // certainly a UI bug; reject loudly rather than create two videos
  // for the same idea.
  if (ideas.length !== new Set(ideas).size) {
    return { ok: false, code: 'duplicate_ideas', message: 'existingIdeaIds must not contain duplicates.' };
  }

  if (count > 0) {
    return { ok: true, mode: 'fresh', count };
  }
  return { ok: true, mode: 'existing', ideaIds: ideas };
}

/**
 * Create a pipeline run + its videos. Returns the run id + the
 * created video ids in priority order (so the UI can deep-link
 * to "rank these ideas").
 */
export async function createPipelineRun(
  input: CreatePipelineRunInput,
): Promise<CreatePipelineRunResult> {
  const validation = validateCreatePipelineRunInput(input);
  if (!validation.ok) {
    throw new CreatePipelineRunError(validation.code, validation.message);
  }

  // Preset must exist and belong to the caller's workspace.
  const preset = await getPresetForWorkspace(input.presetId, input.workspaceId);
  if (!preset) {
    throw new CreatePipelineRunError('preset_not_found', `Preset ${input.presetId} not found in workspace.`);
  }

  // Existing-idea mode: verify every id belongs to this workspace.
  // Cross-workspace ids get the same "not found" error so we don't
  // leak existence (Phase 8.1 pattern).
  let validatedIdeaIds: string[] = [];
  if (validation.mode === 'existing') {
    const { rows } = await sql.query<{ id: string }>(
      `
      SELECT id::text AS id
        FROM video_ideas
       WHERE id = ANY($1::uuid[])
         AND workspace_id = $2::uuid
      `,
      [validation.ideaIds, input.workspaceId],
    );
    const foundIds = new Set(rows.map((r) => r.id));
    const missing = validation.ideaIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new CreatePipelineRunError(
        'idea_not_found',
        `Idea(s) not found in workspace: ${missing.join(', ')}`,
      );
    }
    // Preserve caller's order — Set->Array loses it, and order
    // IS the priority.
    validatedIdeaIds = validation.ideaIds;
  }

  // Count for the pipeline_runs row. For fresh mode it's the
  // count we'll generate; for existing mode it's the array
  // length (same as the eventual video count).
  const ideasCount = validation.mode === 'fresh' ? validation.count : validatedIdeaIds.length;

  // Insert pipeline_runs first, then the video rows in priority
  // order. Done in a transaction so a partial insert can't leave
  // an orphaned run with no videos.
  //
  // For the fresh mode, `status='idea_ranking'` is the initial
  // state — the orchestrator runs idea-gen, then the UI flips it
  // to 'running' after the user drag-ranks. For existing mode the
  // user has already ranked (by ordering the input array), so
  // status goes straight to 'running'.
  const initialStatus = validation.mode === 'fresh' ? 'idea_ranking' : 'running';

  const { rows: runRows } = await sql.query<{ id: string }>(
    `
    INSERT INTO pipeline_runs
      (workspace_id, preset_id, channel_id, ideas_count, status,
       estimated_cost_usd, created_by)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid)
    RETURNING id::text AS id
    `,
    [
      input.workspaceId,
      input.presetId,
      input.channelId ?? null,
      ideasCount,
      initialStatus,
      input.estimatedCostUsd ?? null,
      input.createdBy ?? null,
    ],
  );
  const runId = runRows[0].id;

  // Video rows. The initial stage depends on the mode.
  const initialStage: PipelineStage =
    validation.mode === 'fresh' ? 'queued' : 'generating_script';

  const videoIds: string[] = [];
  if (validation.mode === 'fresh') {
    // N empty rows at queued. The orchestrator's idea-gen handler
    // will set idea_id later.
    for (let i = 0; i < validation.count; i++) {
      const { rows: vRows } = await sql.query<{ id: string }>(
        `
        INSERT INTO pipeline_run_videos
          (workspace_id, pipeline_run_id, priority, stage)
        VALUES ($1::uuid, $2::uuid, $3, $4)
        RETURNING id::text AS id
        `,
        [input.workspaceId, runId, i + 1, initialStage],
      );
      videoIds.push(vRows[0].id);
    }
  } else {
    // Existing-idea mode: each row carries its idea_id from creation.
    for (let i = 0; i < validatedIdeaIds.length; i++) {
      const { rows: vRows } = await sql.query<{ id: string }>(
        `
        INSERT INTO pipeline_run_videos
          (workspace_id, pipeline_run_id, priority, stage, idea_id)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)
        RETURNING id::text AS id
        `,
        [input.workspaceId, runId, i + 1, initialStage, validatedIdeaIds[i]],
      );
      videoIds.push(vRows[0].id);
    }
  }

  logger.info('auto-pipeline: run created', {
    run_id: runId,
    workspace_id: input.workspaceId,
    preset_id: input.presetId,
    mode: validation.mode,
    video_count: videoIds.length,
  });

  return { runId, videoIds };
}
