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

// ─── Retry (stuck + terminal failure recovery) ──────────────────────

/**
 * Maps a terminal failure stage to the stage we reset to so the
 * orchestrator picks the video up and re-runs it. `narration_abandoned`
 * is intentionally absent — retrying narration requires a fresh
 * deadline, so the UI sends the user to `extendNarrationDeadline`
 * instead of treating it as a regular retry.
 *
 * `cost_cap_exceeded` and `cancelled_by_user` both reset to
 * `generating_script` because by the time the user clicks retry,
 * either the cap was lifted or the cancel was a mistake — either
 * way, starting from script regeneration is the safe re-entry point.
 */
const TERMINAL_RETRY_TARGET: Record<string, PipelineStage> = {
  qa_failed_after_max_retries: 'generating_script',
  production_doc_failed: 'generating_production_doc',
  thumbnail_failed: 'generating_thumbnail',
  editor_assignment_failed: 'assigning_to_editor',
  seo_failed: 'generating_seo',
  cancelled_by_user: 'generating_script',
  cost_cap_exceeded: 'generating_script',
};

/** How long a claimed_at can sit without movement before we treat
 *  it as a zombie claim from a crashed handler. The cron's max
 *  execution time is 300s; 5min covers the worst-case handler. */
const ZOMBIE_CLAIM_AGE_SEC = 5 * 60;

export type RetryOutcome =
  | { action: 'reset_terminal'; fromStage: string; toStage: PipelineStage }
  | { action: 'cleared_zombie_claim'; stage: string; claimAgeSec: number }
  | { action: 'noop'; stage: string; reason: string };

/**
 * Make a video re-runnable. Three cases the user might hit:
 *
 *   1. Terminal failure → reset to the stage that should retry it,
 *      clear failure metadata, bump retry_count. Cron picks it up
 *      on the next tick.
 *
 *   2. Non-terminal but `claimed_at` is old (handler crashed before
 *      it could release the row) → clear claimed_at + claimed_by_tick
 *      so the cron's SKIP LOCKED query stops skipping it.
 *
 *   3. Non-terminal, no zombie claim → noop. The cron will pick it
 *      up on the next tick anyway; nothing to fix here. The UI
 *      should hide the Retry button in this case, but we tolerate
 *      it being clicked.
 *
 * `narration_abandoned` cannot be retried this way (extend deadline
 * + mark complete is the right path); we throw a clear error so the
 * UI knows not to offer Retry on those rows.
 */
