import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import {
  effectiveSettings,
  getStoredTtsSettings,
  updateTtsSettings,
} from '@/lib/tts/workspace-settings';

/**
 * GET  /api/workspace/tts-settings
 *   Returns both the raw stored settings (so the UI knows what the
 *   user explicitly picked vs. defaulted) and the effective settings
 *   (so callers that just want the resolved values don't have to
 *   merge themselves).
 *
 *   Response: { stored: WorkspaceTtsSettings, effective: EffectiveTtsSettings }
 *
 * PUT /api/workspace/tts-settings
 *   Body: WorkspaceTtsSettings (partial). Merged with existing.
 *   Validated server-side — unknown keys are dropped, invalid enum
 *   values silently ignored. Empty `enabledProviders` array is
 *   treated as "no restriction" rather than locking everyone out.
 *
 *   Response: { stored: WorkspaceTtsSettings, effective: EffectiveTtsSettings }
 */

export const GET = apiRoute.authed(async (session) => {
  const stored = await getStoredTtsSettings(session.ws);
  return NextResponse.json({
    stored,
    effective: effectiveSettings(stored),
  });
});

export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const stored = await updateTtsSettings(session.ws, body);
  logger.info('[tts workspace-settings] updated', {
    workspaceId: session.ws,
    settingKeys: Object.keys(stored),
  });
  return NextResponse.json({
    stored,
    effective: effectiveSettings(stored),
  });
});
