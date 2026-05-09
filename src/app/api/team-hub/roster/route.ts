/**
 * GET /api/team-hub/roster — workspace-scoped roster for the team hub
 * left rail.
 *
 * Unlike the legacy /api/team/overview (which returns every collaborator
 * across every workspace), this endpoint scopes to people the actor
 * actually works with in their current workspace: collaborators with at
 * least one assignment / share link in `session.ws`, plus channel editors
 * whose channel lives in `session.ws`.
 *
 * Auth: apiRoute.authed. Anonymous = 401 via the standard SessionError
 * path in route-helpers.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { getTeamHubRoster } from '@/lib/team-hub-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

export const GET = apiRoute.authed(async (session) => {
  try {
    const roster = await getTeamHubRoster(session.ws);
    return NextResponse.json(roster);
  } catch (err) {
    logger.error('GET /api/team-hub/roster', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
    });
    return NextResponse.json({ error: 'Failed to load roster' }, { status: 500 });
  }
});
