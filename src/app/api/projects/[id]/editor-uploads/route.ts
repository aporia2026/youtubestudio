import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { createProject as createReviewProject, createVersion } from '@/lib/review-db';
import { isR2Configured, buildR2Key, getUploadPresignedUrl } from '@/lib/r2';
import { logger } from '@/lib/logger';

const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/mpeg',
  'video/x-msvideo',
  'video/x-matroska',
];

/**
 * Owner-side upload of a finished video the editor sent through Upwork
 * (or any other off-platform channel). Mirrors the editor's own upload
 * flow at /api/editor/[token]/projects/[projectId]/upload-video — same
 * tables, same review_versions row shape, same /review/[shareToken]
 * comment surface — but auths via the owner's session and attributes
 * the upload to the editor with a "(uploaded by owner)" suffix so the
 * audit trail is honest about who pressed the button.
 *
 * Request:
 *   POST  { fileName, contentType, fileSize, editorAssignmentId?, note? }
 *     → { uploadUrl, versionId, versionNumber, reviewProjectId }
 *   PATCH { versionId, thumbnail_url?, duration_ms?, width?, height? }
 *     → { ok: true }
 *
 * `editorAssignmentId` is required when the project has more than one
 * active editor. Single-editor projects auto-pick.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    try {
      const { id: projectId } = await ctx.params;

      // Verify the project belongs to this workspace; surface 404 (not 403)
      // for cross-workspace ids so existence isn't leaked.
      const { rows: pRows } = await sql`
        SELECT id, title, workspace_id FROM projects
         WHERE id = ${projectId}::uuid AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (pRows.length === 0) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }

      if (!isR2Configured()) {
        return NextResponse.json(
          { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
          { status: 503 },
        );
      }

      const body = await req.json().catch(() => ({}));
      const { fileName, contentType, fileSize, editorAssignmentId, note } = body as {
        fileName?: string;
        contentType?: string;
        fileSize?: number;
        editorAssignmentId?: string;
        note?: string;
      };
      if (!fileName || !contentType) {
        return NextResponse.json({ error: 'fileName + contentType required' }, { status: 400 });
      }
      if (!ALLOWED_VIDEO_TYPES.includes(contentType)) {
        return NextResponse.json({ error: `Invalid video type: ${contentType}` }, { status: 400 });
      }

      // Pick the assignment to attribute the upload to. If the caller
      // specified one, validate it lives under this project + workspace;
      // otherwise auto-pick the single active assignment, or fail loudly
      // when the project has zero editors or more than one.
      const assignmentRow = await pickEditorAssignment(
        projectId,
        session.ws,
        editorAssignmentId,
      );
      if ('error' in assignmentRow) {
        return NextResponse.json({ error: assignmentRow.error }, { status: assignmentRow.status });
      }
      const assignment = assignmentRow.row;

      // Ensure a review_project exists for this assignment. Same pattern
      // as the editor flow: first upload creates the review_project +
      // links it; subsequent uploads add to the existing one.
      let reviewProjectId: string | undefined =
        (assignment.review_project_id as string | null) ?? undefined;
      if (!reviewProjectId) {
        const reviewProject = await createReviewProject(
          (pRows[0].title as string) || 'Project',
          note || `Video received from ${assignment.editor_name}`,
          session.ws,
        );
        reviewProjectId = reviewProject.id as string;
        await sql`
          UPDATE editor_assignments
             SET review_project_id = ${reviewProjectId}::uuid,
                 status = 'submitted',
                 updated_at = NOW()
           WHERE id = ${assignment.id}::uuid
        `;
      } else if (assignment.status === 'editing' || assignment.status === 'assigned') {
        await sql`
          UPDATE editor_assignments
             SET status = 'submitted', updated_at = NOW()
           WHERE id = ${assignment.id}::uuid
        `;
      }
      if (!reviewProjectId) {
        return NextResponse.json({ error: 'Failed to create review project' }, { status: 500 });
      }

      // Reserve a review_version. uploaded_by carries the editor's name
      // with a "(uploaded by owner)" suffix so the editor's dashboard
      // and the /review timeline both make it obvious that the owner —
      // not the editor — pressed the button.
      const uploadedBy = `${assignment.editor_name || 'editor'} (uploaded by owner)`;
      const version = await createVersion(
        reviewProjectId,
        '',
        uploadedBy,
        typeof fileSize === 'number' ? fileSize : undefined,
      );
      const r2Key = buildR2Key(reviewProjectId, version.version_number, fileName);

      let uploadUrl: string;
      try {
        uploadUrl = await getUploadPresignedUrl(r2Key, contentType);
        await sql`UPDATE review_versions SET r2_key = ${r2Key} WHERE id = ${version.id}`;
      } catch (e) {
        await sql`DELETE FROM review_versions WHERE id = ${version.id}`;
        const msg = e instanceof Error ? e.message : 'Unknown R2 error';
        return NextResponse.json(
          { error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' },
          { status: 502 },
        );
      }

      return NextResponse.json(
        {
          uploadUrl,
          versionId: version.id,
          versionNumber: version.version_number,
          reviewProjectId,
          r2Key,
        },
        { status: 201 },
      );
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'owner: editor-upload presign',
        fallbackMessage: 'Could not start upload — please try again.',
      });
    }
  },
);

/**
 * GET: list every review_version that belongs to one of this project's
 * editor assignments, plus the (single, when present) `reviewProjectId`
 * the owner can open in /reviews/[id] to leave timestamped comments.
 *
 * The query joins through editor_assignments so cross-workspace ids
 * silently 404 even if an attacker guessed a valid project UUID.
 */
