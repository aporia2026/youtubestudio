/**
 * Stage handler: auto-assign to the pre-configured video editor.
 *
 * User-requested 2026-05-12: once production-doc + thumbnail are
 * ready, automatically create an editor assignment with:
 *   - the approved script
 *   - the narrator's full-audio voiceover URL (when in-app
 *     narration was used)
 *   - the production doc (read from pipeline_stage_artefacts)
 *   - the generated thumbnail URL
 *
 * The `editor_assignments` table (Phase 11) has a free-text
 * `editor_notes` column we use to bundle these links — the
 * editor portal already renders that field. No schema change
 * needed beyond the FK column added in migration 0053.
 *
 * Behaviour when `preset.video_editor_collaborator_id` is null:
 * skip the assignment, advance straight to `done`. The user can
 * still manually assign an editor later through the existing
 * `/team-hub` surface.
 */
import { sql } from '@vercel/postgres';
import { createEditorAssignment } from '../../editor-db';
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';

export async function handleAssignToEditor(ctx: StageHandlerContext): Promise<StageOutcome> {
  const { video, preset } = ctx;

  // No configured editor → no auto-assignment, just advance to
  // the SEO step (which may also skip if no template is linked,
  // in which case the row reaches `done`).
  if (!preset.video_editor_collaborator_id) {
    logger.info('auto-pipeline: editor auto-assign skipped (no editor configured on preset)', {
      pipeline_video_id: video.id,
    });
    return { kind: 'advance', nextStage: 'generating_seo' };
  }

  if (!video.project_id) {
    return {
      kind: 'fail',
      terminalStage: 'editor_assignment_failed',
      failureClass: 'invariant_violation',
      failureMessage: 'editor handler reached without project_id.',
    };
  }

  // Verify the configured editor is a collaborator in this
  // workspace. Phase 8.1 pattern: cross-workspace ids surface as
  // "not found" (404), no existence leak.
  const { rows: collabRows } = await sql.query<{ id: string; name: string | null; email: string | null }>(
    `
    SELECT id::text AS id, name, email
      FROM collaborators
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [preset.video_editor_collaborator_id, video.workspace_id],
  );
  if (collabRows.length === 0) {
    return {
      kind: 'fail',
      terminalStage: 'editor_assignment_failed',
      failureClass: 'editor_not_found',
      failureMessage: `Configured editor ${preset.video_editor_collaborator_id} is not a collaborator in this workspace.`,
    };
  }
  const editor = collabRows[0];

  // Collect the linkable artefacts. Each is best-effort — a
  // missing piece is logged but doesn't fail the assignment
  // (better to ship an assignment with what we have than block
  // on a stale narrator URL).
  const links = await collectLinks(video, preset);

  const notes = buildEditorNotes({
    videoTitle: links.projectTitle,
    scriptId: video.script_id,
    voiceoverUrl: links.voiceoverUrl,
    productionDocUrl: `/projects/${video.project_id}#production-doc`,
    thumbnailUrl: video.thumbnail_url,
    pipelineRunVideoId: video.id,
  });

  let assignment: { id: string };
  try {
    const row = await createEditorAssignment({
      project_id: video.project_id,
      editor_id: editor.id,
      editor_notes: notes,
    });
    assignment = { id: (row as { id: string }).id };
  } catch (err) {
    return {
      kind: 'fail',
      terminalStage: 'editor_assignment_failed',
      failureClass: 'create_failed',
      failureMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    };
  }

  logger.info('auto-pipeline: editor assignment created', {
    pipeline_video_id: video.id,
    editor_id: editor.id,
    editor_name: editor.name,
    assignment_id: assignment.id,
  });

  return {
    kind: 'advance',
    nextStage: 'generating_seo',
    persist: { editor_assignment_id: assignment.id },
  };
}

interface CollectedLinks {
  projectTitle: string;
  voiceoverUrl: string | null;
}

async function collectLinks(
  video: StageHandlerContext['video'],
  _preset: StageHandlerContext['preset'],
): Promise<CollectedLinks> {
  // Pull project title in one query; voiceover URL is on the
  // narrator_assignment row when present.
  const { rows } = await sql.query<{ project_title: string | null; voiceover_url: string | null }>(
    `
    SELECT p.title AS project_title,
           na.full_audio_url AS voiceover_url
      FROM projects p
      LEFT JOIN narrator_assignments na ON na.id = $2::uuid
     WHERE p.id = $1::uuid AND p.workspace_id = $3::uuid
    `,
    [video.project_id, video.narrator_assignment_id ?? '00000000-0000-0000-0000-000000000000', video.workspace_id],
  );
  return {
    projectTitle: rows[0]?.project_title || '(untitled)',
    voiceoverUrl: rows[0]?.voiceover_url ?? null,
  };
}

/**
 * Build the free-text `editor_notes` payload. Markdown-ish; the
 * editor portal renders it as plain text but URLs are clickable.
 *
 * Pure; exported for tests.
 */
export function buildEditorNotes(args: {
  videoTitle: string;
  scriptId: string | null;
  voiceoverUrl: string | null;
  productionDocUrl: string;
  thumbnailUrl: string | null;
  pipelineRunVideoId: string;
}): string {
  const lines: string[] = [];
  lines.push(`Auto-assigned by the YT Studio pipeline.`);
  lines.push('');
  lines.push(`Video: ${args.videoTitle}`);
  lines.push('');
  lines.push('Assets ready for editing:');
  if (args.scriptId) {
    lines.push(`• Approved script: see project's Scripts tab`);
  }
  if (args.voiceoverUrl) {
    lines.push(`• Voiceover (narrator full audio): ${args.voiceoverUrl}`);
  } else {
    lines.push(`• Voiceover: not yet uploaded — coordinate with the narrator before starting the edit.`);
  }
  lines.push(`• Production doc (shot-by-shot breakdown): ${args.productionDocUrl}`);
  if (args.thumbnailUrl) {
    lines.push(`• Thumbnail: ${args.thumbnailUrl}`);
  } else {
    lines.push(`• Thumbnail: not yet generated (skipped or failed — check pipeline status).`);
  }
  lines.push('');
  lines.push(`Pipeline batch reference: ${args.pipelineRunVideoId}`);
  return lines.join('\n');
}
