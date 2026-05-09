/**
 * PATCH /api/team-hub/act-as/[targetCollaboratorId]/take-comments/[commentId]
 *
 * Resolve / unresolve a take comment "as the target". Path-based so it
 * fits TakeReview's `itemUrl(commentId)` prop without modifying that
 * component. Body shape matches the existing owner-side PATCH:
 * `{ resolved: boolean, author_name?: string }`. The body's author
 * fields are IGNORED — the server uses the URL's target collaborator's
 * name as the resolver.
 *
 * No DELETE handler in v1 — deleting someone else's comment is too
 * destructive an act-as primitive to expose without a UX dedicated to
 * it.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { actAsCollaborator, ActAsTenancyError } from '@/lib/team-act-as';
import { resolveTakeComment, unresolveTakeComment } from '@/lib/narrator-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  resolved?: boolean;
}

export const PATCH = apiRoute.authed<{ targetCollaboratorId: string; commentId: string }>(
  async (session, req, ctx) => {
    const { targetCollaboratorId, commentId } = await ctx.params;
    if (!UUID_RE.test(targetCollaboratorId) || !UUID_RE.test(commentId)) {
      return NextResponse.json({ error: 'Invalid id in path' }, { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;

    const { rows: targetRows } = await sql<{ name: string }>`
      SELECT name FROM collaborators WHERE id = ${targetCollaboratorId} LIMIT 1
    `;
    const target = targetRows[0];
    if (!target) {
      return NextResponse.json({ error: 'Target collaborator not found' }, { status: 404 });
    }

    try {
      const updated = await actAsCollaborator(
        {
          actorUserId: session.uid,
          workspaceId: session.ws,
          targetCollaboratorId,
          actionType: body.resolved ? 'resolve_comment' : 'unresolve_comment',
          surface: 'narration_take_comment',
          targetId: commentId,
        },
        () =>
          body.resolved
            ? resolveTakeComment(commentId, target.name)
            : unresolveTakeComment(commentId),
      );
      if (!updated) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
      return NextResponse.json(updated);
    } catch (err) {
      if (err instanceof ActAsTenancyError) {
        return NextResponse.json({ error: 'Not in this workspace' }, { status: 404 });
      }
      logger.error('PATCH /api/team-hub/act-as/[target]/take-comments/[id]', {
        detail: err instanceof Error ? err.message : String(err),
        workspace_id: session.ws,
        target_id: targetCollaboratorId,
        comment_id: commentId,
      });
      return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
    }
  },
);
