/**
 * User-facing actions on pipeline rows.
 *
 * The orchestrator advances rows along the state machine
 * automatically. These functions handle the **human** transitions
 * — script-gate decisions, kills, narration callbacks, deadline
 * extensions, etc. Each is workspace-scoped and idempotent where
 * it makes sense.
 *
 * Errors are thrown — the route handlers catch and translate to
 * HTTP responses.
 */
import { sql } from '@vercel/postgres';
import { logger } from '../logger';
import type { PipelineStage } from './types';
import { isPipelineStage, TERMINAL_STAGES } from './types';

export class PipelineActionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PipelineActionError';
  }
}

// ─── Script-gate decision ───────────────────────────────────────────

export type ScriptGateDecision = 'keep' | 'regenerate' | 'kill';

/**
 * Apply the user's script-gate decision. Idempotent for `keep` and
 * `kill` (re-applying the same decision is a no-op). `regenerate`
 * is NOT idempotent — each call routes back to `generating_script`
 * and increments retry_count by 1, so the cron picks it up + runs
 * another script-gen pass.
 *
 * Returns the new stage so the caller can echo it back.
 */
export async function applyScriptGateDecision(args: {
  workspaceId: string;
  videoId: string;
  decision: ScriptGateDecision;
}): Promise<{ newStage: PipelineStage }> {
  const { workspaceId, videoId, decision } = args;

  // Load + validate the current stage. Workspace-scoped.
  const { rows } = await sql.query<{ stage: string; retry_count: number }>(
    `
    SELECT stage, retry_count
      FROM pipeline_run_videos
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [videoId, workspaceId],
  );
  if (rows.length === 0) {
    throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
  }
  const current = rows[0].stage;

  if (current !== 'awaiting_script_gate') {
    throw new PipelineActionError(
      'wrong_stage',
      `Script-gate decision only valid at stage 'awaiting_script_gate'; video is at '${current}'.`,
    );
  }

  let newStage: PipelineStage;
  if (decision === 'keep') {
    newStage = 'running_qa';
    await sql`
      UPDATE pipeline_run_videos
         SET stage = ${newStage}, updated_at = NOW()
       WHERE id = ${videoId}::uuid AND workspace_id = ${workspaceId}::uuid
         AND stage = 'awaiting_script_gate'
    `;
  } else if (decision === 'regenerate') {
    newStage = 'generating_script';
    // Bump retry_count so the spend log + UI show the regen
    // history. The handler reads retry_count to vary prompt seeds
    // on a regen.
    await sql`
      UPDATE pipeline_run_videos
         SET stage = ${newStage},
             retry_count = retry_count + 1,
             updated_at = NOW()
       WHERE id = ${videoId}::uuid AND workspace_id = ${workspaceId}::uuid
         AND stage = 'awaiting_script_gate'
    `;
  } else {
    // kill
    newStage = 'cancelled_by_user';
    await sql`
      UPDATE pipeline_run_videos
         SET stage = ${newStage},
             failure_class = 'user_killed_at_gate',
             failure_message = 'User killed video at the script gate.',
             updated_at = NOW()
       WHERE id = ${videoId}::uuid AND workspace_id = ${workspaceId}::uuid
         AND stage = 'awaiting_script_gate'
    `;
  }

  logger.info('auto-pipeline: script-gate decision applied', {
    pipeline_video_id: videoId,
    decision,
    from_stage: 'awaiting_script_gate',
    to_stage: newStage,
  });

  return { newStage };
}

// ─── Kill anywhere ──────────────────────────────────────────────────

/**
 * Cancel a video from any non-terminal stage. Safe to call on a
 * row that's already terminal — returns the existing terminal
 * state instead of erroring (caller may have raced with the cron).
 */
export async function killVideo(args: {
  workspaceId: string;
  videoId: string;
  reason?: string;
}): Promise<{ stage: PipelineStage }> {
  const { workspaceId, videoId, reason } = args;
  const { rows } = await sql.query<{ stage: string }>(
    `
    SELECT stage FROM pipeline_run_videos
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [videoId, workspaceId],
  );
  if (rows.length === 0) {
    throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
  }
  const current = rows[0].stage;
  if (isPipelineStage(current) && TERMINAL_STAGES.has(current)) {
    return { stage: current };
  }
  await sql`
    UPDATE pipeline_run_videos
       SET stage = 'cancelled_by_user',
           failure_class = 'user_cancelled',
           failure_message = ${reason ?? 'Cancelled by user.'},
           updated_at = NOW()
     WHERE id = ${videoId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return { stage: 'cancelled_by_user' };
}

// ─── Narration callbacks ────────────────────────────────────────────

/**
 * Flip a row from `waiting_narration` (or `narration_overdue`) to
 * `narration_complete`. Idempotent — calling on a row already
 * past this transition is a no-op.
 *
 * This is the function the narrator-portal approval callback will
 * call when the last take is approved. For now (no portal
 * integration), it can be invoked manually from a `/pipeline`
 * action button.
 */
export async function markNarrationComplete(args: {
  workspaceId: string;
  videoId: string;
}): Promise<{ stage: PipelineStage }> {
  const { workspaceId, videoId } = args;
  const { rows } = await sql.query<{ stage: string }>(
    `
    UPDATE pipeline_run_videos
       SET stage = 'narration_complete',
           updated_at = NOW()
     WHERE id = $1::uuid AND workspace_id = $2::uuid
       AND stage IN ('waiting_narration', 'narration_overdue')
    RETURNING stage
    `,
    [videoId, workspaceId],
  );
  if (rows.length === 0) {
    // Either not found or already past — return current state.
    const { rows: nowRows } = await sql.query<{ stage: string }>(
      `SELECT stage FROM pipeline_run_videos WHERE id = $1::uuid AND workspace_id = $2::uuid`,
      [videoId, workspaceId],
    );
    if (nowRows.length === 0) {
      throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
    }
    if (!isPipelineStage(nowRows[0].stage)) {
      throw new PipelineActionError('bad_stage', `Stage "${nowRows[0].stage}" is invalid.`);
    }
    return { stage: nowRows[0].stage };
  }
  return { stage: 'narration_complete' };
}

/**
 * Push the narration deadline forward. Caller specifies extra
 * days from "now"; the new deadline = now + days.
 */
export async function extendNarrationDeadline(args: {
  workspaceId: string;
  videoId: string;
  days: number;
}): Promise<{ newDeadline: Date }> {
  const { workspaceId, videoId, days } = args;
  if (days < 1 || days > 90) {
    throw new PipelineActionError('out_of_range', 'days must be between 1 and 90.');
  }
  const newDeadline = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const { rowCount } = await sql.query(
    `
    UPDATE pipeline_run_videos
       SET narration_deadline_at = $3::timestamptz,
           stage = CASE WHEN stage = 'narration_overdue' THEN 'waiting_narration' ELSE stage END,
           updated_at = NOW()
     WHERE id = $1::uuid AND workspace_id = $2::uuid
       AND stage IN ('waiting_narration', 'narration_overdue')
    `,
    [videoId, workspaceId, newDeadline.toISOString()],
  );
  if (!rowCount) {
    throw new PipelineActionError('wrong_stage', 'Video is not in a waiting_narration / narration_overdue state.');
  }
  return { newDeadline };
}

export async function abandonNarration(args: {
  workspaceId: string;
  videoId: string;
}): Promise<{ stage: PipelineStage }> {
  const { workspaceId, videoId } = args;
  const { rowCount } = await sql.query(
    `
    UPDATE pipeline_run_videos
       SET stage = 'narration_abandoned',
           failure_class = 'narration_abandoned',
           failure_message = 'User abandoned the narration step.',
           updated_at = NOW()
     WHERE id = $1::uuid AND workspace_id = $2::uuid
       AND stage IN ('waiting_narration', 'narration_overdue')
    `,
    [videoId, workspaceId],
  );
  if (!rowCount) {
    throw new PipelineActionError('wrong_stage', 'Video is not in a waiting_narration / narration_overdue state.');
  }
  return { stage: 'narration_abandoned' };
}

// ─── Run-level: commit drag-rank ────────────────────────────────────

/**
 * After the user drag-ranks the generated ideas, this commits the
 * new priority order onto the existing pipeline_run_videos rows
 * and flips the parent run from `idea_ranking` to `running`. The
 * cron then starts draining (per-video stages were already at
 * `generating_script` once idea-gen finished — they just had
 * priorities the user might want to reorder).
 *
 * Validates that `orderedVideoIds` covers every video in the run
 * exactly once (no missing, no extras). Order in the array IS the
 * new priority (1-indexed).
 */
export async function commitRanking(args: {
  workspaceId: string;
  runId: string;
  orderedVideoIds: string[];
}): Promise<void> {
  const { workspaceId, runId, orderedVideoIds } = args;

  // Confirm run exists, is in idea_ranking, and orderedVideoIds
  // exactly matches the video set.
  const { rows: runRows } = await sql.query<{ id: string; status: string }>(
    `SELECT id::text AS id, status FROM pipeline_runs WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [runId, workspaceId],
  );
  if (runRows.length === 0) {
    throw new PipelineActionError('run_not_found', `Pipeline run ${runId} not found.`);
  }
  if (runRows[0].status !== 'idea_ranking') {
    throw new PipelineActionError(
      'wrong_status',
      `Ranking can only be committed while status='idea_ranking'; current='${runRows[0].status}'.`,
    );
  }

  const { rows: videoRows } = await sql.query<{ id: string }>(
    `SELECT id::text AS id FROM pipeline_run_videos WHERE pipeline_run_id = $1::uuid AND workspace_id = $2::uuid`,
    [runId, workspaceId],
  );
  const videoSet = new Set(videoRows.map((r) => r.id));
  const orderedSet = new Set(orderedVideoIds);
  if (orderedSet.size !== orderedVideoIds.length) {
    throw new PipelineActionError('duplicate_ids', 'orderedVideoIds must not contain duplicates.');
  }
  if (orderedSet.size !== videoSet.size) {
    throw new PipelineActionError(
      'mismatched_count',
      `orderedVideoIds has ${orderedSet.size} entries; run has ${videoSet.size} videos.`,
    );
  }
  for (const id of orderedVideoIds) {
    if (!videoSet.has(id)) {
      throw new PipelineActionError('unknown_video', `Video ${id} is not part of run ${runId}.`);
    }
  }

  // Two-step update. First, shift all priorities into a
  // negative range so the unique (pipeline_run_id, priority)
  // constraint doesn't collide during the second pass. Then
  // apply the new priorities.
  await sql`
    UPDATE pipeline_run_videos
       SET priority = -priority
     WHERE pipeline_run_id = ${runId}::uuid
       AND workspace_id = ${workspaceId}::uuid
  `;
  for (let i = 0; i < orderedVideoIds.length; i++) {
    await sql`
      UPDATE pipeline_run_videos
         SET priority = ${i + 1}
       WHERE id = ${orderedVideoIds[i]}::uuid
         AND workspace_id = ${workspaceId}::uuid
    `;
  }
  // Note: pipeline_runs has no updated_at column today (the
  // status mutation is observable via the per-video updated_at
  // timestamps and the completed_at column for terminal runs).
  await sql`
    UPDATE pipeline_runs
       SET status = 'running'
     WHERE id = ${runId}::uuid
       AND workspace_id = ${workspaceId}::uuid
  `;
}
