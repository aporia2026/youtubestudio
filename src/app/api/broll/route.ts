import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import { listBrollForWorkspace, startBrollGeneration } from '@/lib/broll';
import {
  BROLL_MAX_PROMPT_CHARS,
  DEFAULT_BROLL_MODEL_ID,
  findBrollModel,
} from '@/lib/broll-types';

export const maxDuration = 30;

/**
 * GET /api/broll?projectId=&scriptId=&limit=
 *
 * Workspace-scoped list of B-roll clips. Filterable by project or script.
 * Newest first.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId') || undefined;
  const scriptId = searchParams.get('scriptId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '100', 10) || 100;
  const clips = await listBrollForWorkspace(session.ws, { projectId, scriptId, limit });
  return NextResponse.json({ clips });
});

/**
 * POST /api/broll
 *
 * Body: {
 *   projectId?: string,                — production-doc project (optional)
 *   scriptId?: string,                 — source script for rehydration (optional)
 *   rowSignature?: string,             — opaque hash of row identifying fields
 *   rowIndex?: number,
 *   visualDescription: string,         — the row's editor-facing direction
 *   aiImagePrompt?: string,            — the row's full scene prompt
 *   styleHint?: string,                — production-doc style suffix
 *   modelId?: string,                  — defaults to sora-2
 *   aspectRatio?: '16:9' | '9:16' | '1:1',
 *   durationSeconds?: number,
 * }
 *
 * Submits the task to Kie and returns the persisted clip row id. The client
 * should then poll GET /api/broll/[id] until status flips to 'ready' or 'failed'.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const visualDescription = typeof b.visualDescription === 'string' ? b.visualDescription.trim() : '';
  const aiImagePrompt = typeof b.aiImagePrompt === 'string' ? b.aiImagePrompt.trim() : '';
  if (!visualDescription && !aiImagePrompt) {
    return NextResponse.json(
      { error: 'visualDescription or aiImagePrompt is required' },
      { status: 400 },
    );
  }

  const projectId = typeof b.projectId === 'string' && b.projectId ? b.projectId : null;
  const scriptId = typeof b.scriptId === 'string' && b.scriptId ? b.scriptId : null;
  const rowSignature = typeof b.rowSignature === 'string' && b.rowSignature ? b.rowSignature : null;
  const rowIndex =
    typeof b.rowIndex === 'number' && Number.isFinite(b.rowIndex) ? Math.max(0, Math.floor(b.rowIndex)) : null;
  const styleHint = typeof b.styleHint === 'string' ? b.styleHint : undefined;

  const modelId = typeof b.modelId === 'string' && b.modelId ? b.modelId : DEFAULT_BROLL_MODEL_ID;
  const model = findBrollModel(modelId);
  if (!model) {
    return NextResponse.json({ error: `Unknown model: ${modelId}` }, { status: 400 });
  }

  const aspectRatioRaw = typeof b.aspectRatio === 'string' ? b.aspectRatio : '16:9';
  if (aspectRatioRaw !== '16:9' && aspectRatioRaw !== '9:16' && aspectRatioRaw !== '1:1') {
    return NextResponse.json({ error: `Unsupported aspectRatio: ${aspectRatioRaw}` }, { status: 400 });
  }

  const durationSeconds =
    typeof b.durationSeconds === 'number' && Number.isFinite(b.durationSeconds)
      ? Math.max(2, Math.min(20, Math.round(b.durationSeconds)))
      : undefined;

  // Defence in depth: even though buildBrollPrompt also caps length, reject
  // obviously oversized payloads before doing any DB / network work.
  if (visualDescription.length + aiImagePrompt.length > BROLL_MAX_PROMPT_CHARS * 2) {
    return NextResponse.json({ error: 'Prompt inputs too long' }, { status: 400 });
  }

  // Ownership checks for the optional FK fields.
  try {
    if (projectId) await assertOwnsResource('projects', projectId, session.ws);
    if (scriptId) await assertOwnsResource('scripts', scriptId, session.ws);
  } catch (err) {
    if (err instanceof ResourceNotInWorkspaceError) {
      return NextResponse.json({ error: 'Resource not found in this workspace' }, { status: 404 });
    }
    throw err;
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 503 });
  }

  try {
    const result = await startBrollGeneration({
      workspaceId: session.ws,
      projectId,
      sourceScriptId: scriptId,
      rowSignature,
      rowIndex,
      visualDescription,
      aiImagePrompt: aiImagePrompt || undefined,
      styleHint,
      modelId,
      aspectRatio: aspectRatioRaw,
      durationSeconds,
      kieApiKey: apiKey,
    });
    return NextResponse.json({ ...result, model_id: modelId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
});
