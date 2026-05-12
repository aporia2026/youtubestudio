/**
 * Stage handler: narration_complete → generating_production_doc.
 *
 * Trivially transitions a row whose narration finished into the
 * next active stage. The transition itself is triggered externally
 * — when the narrator approves the last take, a callback (TBD —
 * narrator-portal integration is its own ticket) calls
 * `markNarrationComplete(videoId)` which flips the stage from
 * `waiting_narration` to `narration_complete`. The cron then picks
 * up the `narration_complete` row and this handler advances it
 * forward.
 *
 * Why a discrete handler instead of doing the work inline in the
 * narrator-portal callback: the cron's "one stage per tick"
 * contract gives us free idempotency (the artefact PK prevents
 * double-charges) and matches how every other transition works.
 */
import type { StageHandlerContext, StageOutcome } from '../types';

export async function handleNarrationComplete(_ctx: StageHandlerContext): Promise<StageOutcome> {
  // Future: read narrator_assignments.full_audio_duration_seconds
  // here, compute the auto-summed length, and stash it on the
  // pipeline_run_video row so the production-doc handler can use
  // it for timecode pacing. v1 leaves that to the prod-doc
  // handler which can read narrator_takes directly.
  return { kind: 'advance', nextStage: 'generating_production_doc' };
}
