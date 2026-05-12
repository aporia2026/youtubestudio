/**
 * Auto-pipeline orchestrator entry point.
 *
 * `processNextVideo` is the function the cron route calls. It:
 *   1. Claims the next active-stage row (FOR UPDATE SKIP LOCKED).
 *   2. Dispatches on stage to the appropriate handler.
 *   3. Persists the handler's outcome (advance / fail) plus any
 *      artefact metadata.
 *   4. Returns true if a row was advanced (drain loop continues)
 *      or false if no eligible row exists (drain loop exits).
 *
 * The cron route wraps the whole drain in `withCronLock` (single-
 * flight) + each row uses `SELECT FOR UPDATE SKIP LOCKED` (per-row
 * race). Both layers, council-mandated.
 *
 * Stage-to-handler mapping lives here so adding a new stage is a
 * one-place change: import + add a case to the switch. Stages
 * that are "waiting" (cron skips) don't have handlers — they're
 * filtered out at the claim level via ACTIVE_STAGES.
 */
import { randomUUID } from 'node:crypto';
import { claimNextVideo, advanceStage, failStage, releaseClaim } from './db';
import { handleGenerateIdea } from './stages/generate-idea';
import { handleGenerateScript } from './stages/generate-script';
import { handleRunCriticPanel } from './stages/run-critic-panel';
import { handleQaRetry } from './stages/qa-retry';
import { handleNarrationComplete } from './stages/narration-complete';
import { handleGenerateProductionDoc } from './stages/generate-production-doc';
import { handleGenerateThumbnail } from './stages/generate-thumbnail';
import { handleAssignToEditor } from './stages/assign-to-editor';
import { logger } from '../logger';
import type {
  PipelineRunVideoRow,
  PipelinePreset,
  StageHandler,
  StageOutcome,
} from './types';
import { isActiveStage } from './types';

/**
 * Lookup table from stage name to handler. Keyed by stage strings
 * (not the union type) so the orchestrator can defend against
 * legacy stage names the DB might still hold. An unknown stage
 * routes to a defensive "fail with invariant_violation" path.
 *
 * Aliases:
 *   - `queued` and `generating_idea` both dispatch to
 *     `handleGenerateIdea`. A fresh row is created at `queued`
 *     (visible in the DB as "fresh, hasn't started"); the
 *     orchestrator can also choose to write `generating_idea`
 *     mid-flight in a future revision. Both names route to the
 *     same handler so either is fine.
 *   - `qa_retry` is its own handler (regenerates the script with
 *     applied fixes from the prior verdict), separate from
 *     `running_qa` (which runs the critic panel).
 */
const STAGE_HANDLERS: Record<string, StageHandler | undefined> = {
  queued: handleGenerateIdea,
  generating_idea: handleGenerateIdea,
  generating_script: handleGenerateScript,
  running_qa: handleRunCriticPanel,
  qa_retry: handleQaRetry,
  narration_complete: handleNarrationComplete,
  generating_production_doc: handleGenerateProductionDoc,
  generating_thumbnail: handleGenerateThumbnail,
  assigning_to_editor: handleAssignToEditor,
};

/**
 * Returns the handler for a stage name, or null when no handler
 * is registered (waiting/terminal stages, or unknown names).
 *
 * Exposed for tests + introspection.
 */
export function getStageHandler(stage: string): StageHandler | null {
  return STAGE_HANDLERS[stage] ?? null;
}

/**
 * Process one pipeline_run_video row through one stage transition.
 *
 * Returns:
 *   - `'advanced'` — a row was claimed and advanced. Caller should
 *     loop to drain the next.
 *   - `'no_work'` — no eligible row found. Caller exits the drain
 *     loop and returns 200.
 *   - `'released'` — a row was claimed but the handler threw
 *     unexpectedly; claim released so the next tick retries.
 */
export async function processNextVideo(): Promise<'advanced' | 'no_work' | 'released'> {
  const tickId = randomUUID();

  const claim = await claimNextVideo(tickId);
  if (!claim) return 'no_work';
  const { video, preset } = claim;

  if (!isActiveStage(video.stage)) {
    // Belt-and-braces — claimNextVideo already filters by
    // ACTIVE_STAGES, but if a row's stage was hand-edited between
    // claim and dispatch we don't want to crash.
    await failStage(
      video.id,
      'production_doc_failed',
      'invariant_violation',
      `Stage "${video.stage}" is not active but was claimed.`,
      0,
    );
    return 'advanced';
  }

  const handler = getStageHandler(video.stage);
  if (!handler) {
    logger.warn('auto-pipeline: no handler for stage', {
      stage: video.stage,
      pipeline_video_id: video.id,
    });
    await failStage(
      video.id,
      'production_doc_failed',
      'unknown_stage',
      `No handler registered for stage "${video.stage}".`,
      0,
    );
    return 'advanced';
  }

  let outcome: StageOutcome;
  try {
    outcome = await handler({ video, preset, tickId });
  } catch (err) {
    // Unexpected handler throw (something not caught at the
    // handler boundary). Release the claim — next tick retries.
    // We don't auto-fail because a transient infra blip
    // (DB connection, timeout outside generateTextWithFallback)
    // shouldn't terminate a video on the first hiccup.
    logger.error('auto-pipeline: handler threw, releasing claim', {
      stage: video.stage,
      pipeline_video_id: video.id,
      tick_id: tickId,
      detail: err instanceof Error ? err.message : String(err),
    });
    await releaseClaim(video.id);
    return 'released';
  }

  if (outcome.kind === 'advance') {
    await advanceStage(video.id, outcome.nextStage, outcome.persist, outcome.costUsd ?? 0);
    logger.info('auto-pipeline: stage advanced', {
      from_stage: video.stage,
      to_stage: outcome.nextStage,
      pipeline_video_id: video.id,
      tick_id: tickId,
    });
  } else {
    await failStage(
      video.id,
      outcome.terminalStage,
      outcome.failureClass,
      outcome.failureMessage,
      outcome.costUsd ?? 0,
    );
    logger.warn('auto-pipeline: stage failed', {
      stage: video.stage,
      terminal_stage: outcome.terminalStage,
      failure_class: outcome.failureClass,
      pipeline_video_id: video.id,
      tick_id: tickId,
    });
  }

  return 'advanced';
}

// Re-export so cron route can pin the handler set under one import.
export type { PipelineRunVideoRow, PipelinePreset } from './types';
