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

/**
 * The ordered set of stages a user can "Re-run from" in the UI.
 *
 * Excluded by design:
 *  - awaiting_script_gate / waiting_narration / narration_overdue —
 *    these are wait states, not work states. Re-running into them
 *    would just sit waiting again. Users who want to re-run from
 *    "before the gate" pick `generating_script` instead.
 *  - qa_retry — internal substage between running_qa and
 *    awaiting_script_gate; the orchestrator drives it, not the user.
 *  - narration_complete — auto-advance state, not a work stage.
 *  - done / terminal failures — these are END states, not work states.
 *
 * The order matches the canonical pipeline flow; index = "rerun rank."
 * Used to validate that a chosen target is at-or-before the current
 * stage (you can re-run BACK from done to script, but you can't
 * fast-forward from queued to thumbnail).
 */
export const RERUN_TARGET_STAGES: readonly PipelineStage[] = [
  'queued',
  'generating_idea',
  'generating_script',
  'running_qa',
  'generating_production_doc',
  'generating_thumbnail',
  'assigning_to_editor',
  'generating_seo',
] as const;

/**
 * The "rerun rank" of every stage the orchestrator can leave a row
 * sitting in. Higher = further along. Used by the rerun-from-stage
 * validator to reject "fast-forward" requests (target rank > current
 * rank when the current isn't terminal) while allowing "re-run from
 * earlier" requests (target rank <= current rank, OR current is
 * terminal regardless of rank).
 *
 * Wait-states map to the same rank as the work-stage that produced
 * them (e.g., awaiting_script_gate ranks like generating_script).
 * Terminal failure states are skipped — they have no rank because the
 * rerun is unconditional from terminals.
 */
const STAGE_RERUN_RANK: Record<string, number> = {
  queued: 0,
  generating_idea: 1,
  generating_script: 2,
  awaiting_script_gate: 2,
  running_qa: 3,
  qa_retry: 3,
  waiting_narration: 3,
  narration_overdue: 3,
  narration_complete: 4,
  generating_production_doc: 4,
  generating_thumbnail: 5,
  assigning_to_editor: 6,
  generating_seo: 7,
  done: 8,
};

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
  /** Optional. Only honoured on `decision === 'regenerate'`. When set,
   *  the per-video script-style override is updated BEFORE the row
   *  is bumped back to `generating_script`, so the next handler tick
   *  reads the new override. Pass `null` to clear an existing
   *  override; omit (undefined) to leave it untouched. */
  styleOverrideId?: string | null;
  /** Optional. Only honoured on `decision === 'regenerate'`. Sets the
   *  per-video `script_additional_context_override` column BEFORE the
   *  stage flip. `null` clears any existing override; `undefined`
   *  leaves it untouched. Empty string is allowed and stored verbatim
   *  (the prompt builder treats null/'' the same). Migration 0095. */
  customInstructionsOverride?: string | null;
}): Promise<{ newStage: PipelineStage }> {
  const { workspaceId, videoId, decision, styleOverrideId, customInstructionsOverride } = args;

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
    // Apply the inline style override (if any) BEFORE bumping the
    // stage. Sets a persistent per-video override — see the action's
    // doc comment for why we don't model it as ephemeral.
    if (styleOverrideId !== undefined) {
      await sql`
        UPDATE pipeline_run_videos
           SET script_style_preset_override_id = ${styleOverrideId}
         WHERE id = ${videoId}::uuid AND workspace_id = ${workspaceId}::uuid
      `;
    }
    // Same pattern for the custom-instructions override — applied
    // BEFORE the stage flip so the next handler tick reads it.
    if (customInstructionsOverride !== undefined) {
      await sql`
        UPDATE pipeline_run_videos
           SET script_additional_context_override = ${customInstructionsOverride}
         WHERE id = ${videoId}::uuid AND workspace_id = ${workspaceId}::uuid
      `;
    }
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
    style_override_changed: styleOverrideId !== undefined,
    custom_instructions_changed: customInstructionsOverride !== undefined,
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
  idea_generation_failed: 'queued',
  script_generation_failed: 'generating_script',
  qa_failed_after_max_retries: 'generating_script',
  production_doc_failed: 'generating_production_doc',
  thumbnail_failed: 'generating_thumbnail',
  editor_assignment_failed: 'assigning_to_editor',
  seo_failed: 'generating_seo',
  cancelled_by_user: 'generating_script',
  cost_cap_exceeded: 'generating_script',
};

