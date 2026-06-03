import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings, updateUserSettings } from '@/lib/user-settings';
import { logger } from '@/lib/logger';

/**
 * Phase 15.14 — per-user default vendor for the GPT Image 2 Edit
 * operation. Surfaced by the Shorts editor's vendor toggle so the
 * user's choice sticks across sessions. Routes that consume the
 * setting fall through `body override > UserSettings > 'atlas'`.
 *
 *   GET  → current setting (null when unset; the consumer applies the
 *          'atlas' floor itself).
 *   POST { primary: 'atlas' | 'kie' | null } → persist.
 *
 * Mirrors `active-channel/route.ts` shape.
 */
export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  return NextResponse.json({
    gpt_image_2_edit_primary: settings.gpt_image_2_edit_primary ?? null,
  });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const raw = (body as { primary?: unknown } | null)?.primary;
  let primary: 'atlas' | 'kie' | null;
  if (raw === null || raw === undefined || raw === '') {
    primary = null;
  } else if (raw === 'atlas' || raw === 'kie') {
    primary = raw;
  } else {
    return NextResponse.json(
      { error: "primary must be 'atlas', 'kie', or null" },
      { status: 400 },
    );
  }

  await updateUserSettings(session.uid, { gpt_image_2_edit_primary: primary });
  logger.info('[user settings gpt-image-2-edit-primary] updated', {
    userId: session.uid,
    primary,
  });
  return NextResponse.json({ ok: true, gpt_image_2_edit_primary: primary });
});
