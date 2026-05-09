/**
 * GET /api/team-hub/[collaboratorId]/editor-tasks
 *
 * Workspace-scoped list of editor assignments for one collaborator.
 * Mirrors the narrator-tasks shape — same auth model, same UUID guard.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { getEditorTasks } from '@/lib/team-hub-tasks-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = apiRoute.authed<{ collaboratorId: string }>(async (session, _req, ctx) => {
  const { collaboratorId } = await ctx.params;
  if (!UUID_RE.test(collaboratorId)) {
    return NextResponse.json({ error: 'Invalid collaborator id' }, { status: 400 });
  }
  try {
    const tasks = await getEditorTasks(session.ws, collaboratorId);
    return NextResponse.json({ tasks });
  } catch (err) {
    logger.error('GET /api/team-hub/[id]/editor-tasks', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
      collaborator_id: collaboratorId,
    });
    return NextResponse.json({ error: 'Failed to load editor tasks' }, { status: 500 });
  }
});
