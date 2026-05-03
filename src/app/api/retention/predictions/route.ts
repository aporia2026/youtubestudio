import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import { listRetentionPredictions, predictRetention } from '@/lib/retention-predictor';

export const maxDuration = 60;

/**
 * GET /api/retention/predictions?projectId=&channelDbId=&limit=
 *
 * Workspace-scoped list of past predictions, newest first.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId') || undefined;
  const channelDbId = searchParams.get('channelDbId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const predictions = await listRetentionPredictions(session.ws, { projectId, channelDbId, limit });
  return NextResponse.json({ predictions });
});

/**
 * POST /api/retention/predictions
 *
 * Body: {
 *   script: string,           — full script text (>= MIN_SCRIPT_CHARS)
 *   niche?: string,
 *   channelDbId?: string,     — scopes RAG retrieval to one channel
 *   projectId?: string,
 *   sourceScriptId?: string,
 *   modelId?: string,         — defaults to claude-haiku-4-5-20251001
 * }
 *
 * Pulls few-shot examples from the workspace's video_analytics history
 * (scoped to channelDbId when provided), runs the predictor, persists
 * the result, returns the prediction shape.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const script = typeof b.script === 'string' ? b.script : '';
  if (!script.trim()) {
    return NextResponse.json({ error: 'script is required' }, { status: 400 });
  }

  const niche = typeof b.niche === 'string' && b.niche ? b.niche : undefined;
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
    const result = await predictRetention({
      workspaceId: session.ws,
      scriptText: script,
      niche,
      channelDbId,
      projectId,
      sourceScriptId,
      modelId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'retention: predict',
      knownPatterns: [
        { match: /too short|required/i, status: 400 },
      ],
      fallbackMessage: 'Retention prediction failed — please try again.',
    });
  }
});
