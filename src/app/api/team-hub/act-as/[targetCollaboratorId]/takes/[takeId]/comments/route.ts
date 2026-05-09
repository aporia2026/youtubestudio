/**
 * POST /api/team-hub/act-as/[targetCollaboratorId]/takes/[takeId]/comments
 *
 * The workspace owner posts a take comment "as the target collaborator"
 * from the team hub. The act-as wrapper:
 *   1. Verifies the target is in the actor's workspace.
 *   2. Runs the create with target's name + colour, author_role='narrator',
 *      posted_by_owner=true.
 *   3. Writes a `team_hub_audit_log` row regardless of success/failure.
 *
 * Path-based so the URL fits TakeReview's `listUrl` prop without
 * modifying that component. Body shape matches the existing owner-side
 * POST handler: `{ timestamp_ms, end_timestamp_ms?, text, parent_id?,
 * author_name?, author_color? }`. The body's author fields are
 * deliberately IGNORED — the server derives the author from the URL's
 * target id, so a mismatched body can't impersonate someone else.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { actAsCollaborator, ActAsTenancyError } from '@/lib/team-act-as';
import { createTakeComment, getTakeComments } from '@/lib/narrator-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  timestamp_ms?: number;
  end_timestamp_ms?: number | null;
  text?: string;
  parent_id?: string | null;
}

/**
 * GET — list every comment on this take. Returns the same set as the
 * owner-side endpoint; the act-as identity only affects writes. Path
 * mirrors TakeReview's expectation that `listUrl` serves both GET and
 * POST so the act-as wrapper doesn't need a separate read URL.
 */
export const GET = apiRoute.authed<{ targetCollaboratorId: string; takeId: string }>(
  async (_session, _req, ctx) => {
    const { targetCollaboratorId, takeId } = await ctx.params;
    if (!UUID_RE.test(targetCollaboratorId) || !UUID_RE.test(takeId)) {
      return NextResponse.json({ error: 'Invalid id in path' }, { status: 400 });
    }
    try {
      const comments = await getTakeComments(takeId);
      return NextResponse.json(comments);
    } catch (err) {
      logger.error('GET /api/team-hub/act-as/[target]/takes/[id]/comments', {
        detail: err instanceof Error ? err.message : String(err),
        take_id: takeId,
      });
      return NextResponse.json({ error: 'Failed to load comments' }, { status: 500 });
    }
  },
);

export const POST = apiRoute.authed<{ targetCollaboratorId: string; takeId: string }>(
  async (session, req, ctx) => {
    const { targetCollaboratorId, takeId } = await ctx.params;
    if (!UUID_RE.test(targetCollaboratorId) || !UUID_RE.test(takeId)) {
      return NextResponse.json({ error: 'Invalid id in path' }, { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const text = (body.text ?? '').trim();
    const ts = body.timestamp_ms;
    const endTs = body.end_timestamp_ms;
    const parentId = body.parent_id ?? null;

    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
      return NextResponse.json({ error: 'timestamp_ms is required and must be ≥ 0' }, { status: 400 });
    }
    if (!text) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }

    const { rows: targetRows } = await sql<{ name: string; color: string }>`
      SELECT name, color FROM collaborators WHERE id = ${targetCollaboratorId} LIMIT 1
    `;
    const target = targetRows[0];
    if (!target) {
      return NextResponse.json({ error: 'Target collaborator not found' }, { status: 404 });
    }

    try {
      const created = await actAsCollaborator(
        {
          actorUserId: session.uid,
          workspaceId: session.ws,
          targetCollaboratorId,
          actionType: parentId ? 'reply_to_comment' : 'post_comment',
          surface: 'narration_take_comment',
          targetId: takeId,
        },
        () =>
          createTakeComment({
            take_id: takeId,
            timestamp_ms: ts,
            end_timestamp_ms: endTs ?? null,
            text,
            author_name: target.name,
            author_color: target.color,
            author_role: 'narrator',
            parent_id: parentId,
            posted_by_owner: true,
          }),
      );
      return NextResponse.json(created, { status: 201 });
    } catch (err) {
      if (err instanceof ActAsTenancyError) {
        return NextResponse.json({ error: 'Not in this workspace' }, { status: 404 });
      }
      logger.error('POST /api/team-hub/act-as/[target]/takes/[id]/comments', {
        detail: err instanceof Error ? err.message : String(err),
        workspace_id: session.ws,
        target_id: targetCollaboratorId,
        take_id: takeId,
      });
      return NextResponse.json({ error: 'Failed to post comment' }, { status: 500 });
    }
  },
);
