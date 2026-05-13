/**
 * Per-workspace AI model defaults.
 *
 * GET    → current defaults blob ({ workspace, sections, features })
 *          plus the catalogues the UI needs to render (FEATURE_SECTIONS,
 *          APP_FEATURES) so a single fetch hydrates the Settings page.
 * PUT    → upsert one scope. Body: { scope: 'workspace' | 'section:<s>' |
 *          'feature:<f>', modelId: string }
 * DELETE → clear one scope (revert to inherit). Query: ?scope=…
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  decodeScope,
  encodeScope,
  getDefaults,
  setDefault,
} from '@/lib/model-defaults';
import { APP_FEATURES, FEATURE_SECTIONS, getModelById } from '@/lib/ai-models';
import { logger } from '@/lib/logger';

export const GET = apiRoute.authed(async (session) => {
  const defaults = await getDefaults(session.ws);
  return NextResponse.json({
    defaults,
    sections: FEATURE_SECTIONS,
    features: APP_FEATURES,
  });
});

export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const rawScope = typeof b.scope === 'string' ? b.scope : '';
  const modelId = typeof b.modelId === 'string' ? b.modelId : '';
  const scope = decodeScope(rawScope);
  if (!scope) return NextResponse.json({ error: 'Unknown scope' }, { status: 400 });
  if (!modelId) return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
  if (!getModelById(modelId)) {
    return NextResponse.json({ error: 'Unknown modelId' }, { status: 400 });
  }
  // Surface the actual SQL / runtime error instead of letting the
  // generic 500 mask the cause. This is an admin-only surface so
  // exposing the underlying message is acceptable — and necessary
  // when the picker is the only diagnostic interface available.
  try {
    await setDefault(session.ws, scope, modelId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('model-defaults PUT: setDefault failed', {
      scope: encodeScope(scope),
      model_id: modelId,
      workspace_id: session.ws,
      detail,
    });
    return NextResponse.json(
      { error: 'Could not save model preference', detail },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, scope: encodeScope(scope), modelId });
});

export const DELETE = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const rawScope = searchParams.get('scope') || '';
  const scope = decodeScope(rawScope);
  if (!scope) return NextResponse.json({ error: 'Unknown scope' }, { status: 400 });
  await setDefault(session.ws, scope, null);
  return NextResponse.json({ ok: true, scope: encodeScope(scope) });
});