/**
 * Defensive FK guard. Some handlers historically returned the wrong
 * terminal stage on failure (script-gen failures were mis-tagged as
 * `production_doc_failed` before 2026-05-26 — see
 * `_plans/2026-05-26-batch-from-scheduled-items.md` and the comment
 * at the top of `generate-idea.ts`). If a row is labeled with a
 * downstream terminal but is missing the FK that downstream stage
 * needs, retrying to that downstream stage just re-fails on the
 * invariant guard. This map says "if you're about to retry to X but
 * the row is missing FK Y, fall back further to Z instead."
 */
function resolveSafeRetryTarget(
  configuredTarget: PipelineStage,
  row: { script_id: string | null; project_id: string | null; idea_id: string | null },
): PipelineStage {
  // generating_production_doc / generating_thumbnail / generating_seo
  // / assigning_to_editor all need script_id + project_id.
  const needsScript = (
    configuredTarget === 'generating_production_doc' ||
    configuredTarget === 'generating_thumbnail' ||
    configuredTarget === 'generating_seo' ||
    configuredTarget === 'assigning_to_editor' ||
    configuredTarget === 'running_qa'
  );
  if (needsScript && (!row.script_id || !row.project_id)) {
    // Has an idea but no script → retry script gen.
    if (row.idea_id) return 'generating_script';
    // No idea either → retry from the very beginning.
    return 'queued';
  }
  // generating_script needs idea_id.
  if (configuredTarget === 'generating_script' && !row.idea_id) {
    return 'queued';
  }
  return configuredTarget;
}

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
    idea_id: string | null;
    script_id: string | null;
    project_id: string | null;
  }>(
    `
    SELECT stage,
           claimed_at::text AS claimed_at,
           updated_at::text AS updated_at,
           idea_id::text AS idea_id,
           script_id::text AS script_id,
           project_id::text AS project_id
      FROM pipeline_run_videos
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [videoId, workspaceId],
  );
  if (rows.length === 0) {
    throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
  }
  const row = rows[0];
  const { stage, claimed_at } = row;

  if (stage === 'narration_abandoned') {
    throw new PipelineActionError(
      'unretryable',
      'narration_abandoned cannot be retried directly. Extend the deadline and mark narration complete.',
    );
  }

  // Case 1: terminal failure → reset.
  const configuredTarget = TERMINAL_RETRY_TARGET[stage];
  if (configuredTarget) {
    // FK-aware safety net — if the configured target needs FKs the
    // row never got (because of the pre-2026-05-26 mis-labelling bug
    // in generate-script.ts / generate-idea.ts), fall back to a
    // safer earlier stage instead of re-failing on the invariant.
    const target = resolveSafeRetryTarget(configuredTarget, row);
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
      configured_target: configuredTarget,
      to_stage: target,
      fk_downgrade: target !== configuredTarget,
      has_idea_id: row.idea_id != null,
      has_script_id: row.script_id != null,
      has_project_id: row.project_id != null,
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

// ─── Per-video style override (migration 0094) ──────────────────────

/**
 * Persist a per-video script-style override. Highest layer in the
 * effective-style chain that `handleGenerateScript` walks:
 *
 *   video.script_style_preset_override_id  ← this
 *     ?? preset.script_style_preset_id
 *     ?? preset.production_doc_style_id
 *     ?? null
 *
 * Passing `null` clears the override (falls back through the chain).
 * The styleId is validated by the route handler before reaching this
 * function; we don't re-validate ownership here because the DB's FK
 * constraint (ON DELETE SET NULL) already handles the "style was
 * deleted" race.
 *
 * Returns the value that was stored so the UI can confirm what
 * persisted (mostly for the `null = cleared` case).
 */
export async function setVideoStyleOverride(args: {
  workspaceId: string;
  videoId: string;
  styleId: string | null;
}): Promise<{ styleId: string | null }> {
  const { workspaceId, videoId, styleId } = args;
  const { rowCount } = await sql.query(
    `
    UPDATE pipeline_run_videos
       SET script_style_preset_override_id = $3::uuid,
           updated_at = NOW()
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [videoId, workspaceId, styleId],
  );
  if (!rowCount) {
    throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
  }
  logger.info('auto-pipeline: per-video style override set', {
    pipeline_video_id: videoId,
    style_id: styleId,
  });
  return { styleId };
}