export async function retryVideo(args: {
  workspaceId: string;
  videoId: string;
}): Promise<RetryOutcome> {
  const { workspaceId, videoId } = args;
  const { rows } = await sql.query<{
    stage: string;
    claimed_at: string | null;
    updated_at: string;
  }>(
    `
    SELECT stage, claimed_at::text AS claimed_at, updated_at::text AS updated_at
      FROM pipeline_run_videos
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [videoId, workspaceId],
  );
  if (rows.length === 0) {
    throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
  }
  const { stage, claimed_at } = rows[0];

  if (stage === 'narration_abandoned') {
    throw new PipelineActionError(
      'unretryable',
      'narration_abandoned cannot be retried directly. Extend the deadline and mark narration complete.',
    );
  }

  // Case 1: terminal failure → reset.
  const target = TERMINAL_RETRY_TARGET[stage];
  if (target) {
    await sql.query(
      `
      UPDATE pipeline_run_videos
         SET stage = $1,
             failure_class = NULL,
             failure_message = NULL,
             claimed_at = NULL,
             claimed_by_tick = NULL,
             retry_count = retry_count + 1,
             updated_at = NOW()
       WHERE id = $2::uuid AND workspace_id = $3::uuid
      `,
      [target, videoId, workspaceId],
    );
    logger.info('auto-pipeline: video reset for retry', {
      pipeline_video_id: videoId,
      from_stage: stage,
      to_stage: target,
    });
    return { action: 'reset_terminal', fromStage: stage, toStage: target };
  }

  // Case 2: stuck claim.
  if (claimed_at) {
    const claimAgeSec = Math.floor((Date.now() - new Date(claimed_at).getTime()) / 1000);
    if (claimAgeSec >= ZOMBIE_CLAIM_AGE_SEC) {
      await sql.query(
        `
        UPDATE pipeline_run_videos
           SET claimed_at = NULL,
               claimed_by_tick = NULL,
               updated_at = NOW()
         WHERE id = $1::uuid AND workspace_id = $2::uuid
        `,
        [videoId, workspaceId],
      );
      logger.info('auto-pipeline: zombie claim cleared on retry', {
        pipeline_video_id: videoId,
        stage,
        claim_age_sec: claimAgeSec,
      });
      return { action: 'cleared_zombie_claim', stage, claimAgeSec };
    }
    return {
      action: 'noop',
      stage,
      reason: `Cron has the row claimed (age ${claimAgeSec}s). Wait for the handler to finish or kill the video.`,
    };
  }

  // Case 3: nothing to retry; the cron will pick it up on its next tick.
  return {
    action: 'noop',
    stage,
    reason: 'Video is not in a failure state and not stuck. The cron will pick it up on its next tick.',
  };
}

// ─── Run-level batch actions ────────────────────────────────────────

export interface BatchOutcome {
  scanned: number;
  changed: number;
  details: Array<{ videoId: string; outcome: string }>;
}

/**
 * Stop every non-terminal video in a run. Used by the "Stop all"
 * button in the run header. Already-terminal rows are skipped (not
 * counted as changed).
 */
export async function stopAllInRun(args: {
  workspaceId: string;
  runId: string;
  reason?: string;
}): Promise<BatchOutcome> {
  const { workspaceId, runId, reason } = args;
  const { rows } = await sql.query<{ id: string; stage: string }>(
    `
    SELECT id::text AS id, stage
      FROM pipeline_run_videos
     WHERE pipeline_run_id = $1::uuid AND workspace_id = $2::uuid
    `,
    [runId, workspaceId],
  );
  if (rows.length === 0) {
    throw new PipelineActionError('run_not_found', `Pipeline run ${runId} not found.`);
  }
  const details: BatchOutcome['details'] = [];
  let changed = 0;
  for (const r of rows) {
    if (isPipelineStage(r.stage) && TERMINAL_STAGES.has(r.stage)) {
      details.push({ videoId: r.id, outcome: 'already_terminal' });
      continue;
    }
    await sql`
      UPDATE pipeline_run_videos
         SET stage = 'cancelled_by_user',
             failure_class = 'user_cancelled',
             failure_message = ${reason ?? 'Stopped via Stop all.'},
             claimed_at = NULL,
             claimed_by_tick = NULL,
             updated_at = NOW()
       WHERE id = ${r.id}::uuid AND workspace_id = ${workspaceId}::uuid
    `;
    details.push({ videoId: r.id, outcome: 'cancelled' });
    changed++;
  }
  logger.info('auto-pipeline: run stop-all', {
    pipeline_run_id: runId,
    workspace_id: workspaceId,
    scanned: rows.length,
    changed,
  });
  return { scanned: rows.length, changed, details };
}

/**
 * Retry every video in a run that's either:
 *   - in a retry-able terminal failure stage, or
 *   - holding a zombie claim (claimed_at older than 5 min).
 *
 * Healthy in-flight rows are left alone. `narration_abandoned` rows
 * are skipped (the dedicated narration flow is the right path for
 * those).
 */
export async function retryStuckOrFailedInRun(args: {
  workspaceId: string;
  runId: string;
}): Promise<BatchOutcome> {
  const { workspaceId, runId } = args;
  const { rows } = await sql.query<{
    id: string;
    stage: string;
    claimed_at: string | null;
  }>(
    `
    SELECT id::text AS id, stage, claimed_at::text AS claimed_at
      FROM pipeline_run_videos
     WHERE pipeline_run_id = $1::uuid AND workspace_id = $2::uuid
    `,
    [runId, workspaceId],
  );
  if (rows.length === 0) {
    throw new PipelineActionError('run_not_found', `Pipeline run ${runId} not found.`);
  }
  const details: BatchOutcome['details'] = [];
  let changed = 0;
  for (const r of rows) {
    try {
      const result = await retryVideo({ workspaceId, videoId: r.id });
      if (result.action === 'noop') {
        details.push({ videoId: r.id, outcome: 'noop' });
        continue;
      }
      details.push({ videoId: r.id, outcome: result.action });
      changed++;
    } catch (err) {
      // narration_abandoned (unretryable) lands here. Skip and continue.
      const code = err instanceof PipelineActionError ? err.code : 'error';
      details.push({ videoId: r.id, outcome: `skipped:${code}` });
    }
  }
  logger.info('auto-pipeline: run retry-stuck-or-failed', {
    pipeline_run_id: runId,
    workspace_id: workspaceId,
    scanned: rows.length,
    changed,
  });
  return { scanned: rows.length, changed, details };
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
