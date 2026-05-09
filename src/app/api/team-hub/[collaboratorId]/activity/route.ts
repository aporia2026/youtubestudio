/**
 * GET /api/team-hub/[collaboratorId]/activity
 *
 * Workspace-scoped activity feed for one collaborator. Returns up to 50
 * events (newest first) unioned across the existing tables. See
 * team-hub-activity-db.ts for the source list.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { getCollaboratorActivity } from '@/lib/team-hub-activity-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = apiRoute.authed<{ collaboratorId: string }>(async (session, _req, ctx) => {
  const { collaboratorId } = await ctx.params;
  if (!UUID_RE.test(collaboratorId)) {
    return NextResponse.json({ error: 'Invalid collaborator id' }, { status: 400 });
  }
  try {
    const events = await getCollaboratorActivity(session.ws, collaboratorId, 50);
    return NextResponse.json({ events });
  } catch (err) {
    logger.error('GET /api/team-hub/[id]/activity', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
      collaborator_id: collaboratorId,
    });
    return NextResponse.json({ error: 'Failed to load activity' }, { status: 500 });
  }
});
