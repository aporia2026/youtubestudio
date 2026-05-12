import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken } from '@/lib/review-db';
import { notifyCommentResolvedToOwner } from '@/lib/notify';
import { logger } from '@/lib/logger';

/**
 * Token-side fix-notes submission. Mirrors the editor-dashboard fix-notes
 * endpoint but auths via the review share token.
 *
 * For each note the editor wrote, we create a regular comment on the new
 * version with `fix_for_comment_id` pointing back to the original feedback,
 * and (when resolveOriginal is true) mark the original resolved + email
 * the owner.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    if (!link.collaborator_id) {
      return NextResponse.json({ error: 'Anonymous links cannot submit fix notes' }, { status: 403 });
    }
    const { rows: collabRows } = await sql`
      SELECT id, name, color, role, roles FROM collaborators WHERE id = ${link.collaborator_id} LIMIT 1
    `;
    const collab = collabRows[0];
    if (!collab) return NextResponse.json({ error: 'Collaborator not found' }, { status: 403 });
    const allRoles: string[] = Array.isArray(collab.roles) && collab.roles.length > 0
      ? collab.roles
      : (collab.role ? [collab.role] : []);
    if (!allRoles.includes('editor')) {
      return NextResponse.json({ error: 'Only editors can submit fix notes' }, { status: 403 });
    }

    const body = await req.json();
    const versionId = body.versionId as string;
    const notes = (body.notes ?? []) as Array<{ commentId: string; text: string; resolveOriginal?: boolean }>;
    if (!versionId || !Array.isArray(notes) || notes.length === 0) {
      return NextResponse.json({ error: 'versionId + non-empty notes required' }, { status: 400 });
    }

    const { rows: vRows } = await sql`
      SELECT id, version_number FROM review_versions WHERE id = ${versionId} AND project_id = ${link.project_id} LIMIT 1
    `;
    if (!vRows[0]) return NextResponse.json({ error: 'Version not in this project' }, { status: 403 });

    const created: unknown[] = [];
    for (const note of notes) {
      const text = (note.text ?? '').trim();
      if (!text) continue;
      const { rows: origRows } = await sql`
        SELECT c.id, c.timestamp_ms, c.end_timestamp_ms, c.text AS original_text, v.project_id
        FROM review_comments c
        JOIN review_versions v ON v.id = c.version_id
        WHERE c.id = ${note.commentId}
        LIMIT 1
      `;
      const orig = origRows[0];
      if (!orig || orig.project_id !== link.project_id) continue;

      // workspace_id is NOT NULL on review_comments since migration 0013 —
      // copy it from the parent review_version. author_role is always
      // 'editor' here because the route is guarded to allRoles.includes('editor').
      const { rows: insertRows } = await sql`
        INSERT INTO review_comments
          (version_id, timestamp_ms, end_timestamp_ms, text, author_name, author_color, author_role, fix_for_comment_id, workspace_id)
        SELECT ${versionId}::uuid, ${orig.timestamp_ms}, ${orig.end_timestamp_ms},
               ${text}, ${collab.name}, ${collab.color || '#22c55e'},
               'editor',
               ${orig.id}::uuid, v.workspace_id
          FROM review_versions v WHERE v.id = ${versionId}::uuid
        RETURNING *
      `;
      created.push(insertRows[0]);

      if (note.resolveOriginal) {
        await sql`
          UPDATE review_comments
          SET resolved = true, resolved_by = ${collab.name}, resolved_at = NOW()
          WHERE id = ${note.commentId}
        `;
        const { rows: pRows } = await sql`SELECT title FROM review_projects WHERE id = ${link.project_id} LIMIT 1`;
        notifyCommentResolvedToOwner({
          projectId: link.project_id,
          projectTitle: pRows[0]?.title || 'a project',
          resolverName: collab.name,
          commentText: orig.original_text,
          versionNumber: vRows[0].version_number,
          versionId,
          timestampMs: orig.timestamp_ms,
        }).catch(e => logger.error('notifyCommentResolvedToOwner failed', { detail: e instanceof Error ? e.message : String(e) }));
      }
    }

    return NextResponse.json({ created: created.length });
  } catch (err) {
    logger.error('POST token fix-notes error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to save fix notes' }, { status: 500 });
  }
}
