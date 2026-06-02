import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listShortsForWorkspace } from '@/lib/shorts';

/**
 * GET /api/shorts?projectId=&limit=&medium=&inboxOnly=
 *
 * Workspace-scoped list of shorts, newest first.
 *
 * Phase 1 filters added by the medium-primitive rollout:
 *   - `medium`     — 'long_form' | 'short_clip' | 'short_native'.
 *   - `inboxOnly`  — when 'true', excludes rows with `dismissed_at` set and
 *                    orders by hook_score DESC NULLS LAST so the strongest
 *                    candidates surface first. Used by the /shorts?tab=inbox UI.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const mediumRaw = searchParams.get('medium');
  const inboxOnly = searchParams.get('inboxOnly') === 'true';
  const medium =
    mediumRaw === 'long_form' || mediumRaw === 'short_clip' || mediumRaw === 'short_native'
      ? mediumRaw
      : undefined;
  const shorts = await listShortsForWorkspace(session.ws, { projectId, medium, inboxOnly, limit });
  return NextResponse.json({ shorts });
});
