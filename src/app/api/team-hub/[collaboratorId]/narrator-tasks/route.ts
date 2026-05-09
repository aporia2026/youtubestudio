/**
 * GET /api/team-hub/[collaboratorId]/narrator-tasks
 *
 * Workspace-scoped list of narrator assignments for one collaborator.
 * Powers the Narrator command center on /team-hub.
 *
 * Auth: apiRoute.authed (401 anonymous). Workspace scoping comes from
 * `session.ws` — `collaboratorId` from the URL is treated as
 * user-supplied and never used to derive the workspace.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { getNarratorTasks } from '@/lib/team-hub-tasks-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = apiRoute.authed<{ collaboratorId: string }>(async (session, _req, ctx) => {
  const { collaboratorId } = await ctx.params;
  if (!UUID_RE.test(collaboratorId)) {
    return NextResponse.json({ error: 'Invalid collaborator id' }, { status: 400 });
  }
  try {
    const tasks = await getNarratorTasks(session.ws, collaboratorId);
    return NextResponse.json({ tasks });
  } catch (err) {
    logger.error('GET /api/team-hub/[id]/narrator-tasks', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
      collaborator_id: collaboratorId,
    });
    return NextResponse.json({ error: 'Failed to load narrator tasks' }, { status: 500 });
  }
});