export const GET = apiRoute.authed(
  async (session, _req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    try {
      const { id: projectId } = await ctx.params;
      const { rows: pRows } = await sql`
        SELECT id FROM projects
         WHERE id = ${projectId}::uuid AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (pRows.length === 0) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }

      // The schema allows multiple editor_assignments per project (one per
      // editor). Each carries its own `review_project_id`; in practice the
      // surface only lets you upload through the "active" assignment so
      // there's typically one review project. We surface every version
      // across every assignment so re-assignment to a new editor doesn't
      // hide the prior video history from the dashboard.
      const { rows: versions } = await sql`
        SELECT v.id, v.version_number, v.thumbnail_url, v.duration_ms,
               v.uploaded_by, v.file_size, v.created_at, v.project_id AS review_project_id,
               (SELECT COUNT(*)::int FROM review_comments c WHERE c.version_id = v.id AND c.resolved = false) AS unresolved_comment_count
          FROM review_versions v
          JOIN editor_assignments ea ON ea.review_project_id = v.project_id
         WHERE ea.project_id = ${projectId}::uuid
           AND ea.workspace_id = ${session.ws}::uuid
         ORDER BY v.version_number DESC, v.created_at DESC
      `;

      // Most-recent assignment's review_project_id is the canonical one
      // the "Open review" CTA points at — it's the project the next
      // upload will use.
      const { rows: latestAssignment } = await sql`
        SELECT review_project_id
          FROM editor_assignments
         WHERE project_id = ${projectId}::uuid
           AND workspace_id = ${session.ws}::uuid
           AND review_project_id IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1
      `;

      return NextResponse.json({
        reviewProjectId: (latestAssignment[0]?.review_project_id as string | null) ?? null,
        versions,
      });
    } catch (err) {
      logger.error('GET editor-uploads error', {
        detail: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: 'Failed to load uploads' }, { status: 500 });
    }
  },
);

/** PATCH: confirm video metadata after R2 upload completes. */
export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    try {
      const { id: projectId } = await ctx.params;
      const { versionId, thumbnail_url, duration_ms, width, height } = await req.json();
      if (!versionId) {
        return NextResponse.json({ error: 'versionId required' }, { status: 400 });
      }

      // Verify the version belongs to this project's review_project AND
      // this workspace. The JOIN through editor_assignments scopes both
      // sides — without it, an attacker with a session in workspace B
      // could PATCH metadata onto a version in workspace A by guessing
      // the UUID.
      const { rows } = await sql`
        SELECT v.id
          FROM review_versions v
          JOIN editor_assignments ea ON ea.review_project_id = v.project_id
         WHERE v.id = ${versionId}::uuid
           AND ea.project_id = ${projectId}::uuid
           AND ea.workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (rows.length === 0) {
        return NextResponse.json({ error: 'Version not found' }, { status: 404 });
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
      logger.error('PATCH editor-upload metadata error', {
        detail: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
  },
);

// ---------------------------------------------------------------------------

interface AssignmentPick {
  id: string;
  editor_id: string;
  editor_name: string | null;
  status: string;
  review_project_id: string | null;
  workspace_id: string;
}

type AssignmentResult = { row: AssignmentPick } | { error: string; status: number };

/**
 * Resolve which editor_assignment row this upload should be attributed to.
 *
 * The picker lives here (rather than in editor-db) because the rules are
 * specific to the owner-side surface:
 *   - If the caller specified an id, it must belong to the project + ws.
 *   - Otherwise prefer the single non-completed assignment.
 *   - If the project has zero editors, refuse — owner needs to assign one
 *     first so the editor can see the upload on their dashboard.
 *   - If the project has multiple active editors, refuse with a hint that
 *     `editorAssignmentId` is required.
 */
async function pickEditorAssignment(
  projectId: string,
  workspaceId: string,
  requestedAssignmentId: string | undefined,
): Promise<AssignmentResult> {
  if (requestedAssignmentId) {
    const { rows } = await sql`
      SELECT ea.id, ea.editor_id, ea.status, ea.review_project_id, ea.workspace_id, c.name AS editor_name
        FROM editor_assignments ea
        LEFT JOIN collaborators c ON c.id = ea.editor_id
       WHERE ea.id = ${requestedAssignmentId}::uuid
         AND ea.project_id = ${projectId}::uuid
         AND ea.workspace_id = ${workspaceId}::uuid
       LIMIT 1
    `;
    if (rows.length === 0) {
      return { error: 'Editor assignment not found', status: 404 };
    }
    return { row: rows[0] as AssignmentPick };
  }

  const { rows } = await sql`
    SELECT ea.id, ea.editor_id, ea.status, ea.review_project_id, ea.workspace_id, c.name AS editor_name
      FROM editor_assignments ea
      LEFT JOIN collaborators c ON c.id = ea.editor_id
     WHERE ea.project_id = ${projectId}::uuid
       AND ea.workspace_id = ${workspaceId}::uuid
       AND ea.status NOT IN ('completed')
     ORDER BY ea.updated_at DESC
  `;
  if (rows.length === 0) {
    return {
      error: 'No editor is assigned to this project. Assign one first so the upload appears in their dashboard.',
      status: 400,
    };
  }
  if (rows.length > 1) {
    return {
      error:
        'This project has multiple editors. Specify `editorAssignmentId` to attribute the upload to the right one.',
      status: 400,
    };
  }
  return { row: rows[0] as AssignmentPick };
}
