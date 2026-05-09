/**
 * GET /api/team-hub/[collaboratorId]/reviewer-tasks
 *
 * Workspace-scoped list of review_share_links granted to one collaborator.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { getReviewerTasks } from '@/lib/team-hub-tasks-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = apiRoute.authed<{ collaboratorId: string }>(async (session, _req, ctx) => {
  const { collaboratorId } = await ctx.params;
  if (!UUID_RE.test(collaboratorId)) {
    return NextResponse.json({ error: 'Invalid collaborator id' }, { status: 400 });
  }
  try {
    const tasks = await getReviewerTasks(session.ws, collaboratorId);
    return NextResponse.json({ tasks });
  } catch (err) {
    logger.error('GET /api/team-hub/[id]/reviewer-tasks', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
      collaborator_id: collaboratorId,
    });
    return NextResponse.json({ error: 'Failed to load reviewer tasks' }, { status: 500 });
  }
});
