import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings, updateUserSettings } from '@/lib/user-settings';

/**
 * GET /api/user/settings/default-style
 *
 * Returns the user's default visual-style preset for the production-doc
 * form. Falls back to the library default ('doodle_explainer') when the
 * user hasn't set one. Mirrors the broll-default route's shape so the
 * client can use the same pattern.
 *
 * Response: { stylePreset: string, isExplicit: boolean }
 *
 * Storage backing: collaborators.encrypted_settings (versioned JSON).
 * No new migration — the column has existed since 0003 and the
 * `default_style_preset` field gets parsed in alongside the existing
 * `default_broll_model_id`.
 */

const LIBRARY_DEFAULT_STYLE = 'doodle_explainer';

export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  const stored = settings.default_style_preset ?? null;
  const stylePreset = stored || LIBRARY_DEFAULT_STYLE;
  return NextResponse.json({ stylePreset, isExplicit: Boolean(stored) });
});

/**
 * PUT /api/user/settings/default-style  body: { stylePreset: string | null }
 *
 * Set or clear the user's default. `null` (or omitted) clears it. We do
 * NOT validate the preset against the style registry here — built-in
 * slugs and workspace-saved style UUIDs are both valid, and the registry
 * lookup happens server-side at doc-generation time anyway. Just enforce
 * basic length / type constraints so a malformed body can't bloat the
 * encrypted blob.
 */
export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const raw = (body as { stylePreset?: unknown } | null)?.stylePreset;

  let stylePreset: string | null;
  if (raw === null || raw === undefined || raw === '') {
    stylePreset = null;
  } else if (typeof raw === 'string') {
    if (raw.length > 200) {
      return NextResponse.json({ error: 'stylePreset too long' }, { status: 400 });
    }
    stylePreset = raw;
  } else {
    return NextResponse.json({ error: 'stylePreset must be a string or null' }, { status: 400 });
  }

  await updateUserSettings(session.uid, { default_style_preset: stylePreset });
  return NextResponse.json({
    ok: true,
    stylePreset: stylePreset ?? LIBRARY_DEFAULT_STYLE,
    isExplicit: stylePreset !== null,
  });
});
