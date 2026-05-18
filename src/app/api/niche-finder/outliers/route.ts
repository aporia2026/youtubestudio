import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { findOutliers } from '@/lib/niche-finder/outliers';
import {
  dispatchGeneralOutliers,
  type GeneralOutlierSource,
} from '@/lib/niche-finder/outliers-general';

/**
 * POST /api/niche-finder/outliers
 *
 * Discriminated body:
 *
 *   { source: 'niche', niche: string, language?, region? }
 *     — original per-niche search.
 *
 *   { source: 'breakouts' }
 *     — operator's own channel-breakout fires from the last 90d.
 *
 *   { source: 'trending', regionCode?: string }
 *     — YouTube's regional trending list.
 *
 *   { source: 'favorites' }
 *     — outliers across the operator's first few favorited niches.
 *
 * Backward compat: { niche: 'foo' } without `source` is treated as
 * { source: 'niche', niche: 'foo' } so existing callers keep working.
 *
 * Returns { niche, videos, fetchOk } in every case so the UI renders
 * uniformly. For general sources, `niche` is a descriptive label.
 */
function parseOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

const GENERAL_SOURCES: readonly GeneralOutlierSource[] = ['breakouts', 'trending', 'favorites'];
function isGeneralSource(v: unknown): v is GeneralOutlierSource {
  return typeof v === 'string' && (GENERAL_SOURCES as readonly string[]).includes(v);
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
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
  // Backward compat: pre-source callers send { niche } only — treat
  // as source='niche'.
  const source =
    typeof raw.source === 'string' ? raw.source : raw.niche ? 'niche' : null;

  if (source === 'niche' || source === null) {
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
        op: 'niche-finder: outliers (niche)',
        fallbackMessage: 'Could not load outliers. Try again in a moment.',
      });
    }
  }

  if (!isGeneralSource(source)) {
    return NextResponse.json(
      { error: "source must be one of 'niche', 'breakouts', 'trending', 'favorites'" },
      { status: 400 },
    );
  }

  try {
    const result = await dispatchGeneralOutliers({
      workspaceId: session.ws,
      source,
      regionCode: parseOptionalString(raw.regionCode, 4),
      language: parseOptionalString(raw.language, 16),
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: `niche-finder: outliers (${source})`,
      fallbackMessage: 'Could not load outliers. Try again in a moment.',
    });
  }
});
