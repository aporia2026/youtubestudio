/**
 * DELETE /api/niche-finder/watchlist/searches/[slug]
 *
 * Idempotent. Cross-workspace ids return `{ removed: false }` rather
 * than 403 to avoid existence leaks (mirrors the outlier-preset
 * delete pattern at /api/niche-finder/outliers/presets/[id]).
 *
 * Only deletes rows with `kind='search'` — niche-watchlist rows have
 * their own DELETE at /api/niche-finder/watchlist/[slug].
 */
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  isSavedSearchSlug,
  removeSavedSearch,
} from '@/lib/niche-finder/watchlist';

export const DELETE = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;
    if (!isSavedSearchSlug(slug)) {
      // Not-a-search-slug shapes return removed:false so the UI uses
      // one code path regardless of input.
      return NextResponse.json({ removed: false }, { status: 200 });
    }
    const removed = await removeSavedSearch(session.ws, slug);
    return NextResponse.json({ removed });
  },
);