/**
 * Persist a per-video visual-style override (the
 * `production_doc_style_override_id` column, migration 0096).
 * Effective visual-style chain in handleGenerateProductionDoc:
 *
 *   video.production_doc_style_override_id  ← this
 *     ?? preset.production_doc_style_id
 *     ?? null
 *
 * Passing `null` clears the override. Sibling to
 * setVideoStyleOverride but on the visual side — they don't share
 * a column so the user can decouple script style from visual style
 * per video.
 */
export async function setVideoVisualStyleOverride(args: {
  workspaceId: string;
  videoId: string;
  styleId: string | null;
}): Promise<{ styleId: string | null }> {
  const { workspaceId, videoId, styleId } = args;
  const { rowCount } = await sql.query(
    `
    UPDATE pipeline_run_videos
       SET production_doc_style_override_id = $3::uuid,
           updated_at = NOW()
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [videoId, workspaceId, styleId],
  );
  if (!rowCount) {
    throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
  }
  logger.info('auto-pipeline: per-video visual-style override set', {
    pipeline_video_id: videoId,
    style_id: styleId,
  });
  return { styleId };
}

/**
 * Persist a per-video custom-instructions override (the
 * `script_additional_context_override` column, migration 0095).
 * Effective-additionalContext chain in handleGenerateScript:
 *
 *   video.script_additional_context_override  ← this
 *     ?? preset.script_rules_jsonb.additionalContext
 *     ?? undefined
 *
 * Passing `null` clears the override (falls back to the preset's
 * additionalContext). Empty string is stored verbatim and treated
 * like null by the prompt builder; the route handler enforces a
 * reasonable max length so a paste-bomb can't poison the script
 * prompt.
 */
export async function setVideoCustomInstructions(args: {
  workspaceId: string;
  videoId: string;
  customInstructions: string | null;
}): Promise<{ customInstructions: string | null }> {
  const { workspaceId, videoId, customInstructions } = args;
  const { rowCount } = await sql.query(
    `
    UPDATE pipeline_run_videos
       SET script_additional_context_override = $3,
           updated_at = NOW()
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [videoId, workspaceId, customInstructions],
  );
  if (!rowCount) {
    throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
  }
  logger.info('auto-pipeline: per-video custom instructions set', {
    pipeline_video_id: videoId,
    chars: customInstructions?.length ?? 0,
    cleared: customInstructions === null,
  });
  return { customInstructions };
}

// ─── Re-run from a chosen stage ─────────────────────────────────────

/**
 * Re-run a video from a chosen stage. Distinct from `retryVideo` —
 * which auto-picks the target from `TERMINAL_RETRY_TARGET` for terminal
 * failures — in that the caller explicitly names the target stage.
 *
 * Validation:
 *  - target must be in RERUN_TARGET_STAGES (no wait-states, no
 *    qa_retry, no done).
 *  - target must not be "ahead" of the current stage when the row is
 *    non-terminal. Terminals get a free pass (you can re-run from
 *    anywhere when the row is dead).
 *  - target must have the required FKs already present on the row
 *    (e.g., running_qa needs script_id; rerunning to a stage whose FKs
 *    were never written would immediately re-fail). Reuses the same
 *    safety map `resolveSafeRetryTarget` enforces.
 *
 * Effects: stage ← target, failure_class/message NULL, claimed_at
 * NULL (lets the orchestrator reclaim a mid-flight row), retry_count
 * += 1. Old downstream artefacts (`scripts`, `production_doc_entries`,
 * …) are NOT deleted — they stay for audit, and the handler creates
 * fresh rows on the next tick.
 */
