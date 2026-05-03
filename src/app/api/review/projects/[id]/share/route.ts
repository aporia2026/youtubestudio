import { NextRequest, NextResponse } from 'next/server';
import { createShareLink, getShareLinks, deleteShareLink, getProject } from '@/lib/review-db';
import { getCollaborator } from '@/lib/team-db';
import { ensureEditorAssignmentFromReviewLink } from '@/lib/editor-db';
import { logger } from '@/lib/logger';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const links = await getShareLinks(id);
    return NextResponse.json(links);
  } catch (err) {
    logger.error('GET share links error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to get share links' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const { permission, expiresAt, collaboratorId, label } = await req.json();
    const perm = permission || 'can-comment';
    if (!['view-only', 'can-comment', 'can-annotate'].includes(perm)) {
      return NextResponse.json({ error: 'Invalid permission. Must be: view-only, can-comment, or can-annotate' }, { status: 400 });
    }
    const link = await createShareLink(id, perm, expiresAt, collaboratorId, label);

    // If the recipient is an editor-role collaborator, surface this review on
    // their personal dashboard by ensuring an editor_assignment exists. The
    // review-id ↔ main-project-id hop is best-effort (via schedule_items);
    // when no link can be resolved this no-ops silently.
    if (collaboratorId) {
      try {
        const collab = await getCollaborator(collaboratorId);
        const roles: string[] = Array.isArray(collab?.roles) ? collab.roles : [];
        const isEditor = collab?.role === 'editor' || roles.includes('editor');
        if (isEditor) {
          await ensureEditorAssignmentFromReviewLink(id, collaboratorId);
        }
      } catch (err) {
        logger.error('auto-create editor_assignment failed', { detail: err instanceof Error ? err.message : String(err) });
      }
    }

    return NextResponse.json(link, { status: 201 });
  } catch (err) {
    logger.error('POST share link error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create share link' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { linkId } = await req.json();
    if (!linkId) return NextResponse.json({ error: 'linkId required' }, { status: 400 });
    await deleteShareLink(linkId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE share link error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to delete share link' }, { status: 500 });
  }
}
