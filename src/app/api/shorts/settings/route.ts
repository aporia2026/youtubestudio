import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  getShortsSettings,
  updateShortsSettings,
  type ShortsWorkspaceSettings,
} from '@/lib/shorts-workspace-settings';

/**
 * GET  /api/shorts/settings — read the workspace's Shorts settings.
 * POST /api/shorts/settings — patch one or more keys. Body is a partial
 *                             ShortsWorkspaceSettings. Returns the merged
 *                             post-write result so the client can refresh
 *                             without a separate GET.
 *
 * Workspace scoping: settings live on `workspaces.shorts_settings`, keyed
 * by the session workspace. The reader/writer accept a workspaceId param
 * so they can be reused server-side from other libs.
 */
export const GET = apiRoute.authed(async (session) => {
  try {
    const settings = await getShortsSettings(session.ws);
    return NextResponse.json({ settings });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: read settings',
      fallbackMessage: 'Failed to load Shorts settings.',
    });
  }
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: Partial<ShortsWorkspaceSettings> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }
  try {
    const settings = await updateShortsSettings(session.ws, body);
    return NextResponse.json({ settings });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: update settings',
      fallbackMessage: 'Failed to update Shorts settings.',
    });
  }
});
