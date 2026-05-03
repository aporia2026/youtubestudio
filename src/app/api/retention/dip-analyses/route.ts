import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import { analyzeRetentionDips, listDipAnalyses } from '@/lib/fix-the-dip';

export const maxDuration = 60;

/**
 * GET /api/retention/dip-analyses?channelDbId=&youtubeVideoId=&limit=
 *
 * Workspace-scoped list of past dip analyses, newest first.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const channelDbId = searchParams.get('channelDbId') || undefined;
  const youtubeVideoId = searchParams.get('youtubeVideoId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const analyses = await listDipAnalyses(session.ws, { channelDbId, youtubeVideoId, limit });
  return NextResponse.json({ analyses });
});

/**
 * POST /api/retention/dip-analyses
 *
 * Body: {
 *   youtubeVideoId: string,    — must already exist in video_analytics
 *   script: string,             — the full script of the published video
 *   channelDbId?: string,
 *   projectId?: string,
 *   sourceScriptId?: string,
 *   modelId?: string,
 * }
 *
 * Pulls the video's real retention curve from video_analytics, detects
 * significant drops deterministically, asks the model to align each one
 * to the script and propose a per-dip fix, persists + returns.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const youtubeVideoId = typeof b.youtubeVideoId === 'string' ? b.youtubeVideoId.trim() : '';
  const script = typeof b.script === 'string' ? b.script : '';
  if (!youtubeVideoId) {
    return NextResponse.json({ error: 'youtubeVideoId is required' }, { status: 400 });
  }
  if (!script.trim()) {
    return NextResponse.json({ error: 'script is required' }, { status: 400 });
  }

  const channelDbId = typeof b.channelDbId === 'string' && b.channelDbId ? b.channelDbId : null;
  const projectId = typeof b.projectId === 'string' && b.projectId ? b.projectId : null;
  const sourceScriptId = typeof b.sourceScriptId === 'string' && b.sourceScriptId ? b.sourceScriptId : null;
  const modelId = typeof b.modelId === 'string' && b.modelId ? b.modelId : undefined;

  try {
    if (channelDbId) await assertOwnsResource('channels', channelDbId, session.ws);
    if (projectId) await assertOwnsResource('projects', projectId, session.ws);
    if (sourceScriptId) await assertOwnsResource('scripts', sourceScriptId, session.ws);
  } catch (err) {
    if (err instanceof ResourceNotInWorkspaceError) {
      return NextResponse.json({ error: 'Resource not found in this workspace' }, { status: 404 });
    }
    throw err;
  }

  try {
    const result = await analyzeRetentionDips({
      workspaceId: session.ws,
      youtubeVideoId,
      scriptText: script,
      channelDbId,
      projectId,
      sourceScriptId,
      modelId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'retention: dip-analysis',
      knownPatterns: [
        { match: /not found/i, status: 404 },
        { match: /too short|required/i, status: 400 },
        { match: /too sparse|Sync analytics/i, status: 409 },
      ],
      fallbackMessage: 'Dip analysis failed — please try again.',
    });
  }
});
