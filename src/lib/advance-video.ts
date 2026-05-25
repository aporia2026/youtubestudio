/**
 * The single seam for "advance this video to that stage."
 *
 * Every stage-changing path funnels through advanceVideo():
 *   - The VideoContextStrip's Next button (Wave 1).
 *   - The Command Center kanban's drag-to-advance (Wave 2).
 *   - The auto-pipeline cron (Wave 3 migration moves it here).
 *   - Narrator/editor portal mark-done (Wave 3 migration moves it here).
 *
 * For Wave 1 it does two things:
 *   1. Append an authoritative row to video_stage_transitions. This is
 *      the canonical "what moved when" record that powers stuck detection,
 *      QA-funnel telemetry, and the Wave 3 backfill of
 *      projects.current_stage.
 *   2. Refuse the advance when the video is auto-managed and the requested
 *      transition is gated by the auto-pipeline's existing logic — the
 *      caller gets back a clear reason so the UI can explain why the Next
 *      button is disabled or grayed.
 *
 * It deliberately does NOT touch projects.status, schedule_items.status,
 * narrator_assignments.status, or editor_assignments.status in Wave 1.
 * Those projections stay owned by their domain code; the transition log
 * is the new source of truth for the strip's "current stage" answer.
 * Wave 3 wires the projections to write through here instead.
 */
// Server-only by virtue of importing @vercel/postgres. The project does not
// install the `server-only` shim package; the runtime guard is implicit.
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { loadVideoContext } from './video-context';
import {
  getStageDef,
  getStageIndex,
  type VideoStageId,
} from './video-stages';

export type AdvanceSource =
  | 'strip-next'        // user clicked Next on the VideoContextStrip
  | 'strip-prev'        // user clicked Prev on the VideoContextStrip
  | 'kanban-drag'       // Wave 2: user dragged a card across columns
  | 'cron'              // auto-pipeline cron tick
  | 'narrator-portal'   // narrator marked sections approved
  | 'editor-portal'     // editor uploaded approved cut
  | 'manual-api'        // direct API call from a tool page
  | 'backfill';         // one-time backfill scripts

export interface AdvanceVideoInput {
  /** Project id; the same UUID the URL surfaces as `?videoId=`. */
  videoId: string;
  /** Target stage. Must be a valid VideoStageId. */
  toStage: VideoStageId;
  /** Where the advance came from. Required so telemetry can break down
   *  manual vs cron-driven progress. */
  source: AdvanceSource;
  /** Caller's workspace id from the session. Mandatory; advanceVideo
   *  never trusts the client to identify the workspace. */
  workspaceId: string;
  /** Acting user's id (collaborators.id). Null for cron / system actions. */
  actorUserId?: string | null;
  /** Short human-readable label of the actor (e.g. "Sarah", "auto-pipeline cron"). */
  actorLabel?: string | null;
  /** Optional note attached to the transition row. */
  note?: string | null;
}

export type AdvanceVideoResult =
  | { ok: true; fromStage: VideoStageId | null; toStage: VideoStageId; transitionId: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'gated' | 'invalid_target' | 'no_change'; reason: string };

/**
 * Apply a stage transition. Returns a discriminated union so callers can
 * surface a precise UI affordance for each failure mode.
 *
 * Gating rules (Wave 1):
 *   - auto-managed videos: any transition that would skip past a pipeline
 *     gate (script → voiceover when running_qa hasn't completed, etc.)
 *     is refused. The caller must use the existing
 *     /api/auto-pipeline/videos/[id]/actions endpoints to act on those
 *     videos. The reason field is set to the specific blocker so the UI
 *     can show "QA score 84 of 100 required, retry in nuclear mode."
 *   - manual videos: the only invalid transition is a no-op (target ===
 *     current). The strip's Prev/Next is otherwise unrestricted; the user
 *     owns the flow.
 *
 * Backwards transitions are allowed for manual videos. The user may go
 * back to fix something. Backwards transitions are STILL recorded in
 * video_stage_transitions so the history shows the round-trip.
 */
