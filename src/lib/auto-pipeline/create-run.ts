/**
 * Batch-creation entry point — `createPipelineRun`.
 *
 * Three mutually-exclusive modes (the user explicitly accepted
 * the single-mode constraint; mixed mode is a v1.1 ticket if
 * they ask):
 *
 *   - **Fresh** — `countToGenerate > 0`. N videos start at
 *     `stage='queued'` with no idea_id. The orchestrator's first
 *     active stage runs idea-gen for each.
 *
 *   - **Existing** — `existingIdeaIds: string[]`. Each id becomes
 *     one video at `stage='generating_script'` with `idea_id`
 *     pre-populated. The orchestrator skips idea-gen entirely.
 *
 *   - **Scheduled** — `existingScheduleItemIds: string[]`. Each
 *     schedule item is resolved to a video_ideas row (reusing
 *     `idea_id` when present, auto-creating one from the item's
 *     `title` + `notes` when not), then proceeds exactly like the
 *     Existing mode. After insertion, each schedule item is bumped
 *     from `idea` → `scripting` (never regressing a more advanced
 *     status) and linked back via
 *     `schedule_items.pipeline_run_video_id`.
 *
 * Mixed input (more than one mode non-zero) is rejected with a
 * clear error. The batch is single-mode by design.
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
):
  | { ok: true; mode: 'fresh'; count: number }
  | { ok: true; mode: 'existing'; ideaIds: string[] }
  | { ok: true; mode: 'scheduled'; scheduleItemIds: string[] }
  | { ok: false; code: string; message: string } {
  const count = input.countToGenerate ?? 0;
  const ideas = input.existingIdeaIds ?? [];
  const scheduled = input.existingScheduleItemIds ?? [];

  // Range/size checks run BEFORE the mode-count check so a malformed
  // input (negative count, oversized list) reports the precise reason
  // even when it also looks like "no mode supplied".
  if (count < 0 || count > 50) {
    return { ok: false, code: 'count_out_of_range', message: 'countToGenerate must be between 1 and 50.' };
  }
  if (ideas.length > 50) {
    return { ok: false, code: 'too_many_ideas', message: 'existingIdeaIds must have at most 50 entries.' };
  }
  if (scheduled.length > 50) {
    return {
      ok: false,
      code: 'too_many_schedule_items',
      message: 'existingScheduleItemIds must have at most 50 entries.',
    };
  }
  // Dedupe — running the same idea/item twice in one batch is almost
  // certainly a UI bug; reject loudly rather than create two videos
  // for the same source.
  if (ideas.length !== new Set(ideas).size) {
    return { ok: false, code: 'duplicate_ideas', message: 'existingIdeaIds must not contain duplicates.' };
  }
  if (scheduled.length !== new Set(scheduled).size) {
    return {
      ok: false,
      code: 'duplicate_schedule_items',
      message: 'existingScheduleItemIds must not contain duplicates.',
    };
  }

  // After per-field validation, enforce the single-mode constraint.
  const modesProvided = [count > 0, ideas.length > 0, scheduled.length > 0].filter(Boolean).length;
  if (modesProvided === 0) {
    return {
      ok: false,
      code: 'no_input',
      message: 'Must provide countToGenerate, existingIdeaIds, or existingScheduleItemIds.',
    };
  }
  if (modesProvided > 1) {
    return {
      ok: false,
      code: 'mixed_mode_not_supported',
      message: 'Cannot mix fresh/existing/scheduled modes in one batch. Pick one mode.',
    };
  }

  if (count > 0) {
    return { ok: true, mode: 'fresh', count };
  }
  if (ideas.length > 0) {
    return { ok: true, mode: 'existing', ideaIds: ideas };
  }
  return { ok: true, mode: 'scheduled', scheduleItemIds: scheduled };
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

  // Scheduled mode: load each schedule item (workspace-scoped),
  // reuse its idea_id when present, otherwise auto-create a
  // video_ideas row from the item's title + notes and write the
  // new id back to schedule_items.idea_id.
  //
  // The scheduled→video_id mapping is kept (parallel array to
  // validatedIdeaIds, same order) so we can link the schedule
  // items to the pipeline_run_videos rows once they're inserted.
  let scheduledItemForVideo: Array<{ scheduleItemId: string; currentStatus: string }> = [];
  let autoCreatedIdeas = 0;
  if (validation.mode === 'scheduled') {
    const { rows } = await sql.query<{
      id: string;
      title: string;
      status: string;
      notes: string | null;
      idea_id: string | null;
    }>(
      `
      SELECT id::text AS id,
             title,
             status,
             notes,
             idea_id::text AS idea_id
        FROM schedule_items
       WHERE id = ANY($1::uuid[])
         AND workspace_id = $2::uuid
      `,
      [validation.scheduleItemIds, input.workspaceId],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = validation.scheduleItemIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new CreatePipelineRunError(
        'schedule_item_not_found',
        `Schedule item(s) not found in workspace: ${missing.join(', ')}`,
      );
    }

    // Resolve each schedule item in caller-supplied priority order.
    for (const sid of validation.scheduleItemIds) {
      const item = byId.get(sid)!;
      let ideaId = item.idea_id;
      if (!ideaId) {
        const title = (item.title || '').trim() || 'Untitled scheduled item';
        const { rows: insRows } = await sql.query<{ id: string }>(
          `
          INSERT INTO video_ideas
            (niche, title, hook, is_saved, workspace_id)
          VALUES ($1, $2, $3, true, $4::uuid)
          RETURNING id::text AS id
          `,
          [preset.niche ?? '', title, item.notes ?? '', input.workspaceId],
        );
        ideaId = insRows[0].id;
        await sql.query(
          `UPDATE schedule_items
              SET idea_id = $1::uuid,
                  updated_at = NOW()
            WHERE id = $2::uuid
              AND workspace_id = $3::uuid`,
          [ideaId, sid, input.workspaceId],
        );
        autoCreatedIdeas++;
      }
      validatedIdeaIds.push(ideaId);
      scheduledItemForVideo.push({ scheduleItemId: sid, currentStatus: item.status });
    }
  }

  // Count for the pipeline_runs row. For fresh mode it's the
  // count we'll generate; for existing/scheduled modes it's the
  // array length (same as the eventual video count).
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
    // Existing-idea + scheduled modes share this path: each row carries
    // its idea_id from creation.
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

  // Scheduled mode: link each schedule item back to its
  // pipeline_run_videos row and bump its status to 'scripting'
  // (only when currently 'idea' — never regress more advanced
  // statuses). Done after video inserts so the FK target exists.
  let advancedStatuses = 0;
  if (validation.mode === 'scheduled') {
    for (let i = 0; i < scheduledItemForVideo.length; i++) {
      const { scheduleItemId, currentStatus } = scheduledItemForVideo[i];
      const videoId = videoIds[i];
      const shouldAdvance = currentStatus === 'idea';
      const { rowCount } = await sql.query(
        `
        UPDATE schedule_items
           SET pipeline_run_video_id = $1::uuid,
               status = CASE WHEN status = 'idea' THEN 'scripting' ELSE status END,
               stage_entered_at = CASE WHEN status = 'idea' THEN NOW() ELSE stage_entered_at END,
               updated_at = NOW()
         WHERE id = $2::uuid
           AND workspace_id = $3::uuid
        `,
        [videoId, scheduleItemId, input.workspaceId],
      );
      if (shouldAdvance && (rowCount ?? 0) > 0) advancedStatuses++;
    }
  }

  logger.info('auto-pipeline: run created', {
    run_id: runId,
    workspace_id: input.workspaceId,
    preset_id: input.presetId,
    mode: validation.mode,
    video_count: videoIds.length,
    auto_created_ideas: autoCreatedIdeas,
    advanced_statuses: advancedStatuses,
  });

  return { runId, videoIds };
}
