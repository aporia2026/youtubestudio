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
  await setDefault(session.ws, scope, modelId);
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
