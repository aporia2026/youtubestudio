import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings, updateUserSettings } from '@/lib/user-settings';

/**
 * GET /api/user/settings/tts-favorites
 *
 * Returns the user's favorited TTS voices.
 *
 * POST /api/user/settings/tts-favorites
 * Body: { providerId: string, voiceId: string, action: 'add' | 'remove' | 'toggle' }
 *
 * Mutates the favorites list. 'toggle' adds if absent, removes if
 * present — the common case for a star-button UI. Returns the new
 * list so the client doesn't have to re-fetch.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 */
export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  return NextResponse.json({ favorites: settings.tts_favorite_voices ?? [] });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: { providerId?: string; voiceId?: string; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.providerId || !body.voiceId) {
    return NextResponse.json(
      { error: 'providerId and voiceId required' },
      { status: 400 },
    );
  }

  const action = body.action ?? 'toggle';
  if (action !== 'add' && action !== 'remove' && action !== 'toggle') {
    return NextResponse.json(
      { error: "action must be one of 'add' | 'remove' | 'toggle'" },
      { status: 400 },
    );
  }

  const current = await getUserSettings(session.uid);
  const list = current.tts_favorite_voices ?? [];
  const idx = list.findIndex(
    (f) => f.providerId === body.providerId && f.voiceId === body.voiceId,
  );
  const exists = idx >= 0;

  let next = list;
  if (action === 'add' || (action === 'toggle' && !exists)) {
    if (!exists) next = [...list, { providerId: body.providerId, voiceId: body.voiceId }];
  } else if (action === 'remove' || (action === 'toggle' && exists)) {
    if (exists) next = list.filter((_, i) => i !== idx);
  }

  await updateUserSettings(session.uid, { tts_favorite_voices: next });
  return NextResponse.json({ favorites: next });
});