export async function advanceVideo(input: AdvanceVideoInput): Promise<AdvanceVideoResult> {
  logger.info('[advance-video] start', {
    video_id: input.videoId,
    to_stage: input.toStage,
    source: input.source,
    actor_user_id: input.actorUserId ?? null,
  });

  const ctx = await loadVideoContext(input.videoId, input.workspaceId);
  if (!ctx) {
    logger.warn('[advance-video] not_found', { video_id: input.videoId, workspace_id: input.workspaceId });
    return { ok: false, code: 'not_found', reason: 'Video not found in this workspace' };
  }

  const fromStage: VideoStageId = ctx.current_stage;

  if (fromStage === input.toStage) {
    logger.info('[advance-video] no_change', { video_id: input.videoId, stage: fromStage });
    return { ok: false, code: 'no_change', reason: `Already at ${getStageDef(input.toStage).label}` };
  }

  // Auto-managed video: the cron owns the journey. Refuse manual advances
  // unless the source itself is the cron.
  if (ctx.is_auto_managed && input.source !== 'cron') {
    const blocker = describeAutoManagedBlocker(ctx.pipeline?.stage ?? '', fromStage, input.toStage, ctx.latest_qa_score, ctx.latest_qa_aggressiveness);
    logger.warn('[advance-video] gated', {
      video_id: input.videoId,
      from_stage: fromStage,
      to_stage: input.toStage,
      pipeline_stage: ctx.pipeline?.stage ?? null,
      reason: blocker,
    });
    return { ok: false, code: 'gated', reason: blocker };
  }

  // Wave 1: write the telemetry row.
  // Wave 3: also dual-write projects.current_stage so the
  // Command Center and the Wave 1 strip can read a cached value
  // without re-running the LATERAL-joined resolution every time.
  //
  // Both writes are best-effort with respect to each other: the
  // telemetry row is the authoritative audit log, and the cached
  // column is a projection. If the column write fails, the
  // telemetry row still landed and the next backfill / read will
  // reconcile. We log both outcomes.
  const inserted = await sql`
    INSERT INTO video_stage_transitions
      (workspace_id, project_id, from_stage, to_stage, source, actor_user_id, actor_label, note)
    VALUES
      (${input.workspaceId}::uuid, ${input.videoId}::uuid,
       ${fromStage}, ${input.toStage}, ${input.source},
       ${input.actorUserId ?? null}, ${input.actorLabel ?? null}, ${input.note ?? null})
    RETURNING id
  `;
  const transitionId = inserted.rows[0]?.id as string;

  try {
    await sql`
      UPDATE projects
         SET current_stage = ${input.toStage},
             updated_at    = NOW()
       WHERE id = ${input.videoId}::uuid
         AND workspace_id = ${input.workspaceId}::uuid
    `;
  } catch (err) {
    // Cached projection write failed. Telemetry is still authoritative;
    // the next backfill sweep or the legacy LATERAL-join code path will
    // produce the correct stage on read. Log loudly so we notice if
    // this fails consistently.
    logger.warn('[advance-video] projects.current_stage write failed (telemetry row still saved)', {
      video_id: input.videoId,
      to_stage: input.toStage,
      transition_id: transitionId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('[advance-video] ok', {
    video_id: input.videoId,
    from_stage: fromStage,
    to_stage: input.toStage,
    source: input.source,
    transition_id: transitionId,
    stage_index_delta: getStageIndex(input.toStage) - getStageIndex(fromStage),
  });

  return { ok: true, fromStage, toStage: input.toStage, transitionId };
}

/**
 * Produce a human-readable blocker reason for an auto-managed video.
 * The strip's Next button surfaces this verbatim so the user understands
 * why the manual advance was refused.
 */
function describeAutoManagedBlocker(
  pipelineStage: string,
  fromStage: VideoStageId,
  toStage: VideoStageId,
  latestQaScore: number | null,
  latestQaAggressiveness: string | null,
): string {
  if (fromStage === 'qa' && toStage === 'voiceover') {
    // QA → Voiceover is the most common gate. Surface the score gap if known.
    if (latestQaScore !== null) {
      const aggr = latestQaAggressiveness ?? 'nuclear';
      return `Auto-managed video. Latest QA pass: ${latestQaScore}/100 in ${aggr} mode. Pipeline gate requires the preset's threshold to be met before advancing. Use the Pipeline detail page to retry QA or adjust the preset.`;
    }
    return 'Auto-managed video. QA has not yet completed in the auto-pipeline. Use the Pipeline detail page to drive this video forward.';
  }
  if (pipelineStage === 'waiting_narration' || pipelineStage === 'narration_overdue') {
    return 'Auto-managed video waiting on narrator. Use the Pipeline detail page to mark narration done or extend the deadline.';
  }
  if (pipelineStage === 'awaiting_script_gate') {
    return 'Auto-managed video waiting on the script gate. Keep, regenerate, or kill from the Pipeline detail page.';
  }
  return `Auto-managed video (pipeline stage: ${pipelineStage}). Use the Pipeline detail page to advance it.`;
}
