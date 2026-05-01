import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listShortsForWorkspace } from '@/lib/shorts';

/**
 * GET /api/shorts?projectId=&limit=
 *
 * Workspace-scoped list of shorts, newest first. Filterable by project.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const shorts = await listShortsForWorkspace(session.ws, { projectId, limit });
  return NextResponse.json({ shorts });
});