export async function rerunVideoFromStage(args: {
  workspaceId: string;
  videoId: string;
  targetStage: PipelineStage;
}): Promise<{ fromStage: string; toStage: PipelineStage }> {
  const { workspaceId, videoId, targetStage } = args;

  if (!RERUN_TARGET_STAGES.includes(targetStage)) {
    throw new PipelineActionError(
      'invalid_target',
      `targetStage "${targetStage}" is not a re-runnable stage. ` +
        `Pick one of: ${RERUN_TARGET_STAGES.join(', ')}.`,
    );
  }

  const { rows } = await sql.query<{
    stage: string;
    idea_id: string | null;
    project_id: string | null;
    script_id: string | null;
  }>(
    `
    SELECT stage,
           idea_id::text AS idea_id,
           project_id::text AS project_id,
           script_id::text AS script_id
      FROM pipeline_run_videos
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [videoId, workspaceId],
  );
  if (rows.length === 0) {
    throw new PipelineActionError('video_not_found', `Pipeline video ${videoId} not found.`);
  }
  const row = rows[0];
  const current = row.stage;
  const currentIsTerminal = isPipelineStage(current) && TERMINAL_STAGES.has(current);

  // Forward-fast guard: when the row is still in flight, the user can
  // only re-run BACK to an earlier stage — never forward. Terminals
  // get a free pass because by definition they've stopped.
  if (!currentIsTerminal) {
    const currentRank = STAGE_RERUN_RANK[current];
    const targetRank = STAGE_RERUN_RANK[targetStage];
    if (typeof currentRank === 'number' && typeof targetRank === 'number' && targetRank > currentRank) {
      throw new PipelineActionError(
        'cannot_fast_forward',
        `Cannot re-run from a later stage (target "${targetStage}", current "${current}"). ` +
          `Re-run only supports going BACK to an earlier stage.`,
      );
    }
  }

  // FK-aware safety net — refuse rerun targets whose handler would
  // immediately fail on missing FKs. Same logic the auto-retry path
  // already runs.
  const safeTarget = resolveSafeRetryTarget(targetStage, row);
  if (safeTarget !== targetStage) {
    throw new PipelineActionError(
      'missing_prereqs',
      `Cannot re-run from "${targetStage}" — the row is missing FKs that stage requires. ` +
        `Pick "${safeTarget}" or earlier.`,
    );
  }

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
    [targetStage, videoId, workspaceId],
  );

  logger.info('auto-pipeline: video re-run from chosen stage', {
    pipeline_video_id: videoId,
    from_stage: current,
    to_stage: targetStage,
    from_terminal: currentIsTerminal,
  });

  return { fromStage: current, toStage: targetStage };
}

// ─── Run-level: swap the preset ─────────────────────────────────────

/**
 * Replace the preset a pipeline_run points at. Future stages on every
 * video in this run pick up the new preset on their next cron tick;
 * already-completed stages don't auto-rerun. Users who want stages
 * redone with the new preset's settings click `rerun_from_stage` on
 * the individual videos.
 *
 * Validates that the new preset belongs to the same workspace as the
 * run. Cross-workspace presets surface as 404 (same pattern as the
 * rest of this file).
 */
export async function swapRunPreset(args: {
  workspaceId: string;
  runId: string;
  newPresetId: string;
}): Promise<{ runId: string; oldPresetId: string; newPresetId: string }> {
  const { workspaceId, runId, newPresetId } = args;

  // Load run + verify both old and new preset are in the same
  // workspace. Belt-and-suspenders: the FK to pipeline_presets is
  // workspace-naive, so the workspace check has to happen here.
  const { rows: runRows } = await sql.query<{ preset_id: string }>(
    `
    SELECT preset_id::text AS preset_id
      FROM pipeline_runs
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [runId, workspaceId],
  );
  if (runRows.length === 0) {
    throw new PipelineActionError('run_not_found', `Pipeline run ${runId} not found.`);
  }
  const oldPresetId = runRows[0].preset_id;

  if (oldPresetId === newPresetId) {
    // Idempotent no-op.
    return { runId, oldPresetId, newPresetId };
  }

  const { rows: presetRows } = await sql.query<{ id: string }>(
    `SELECT id::text AS id FROM pipeline_presets WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [newPresetId, workspaceId],
  );
  if (presetRows.length === 0) {
    throw new PipelineActionError('preset_not_found', `Preset ${newPresetId} not in this workspace.`);
  }

  await sql.query(
    `UPDATE pipeline_runs SET preset_id = $1::uuid WHERE id = $2::uuid AND workspace_id = $3::uuid`,
    [newPresetId, runId, workspaceId],
  );

  logger.info('auto-pipeline: run preset swapped', {
    pipeline_run_id: runId,
    workspace_id: workspaceId,
    old_preset_id: oldPresetId,
    new_preset_id: newPresetId,
  });

  return { runId, oldPresetId, newPresetId };
}
