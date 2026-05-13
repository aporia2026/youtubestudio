import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  addNicheFavorite,
  isValidSourceTab,
  listFavoritesWithVideos,
  type FavoriteSourceTab,
} from '@/lib/niche-finder/favorites';
import { kickoffBrief } from '@/lib/niche-finder/brief-runner';
import { slugifyNiche, normalizeNicheName } from '@/lib/niche-finder/slug';
import { logger } from '@/lib/logger';
import type { NicheScores } from '@/lib/niche-finder/types';

/**
 * GET  /api/niche-finder/favorites
 *   → { favorites: NicheFavoriteWithVideos[] }
 *
 * POST /api/niche-finder/favorites
 *   Body: { nicheSlug: string,
 *           nicheName?: string,
 *           sourceTab: 'type'|'interests'|'channel'|'category'|'outliers'|'manual',
 *           scores: NicheScores }
 *   → { favorite: NicheFavoriteRow }
 *
 * POST is idempotent — re-favoriting a slug refreshes the snapshot
 * fields and un-soft-deletes if the favorite was in the 30-day
 * restore bin. Status / verdict / outcome / notes are preserved on
 * re-favorite so a button mash from a different tab doesn't wipe
 * operator state.
 */
export const GET = apiRoute.authed(async (session) => {
  const favorites = await listFavoritesWithVideos(session.ws);
  return NextResponse.json({ favorites });
});

function parseString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Structural guard for NicheScores. We don't deeply validate every
 *  field — the snapshot is operator-trusted (it came from our own
 *  scoring engine on the same page). We just check the shape exists
 *  enough that the JSONB column won't be storing garbage. */
function isPlausibleScores(v: unknown): v is NicheScores {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.combined === 'number' &&
    typeof o.demand === 'object' &&
    typeof o.supply === 'object' &&
    typeof o.monetization === 'object' &&
    typeof o.fit === 'object'
  );
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

  const slugInput = parseString(raw.nicheSlug, 80);
  if (!slugInput) {
    return NextResponse.json({ error: 'nicheSlug is required' }, { status: 400 });
  }
  const slug = slugifyNiche(slugInput);

  const explicitName = parseString(raw.nicheName, 120);
  const nicheName = explicitName ?? normalizeNicheName(slug.replace(/-/g, ' '));

  const sourceTabRaw = raw.sourceTab;
  if (!isValidSourceTab(sourceTabRaw)) {
    return NextResponse.json(
      { error: "sourceTab must be one of 'type','interests','channel','category','outliers','manual'" },
      { status: 400 },
    );
  }
  const sourceTab: FavoriteSourceTab = sourceTabRaw;

  if (!isPlausibleScores(raw.scores)) {
    return NextResponse.json(
      { error: 'scores must be a NicheScores object (with combined/demand/supply/monetization/fit)' },
      { status: 400 },
    );
  }

  try {
    const favorite = await addNicheFavorite({
      workspaceId: session.ws,
      userId: session.uid,
      nicheSlug: slug,
      nicheName,
      sourceTab,
      scores: raw.scores,
    });
    // Fire-and-forget brief kickoff. `kickoffBrief` is no-op when scores
    // are placeholder, when a brief already exists, or when a brief is
    // already in flight — so re-favoriting an existing niche is safe.
    kickoffBrief({
      workspaceId: session.ws,
      nicheSlug: favorite.niche_slug,
    }).catch((err) => {
      logger.error('niche-finder: auto-kickoff brief failed', {
        detail: err instanceof Error ? err.message : String(err),
        workspace_id: session.ws,
        niche_slug: favorite.niche_slug,
      });
    });
    return NextResponse.json({ favorite });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: favorite add',
      fallbackMessage: 'Could not save this favorite.',
    });
  }
});
