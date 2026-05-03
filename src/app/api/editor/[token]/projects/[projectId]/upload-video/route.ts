import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getEditorByPersonalToken } from '@/lib/team-db';
import { getEditorAssignment, updateEditorAssignment } from '@/lib/editor-db';
import { createProject as createReviewProject, createVersion } from '@/lib/review-db';
import { isR2Configured, buildR2Key, getUploadPresignedUrl } from '@/lib/r2';
import { logger } from '@/lib/logger';

const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/x-msvideo', 'video/x-matroska'];

/**
 * Editor uploads a finished video for review. We piggy-back on the review
 * system: the FIRST upload creates a review_project (and links it to the
 * editor_assignment via review_project_id). Subsequent uploads add a new
 * version to that same review_project.
 *
 * Two-step presigned upload (matches the owner-side review flow):
 *   POST { fileName, contentType, fileSize, note? } → { uploadUrl, versionId, reviewProjectId }
 *   PATCH { versionId, thumbnail_url?, duration_ms?, width?, height? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; projectId: string }> }) {
  try {
    const { token, projectId } = await params;
    const editor = await getEditorByPersonalToken(token);
    if (!editor) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const assignment = await getEditorAssignment(projectId, editor.id);
    if (!assignment) return NextResponse.json({ error: 'Not assigned to this project' }, { status: 403 });

    if (!isR2Configured()) {
      return NextResponse.json({ error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' }, { status: 503 });
    }

    const { fileName, contentType, fileSize, note } = await req.json();
    if (!fileName || !contentType) return NextResponse.json({ error: 'fileName + contentType required' }, { status: 400 });
    if (!ALLOWED_VIDEO_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Invalid video type: ${contentType}` }, { status: 400 });
    }

    // Get project title for the review project name
    const { rows: projectRows } = await sql`SELECT title FROM projects WHERE id = ${projectId} LIMIT 1`;
    const projectTitle = projectRows[0]?.title || 'Project';

    // Ensure a review_project exists for this assignment
    let reviewProjectId: string | undefined = (assignment.review_project_id as string | null) ?? undefined;
    if (!reviewProjectId) {
      const reviewProject = await createReviewProject(projectTitle, note || `Video edits by ${editor.name}`);
      reviewProjectId = reviewProject.id as string;
      await updateEditorAssignment(assignment.id, { review_project_id: reviewProjectId, status: 'submitted' });
    } else if (assignment.status === 'editing' || assignment.status === 'assigned') {
      await updateEditorAssignment(assignment.id, { status: 'submitted' });
    }
    if (!reviewProjectId) {
      return NextResponse.json({ error: 'Failed to create review project' }, { status: 500 });
    }

    // Reserve a review_version (atomic version_number bump)
    const version = await createVersion(reviewProjectId, '', editor.name || 'editor', typeof fileSize === 'number' ? fileSize : undefined);
    const r2Key = buildR2Key(reviewProjectId, version.version_number, fileName);

    let uploadUrl: string;
    try {
      uploadUrl = await getUploadPresignedUrl(r2Key, contentType);
      await sql`UPDATE review_versions SET r2_key = ${r2Key} WHERE id = ${version.id}`;
    } catch (e) {
      await sql`DELETE FROM review_versions WHERE id = ${version.id}`;
      const msg = e instanceof Error ? e.message : 'Unknown R2 error';
      return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
    }

    return NextResponse.json({
      uploadUrl,
      versionId: version.id,
      versionNumber: version.version_number,
      reviewProjectId,
      r2Key,
    }, { status: 201 });
  } catch (err) {
    logger.error('editor upload-video error', { detail: err instanceof Error ? err.message : String(err) });
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to start upload: ${msg}` }, { status: 500 });
  }
}

/** PATCH: confirm video metadata after R2 upload completes. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string; projectId: string }> }) {
  try {
    const { token, projectId } = await params;
    const editor = await getEditorByPersonalToken(token);
    if (!editor) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });
    const assignment = await getEditorAssignment(projectId, editor.id);
    if (!assignment) return NextResponse.json({ error: 'Not assigned' }, { status: 403 });

    const { versionId, thumbnail_url, duration_ms, width, height } = await req.json();
    if (!versionId) return NextResponse.json({ error: 'versionId required' }, { status: 400 });

    // Verify version belongs to this assignment's review project
    if (assignment.review_project_id) {
      const { rows } = await sql`
        SELECT id FROM review_versions WHERE id = ${versionId} AND project_id = ${assignment.review_project_id} LIMIT 1
      `;
      if (rows.length === 0) return NextResponse.json({ error: 'Version not found' }, { status: 403 });
    }

    await sql`
      UPDATE review_versions SET
        thumbnail_url = COALESCE(${thumbnail_url ?? null}, thumbnail_url),
        duration_ms = COALESCE(${typeof duration_ms === 'number' ? duration_ms : null}, duration_ms),
        width = COALESCE(${typeof width === 'number' ? width : null}, width),
        height = COALESCE(${typeof height === 'number' ? height : null}, height)
      WHERE id = ${versionId}
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('PATCH editor video error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
