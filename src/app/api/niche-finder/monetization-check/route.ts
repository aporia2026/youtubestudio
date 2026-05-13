import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { checkVideoMonetization } from '@/lib/niche-finder/monetization-scrape';

/**
 * POST /api/niche-finder/monetization-check
 *
 * On-demand monetization lookup for a single outlier video. The
 * Data API doesn't publish monetization status for channels we
 * don't own, so we fetch the public watch page and parse the
 * ytInitialPlayerResponse JSON. See `monetization-scrape.ts` for
 * the detection logic and ToS / fragility notes.
 *
 * Authed-only by design — anonymous traffic could be used to
 * amplify our scrape rate.
 *
 * Body:
 *   { videoId: string, forceRefresh?: boolean }
 *
 * Returns:
 *   {
 *     videoId, status: 'monetized' | 'not-monetized' | 'unknown',
 *     reason: string, checkedAt: ISO, cached: boolean,
 *   }
 *
 * Errors:
 *   400 — missing or malformed videoId
 *
 * The scraper itself never throws on parse / fetch failure; it
 * degrades to `status: 'unknown'` with a reason. The route only
 * surfaces 5xx for genuinely unexpected exceptions.
 */
export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;
  const videoId = typeof raw.videoId === 'string' ? raw.videoId.trim() : '';
  if (!videoId) {
    return NextResponse.json({ error: 'videoId is required' }, { status: 400 });
  }
  const forceRefresh = raw.forceRefresh === true;

  try {
    const result = await checkVideoMonetization(videoId, { forceRefresh });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: monetization-check',
      fallbackMessage: 'Could not check monetization. Try again in a moment.',
    });
  }
});
