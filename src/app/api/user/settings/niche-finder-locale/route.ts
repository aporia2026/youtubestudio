import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings, updateUserSettings } from '@/lib/user-settings';
import {
  ALLOWED_LANGUAGES,
  ALLOWED_REGIONS,
  DEFAULT_LANGUAGE,
  DEFAULT_REGION,
} from '@/lib/niche-finder/locales';

/**
 * GET /api/user/settings/niche-finder-locale
 *
 * Returns the user's niche-finder language + region with the global
 * defaults ('en' / 'US') applied when unset. Mirrors the
 * default-style / broll-default routes' shape.
 *
 * Response: { language, region, isExplicit }
 *
 * Storage: collaborators.encrypted_settings — `niche_finder_language`
 * and `niche_finder_region` fields. No migration needed.
 */
export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  const storedLang = settings.niche_finder_language ?? null;
  const storedRegion = settings.niche_finder_region ?? null;
  return NextResponse.json({
    language: storedLang || DEFAULT_LANGUAGE,
    region: storedRegion || DEFAULT_REGION,
    isExplicit: Boolean(storedLang || storedRegion),
  });
});

/**
 * PUT /api/user/settings/niche-finder-locale
 *   body: { language?: string | null; region?: string | null }
 *
 * Set or clear either field. `null` clears that field. Validates
 * against the ALLOWED_LANGUAGES / ALLOWED_REGIONS allow-lists so a
 * stray ISO code can't drift downstream into the YouTube API call.
 */
export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const raw = (body ?? {}) as Record<string, unknown>;

  const patch: { niche_finder_language?: string | null; niche_finder_region?: string | null } = {};

  if ('language' in raw) {
    const v = raw.language;
    if (v === null || v === '') {
      patch.niche_finder_language = null;
    } else if (typeof v === 'string' && ALLOWED_LANGUAGES.some((l) => l.code === v)) {
      patch.niche_finder_language = v;
    } else {
      return NextResponse.json({ error: 'Unsupported language' }, { status: 400 });
    }
  }

  if ('region' in raw) {
    const v = raw.region;
    if (v === null || v === '') {
      patch.niche_finder_region = null;
    } else if (typeof v === 'string' && ALLOWED_REGIONS.some((r) => r.code === v)) {
      patch.niche_finder_region = v;
    } else {
      return NextResponse.json({ error: 'Unsupported region' }, { status: 400 });
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Pass language and/or region' }, { status: 400 });
  }

  const merged = await updateUserSettings(session.uid, patch);
  return NextResponse.json({
    ok: true,
    language: merged.niche_finder_language || DEFAULT_LANGUAGE,
    region: merged.niche_finder_region || DEFAULT_REGION,
    isExplicit: Boolean(merged.niche_finder_language || merged.niche_finder_region),
  });
});
