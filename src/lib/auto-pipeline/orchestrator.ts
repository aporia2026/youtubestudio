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
import { claimNextVideo, advanceStage, failStage } from './db';
import { handleGenerateIdea } from './stages/generate-idea';
import { handleGenerateScript } from './stages/generate-script';
import { handleRunCriticPanel } from './stages/run-critic-panel';
import { handleQaRetry } from './stages/qa-retry';
import { handleNarrationComplete } from './stages/narration-complete';
import { handleGenerateProductionDoc } from './stages/generate-production-doc';
import { handleGenerateProductionDocImages } from './stages/generate-production-doc-images';
import { handleGenerateZennV1Images } from './stages/generate-zenn-v1-images';
import { handleGenerateThumbnail } from './stages/generate-thumbnail';
import { handleAssignToEditor } from './stages/assign-to-editor';
import { handleGenerateSeo } from './stages/generate-seo';
import { logger } from '../logger';
import type {
  PipelineRunVideoRow,
  PipelinePreset,
  PipelineStage,
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
  generating_production_doc_images: handleGenerateProductionDocImages,
  generating_zenn_v1_images: handleGenerateZennV1Images,
  generating_thumbnail: handleGenerateThumbnail,
  assigning_to_editor: handleAssignToEditor,
  generating_seo: handleGenerateSeo,
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
 *
 * Note: prior versions had a third `'released'` outcome for uncaught
 * handler throws; the 2026-05-26 change converts those to terminal
 * failures so the error message lands in `failure_message` and
 * surfaces in the UI. The union is now just advanced/no_work.
 */
export async function processNextVideo(): Promise<'advanced' | 'no_work'> {
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
      mapStageToFailureTerminal(video.stage),
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
      mapStageToFailureTerminal(video.stage),
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
    // Unexpected handler throw — something the handler's own try/catch
    // didn't wrap (DB error, prompt builder bug, missing env var that
    // surfaces below the per-attempt classifier, etc.).
    //
    // Pre-2026-05-26 behavior: silently release the claim and let the
    // cron retry next tick. That hid the actual error from the UI
    // forever — the row would sit in an "advanced 0, released N"
    // loop with no terminal state and no failure_message, and the
    // user had no way to diagnose without server logs. See the
    // _plans/2026-05-26-* discussion.
    //
    // New behavior: surface the error as a terminal failure with the
    // actual message persisted onto failure_message. The Retry button
    // can revive it from the UI. If the failure really was a
    // transient blip, one click brings it back; if it's a deterministic
    // bug, the user sees what broke instead of staring at "Generating
    // script · updated 5m ago" forever.
    const message = err instanceof Error ? err.message : String(err);
    const terminal = mapStageToFailureTerminal(video.stage);
    logger.error('auto-pipeline: handler threw, marking failed', {
      stage: video.stage,
      terminal_stage: terminal,
      pipeline_video_id: video.id,
      tick_id: tickId,
      detail: message,
    });
    await failStage(video.id, terminal, 'unhandled_handler_error', message, 0);
    return 'advanced';
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

/**
 * Map a current pipeline stage to the terminal failure stage that
 * best represents "this stage's handler crashed." Used by the
 * orchestrator's safety net (`processNextVideo`'s catch block) so the
 * Retry button knows where to reset to.
 *
 * Pairs with `TERMINAL_RETRY_TARGET` in `actions.ts`: every value
 * returned here must be a key of that map so Retry can revive the
 * row from a one-click action. Keep the two in sync when adding a
 * new failure terminal.
 */
function mapStageToFailureTerminal(stage: string): PipelineStage {
  switch (stage) {
    case 'queued':
    case 'generating_idea':
      return 'idea_generation_failed';
    case 'generating_script':
      return 'script_generation_failed';
    case 'running_qa':
    case 'qa_retry':
      return 'qa_failed_after_max_retries';
    case 'narration_complete':
    case 'generating_production_doc':
      return 'production_doc_failed';
    case 'generating_thumbnail':
      return 'thumbnail_failed';
    case 'assigning_to_editor':
      return 'editor_assignment_failed';
    case 'generating_seo':
      return 'seo_failed';
    // Anything else (waiting / unknown / terminal stages we shouldn't
    // be claiming anyway) lands in production-doc-failed as a generic
    // catch-all. The orchestrator's outer guards (isActiveStage) should
    // make this branch unreachable in practice.
    default:
      return 'production_doc_failed';
  }
}

// Re-export so cron route can pin the handler set under one import.
export type { PipelineRunVideoRow, PipelinePreset } from './types';
