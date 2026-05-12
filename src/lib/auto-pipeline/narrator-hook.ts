/**
 * Bridge between the narrator-portal approval flow and the
 * auto-pipeline state machine.
 *
 * When the owner approves a narrator's work — either by marking a
 * full-audio assignment 'completed' (the one-file path) or by
 * approving every real section (the per-section path) — and the
 * narrated project is linked to a pipeline_run_video sitting at
 * `waiting_narration` (or `narration_overdue`), this function
 * flips the video to `narration_complete` so the cron picks it up
 * and runs the production-doc handler next.
 *
 * Called fire-and-forget from the section-update PUT route and
 * the approve-full POST route. Workspace tenancy is enforced at
 * the SQL layer — the assignment's workspace must match the
 * pipeline_run_video's, so a malicious narrator (or a routing
 * mistake) can't advance a pipeline in another workspace.
 *
 * Idempotent — `markNarrationComplete` already handles repeat
 * calls (it short-circuits if the row isn't in waiting state).
 *
 * As a useful side effect, also stamps `narrator_assignment_id`
 * onto the pipeline row when it was previously null so the audit
 * trail links forward.
 */
import { sql } from '@vercel/postgres';
import { logger } from '../logger';
import { markNarrationComplete } from './actions';

export async function tryAdvancePipelineFromNarration(args: {
  assignmentId: string;
}): Promise<{ advanced: boolean; reason?: string }> {
  const { assignmentId } = args;

  // Single round-trip: load assignment state + the matching
  // pipeline_run_video (if any) in one query. The pipeline row's
  // workspace_id is constrained to match the assignment's, so we
  // never cross workspaces.
  //
  // The "ready" predicate matches the narrator-portal's own
  // logic for "this assignment is done":
  //   - full-audio path: assignment.status = 'completed' (the
  //     approve-full route sets this), OR
  //   - per-section path: every section_number > 0 is 'approved'.
  //     The synthetic section_number = 0 row is the full-audio
  //     holder and shouldn't count toward the per-section
  //     completion check.
  const { rows } = await sql.query<{
    pipeline_video_id: string | null;
    workspace_id: string;
    pipeline_video_stage: string | null;
    project_id: string;
    is_ready: boolean;
  }>(
    `
    SELECT v.id::text AS pipeline_video_id,
           a.workspace_id::text AS workspace_id,
           v.stage AS pipeline_video_stage,
           a.project_id::text AS project_id,
           (
             a.status = 'completed'
             OR (
               (SELECT COUNT(*) FROM narrator_sections s
                 WHERE s.assignment_id = a.id AND s.section_number != 0) > 0
               AND NOT EXISTS (
                 SELECT 1 FROM narrator_sections s
                  WHERE s.assignment_id = a.id
                    AND s.section_number != 0
                    AND s.status != 'approved'
               )
             )
           ) AS is_ready
      FROM narrator_assignments a
      LEFT JOIN pipeline_run_videos v
        ON v.project_id = a.project_id
       AND v.workspace_id = a.workspace_id
       AND v.stage IN ('waiting_narration', 'narration_overdue')
     WHERE a.id = $1::uuid
     LIMIT 1
    `,
    [assignmentId],
  );

  if (rows.length === 0) {
    return { advanced: false, reason: 'assignment_not_found' };
  }
  const row = rows[0];
  if (!row.is_ready) {
    return { advanced: false, reason: 'narration_not_yet_complete' };
  }
  if (!row.pipeline_video_id) {
    return { advanced: false, reason: 'no_waiting_pipeline_video' };
  }

  // Stamp the narrator_assignment_id on the pipeline row if it
  // wasn't already set — keeps the audit trail clean. Workspace-
  // scoped + idempotent.
  await sql.query(
    `
    UPDATE pipeline_run_videos
       SET narrator_assignment_id = $1::uuid,
           updated_at = NOW()
     WHERE id = $2::uuid
       AND workspace_id = $3::uuid
       AND narrator_assignment_id IS NULL
    `,
    [assignmentId, row.pipeline_video_id, row.workspace_id],
  );

  try {
    await markNarrationComplete({
      workspaceId: row.workspace_id,
      videoId: row.pipeline_video_id,
    });
    logger.info('auto-pipeline: narration auto-advanced via narrator approval', {
      pipeline_video_id: row.pipeline_video_id,
      narrator_assignment_id: assignmentId,
      project_id: row.project_id,
    });
    return { advanced: true };
  } catch (err) {
    logger.warn('auto-pipeline: markNarrationComplete from narrator hook failed', {
      pipeline_video_id: row.pipeline_video_id,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { advanced: false, reason: 'mark_complete_threw' };
  }
}

/**
 * Fire-and-forget convenience for route handlers — wraps the call
 * in an unhandled-rejection guard so the narrator response is
 * never delayed by this side effect.
 */
export function dispatchNarrationHookFireAndForget(assignmentId: string): void {
  void tryAdvancePipelineFromNarration({ assignmentId }).catch((err) => {
    logger.warn('auto-pipeline: narration hook dispatch threw', {
      assignment_id: assignmentId,
      detail: err instanceof Error ? err.message : String(err),
    });
  });
}
