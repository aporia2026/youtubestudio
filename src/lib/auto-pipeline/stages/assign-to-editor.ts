/**
 * Stage handler: auto-assign to the pre-configured video editor.
 * **STUB** in v1.
 *
 * The real handler will:
 *   1. Read `preset.video_editor_collaborator_id` — if null, skip
 *      assignment and advance straight to `done`.
 *   2. Look up the project + verify the editor is a collaborator
 *      in the workspace.
 *   3. Call `createEditorAssignment` from editor-db.ts with the
 *      project_id, editor_id, and a `editor_notes` field listing
 *      links to: approved script (scripts.id), production doc
 *      (latest artefact for stage `generating_production_doc`),
 *      narrator's full-audio voiceover URL
 *      (narrator_assignments.full_audio_url), and the generated
 *      thumbnail (pipeline_run_videos.thumbnail_url).
 *   4. Set `pipeline_run_videos.editor_assignment_id` to the new
 *      assignment's id.
 *   5. Advance to `done`.
 *
 * Tuesday's stub: no-op advance to `done`. If
 * `video_editor_collaborator_id` is set, that's logged so we
 * notice when the stub is masking a real expectation in dev.
 */
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';

export async function handleAssignToEditor(ctx: StageHandlerContext): Promise<StageOutcome> {
  logger.info('auto-pipeline: editor-assignment stub — advancing to done', {
    pipeline_video_id: ctx.video.id,
    configured_editor: ctx.preset.video_editor_collaborator_id,
    note: 'real impl ships in a follow-up push',
  });
  return { kind: 'advance', nextStage: 'done' };
}
