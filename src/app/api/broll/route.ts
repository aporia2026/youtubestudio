import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import { listBrollForWorkspace, startBrollGeneration } from '@/lib/broll';
import { startLocalBrollGeneration } from '@/lib/local-broll';
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
  // Production-doc page calls this on mount with the current
  // historyEntryId to hydrate `rowVideoClips` from the DB — see plan
  // `_plans/2026-05-17-broll-doc-id-hydration.md`. The 64-char cap mirrors
  // the cap we apply on POST so a malicious / corrupt client can't
  // exfiltrate large blobs with one-shot queries either.
  const productionDocIdRaw = searchParams.get('productionDocId') ?? undefined;
  const productionDocId =
    productionDocIdRaw && productionDocIdRaw.length <= 64 ? productionDocIdRaw : undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '100', 10) || 100;
  const clips = await listBrollForWorkspace(session.ws, {
    projectId,
    scriptId,
    productionDocId,
    limit,
  });
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
 *   modelId?: string,                  — defaults to DEFAULT_BROLL_MODEL_ID
 *   aspectRatio?: '16:9' | '9:16' | '1:1',
 *   durationSeconds?: number,
 *   stillImageUrl?: string,            — REQUIRED when modelId is image-to-video.
 *                                        The orchestrator rejects i2v requests
 *                                        without it (400 with a helpful hint).
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
  // Production-doc history entry id. Length-capped + workspace-scoped at
  // read time, so even a hostile client can only tag their own clips
  // with a value of their choice. See plan
  // `_plans/2026-05-17-broll-doc-id-hydration.md`.
  const productionDocId =
    typeof b.productionDocId === 'string' && b.productionDocId.length > 0 && b.productionDocId.length <= 64
      ? b.productionDocId
      : null;
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

  // Still-image URL for image-to-video models. We only accept https:// (or our
  // own R2 / Blob hosts) — Kie fetches the URL directly, so allowing other
  // schemes or arbitrary hosts would let a stale client point Kie at internal
  // resources. The orchestrator does its own kind-vs-presence check.
  let stillImageUrl: string | undefined;
  if (typeof b.stillImageUrl === 'string' && b.stillImageUrl.length > 0) {
    if (!/^https:\/\//i.test(b.stillImageUrl)) {
      return NextResponse.json({ error: 'stillImageUrl must be an https URL' }, { status: 400 });
    }
    if (b.stillImageUrl.length > 2000) {
      return NextResponse.json({ error: 'stillImageUrl too long' }, { status: 400 });
    }
    stillImageUrl = b.stillImageUrl;
  }
  if (model.kind === 'image-to-video' && !stillImageUrl) {
    return NextResponse.json(
      { error: 'This model animates an existing still — generate the row’s image first, then animate it.' },
      { status: 400 },
    );
  }

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

  // Dispatch on provider: local Wan via ComfyUI vs. Kie cloud.
  if (model.provider === 'comfyui-local') {
    if (process.env.LOCAL_STUDIO !== '1') {
      return NextResponse.json(
        {
          error:
            'Local b-roll requires LOCAL_STUDIO=1. Start the dev server with `$env:LOCAL_STUDIO=1; npm run dev` and ensure ComfyUI is running on localhost:8188.',
        },
        { status: 503 },
      );
    }
    try {
      const result = await startLocalBrollGeneration({
        workspaceId: session.ws,
        projectId,
        sourceScriptId: scriptId,
        rowSignature,
        rowIndex,
        productionDocId,
        visualDescription,
        aiImagePrompt: aiImagePrompt || undefined,
        styleHint,
        modelId,
        aspectRatio: aspectRatioRaw,
        durationSeconds,
        stillImageUrl,
      });
      return NextResponse.json({ ...result, model_id: modelId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 502 });
    }
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
      productionDocId,
      visualDescription,
      aiImagePrompt: aiImagePrompt || undefined,
      styleHint,
      modelId,
      aspectRatio: aspectRatioRaw,
      durationSeconds,
      stillImageUrl,
      kieApiKey: apiKey,
    });
    return NextResponse.json({ ...result, model_id: modelId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
});
