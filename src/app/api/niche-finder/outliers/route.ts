import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { findOutliers } from '@/lib/niche-finder/outliers';

/**
 * POST /api/niche-finder/outliers
 *
 * Mode D (outlier finder). Body:
 *   {
 *     niche: string,           // required — niche to search
 *     language?: string,
 *     region?: string
 *   }
 *
 * Returns { niche, videos, fetchOk }.
 */
function parseOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

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
  const niche = parseOptionalString(raw.niche, 120);
  if (!niche) {
    return NextResponse.json({ error: 'niche is required' }, { status: 400 });
  }

  try {
    const result = await findOutliers({
      niche,
      language: parseOptionalString(raw.language, 16),
      region: parseOptionalString(raw.region, 16),
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: outliers',
      fallbackMessage: 'Could not load outliers. Try again in a moment.',
    });
  }
});
