import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  addToWatchlist,
  listWatchlist,
  snapshotFromScores,
} from '@/lib/niche-finder/watchlist';
import { getNicheReport } from '@/lib/niche-finder/db';
import { slugifyNiche, normalizeNicheName } from '@/lib/niche-finder/slug';

/**
 * GET  /api/niche-finder/watchlist          → { rows: NicheWatchlistRow[] }
 * POST /api/niche-finder/watchlist          → { row }
 *   Body: { nicheSlug: string, nicheName?: string }
 *
 * POST is idempotent — re-saving an already-watched niche is a
 * no-op (preserves history). When a current niche_reports row
 * exists for this workspace + slug, we seed the watchlist's first
 * snapshot from it so the sparkline isn't empty on day one.
 */
export const GET = apiRoute.authed(async (session) => {
  const rows = await listWatchlist(session.ws);
  return NextResponse.json({ rows });
});

function parseOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
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
  const slugInput = parseOptionalString(raw.nicheSlug, 80);
  if (!slugInput) {
    return NextResponse.json({ error: 'nicheSlug is required' }, { status: 400 });
  }
  const slug = slugifyNiche(slugInput);
  const explicitName = parseOptionalString(raw.nicheName, 120);

  try {
    // Seed the first snapshot from the persisted deep-dive report if
    // one exists — that way the sparkline shows a real point on day
    // one rather than waiting a week for the cron.
    const report = await getNicheReport(session.ws, slug);
    const nicheName = explicitName ?? report?.name ?? normalizeNicheName(slug.replace(/-/g, ' '));
    const initialSnapshot = report
      ? snapshotFromScores(report.scores, new Date().toISOString())
      : undefined;
    const row = await addToWatchlist({
      workspaceId: session.ws,
      nicheSlug: slug,
      nicheName,
      initialSnapshot,
    });
    return NextResponse.json({ row });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: watchlist add',
      fallbackMessage: 'Could not save this niche.',
    });
  }
});
