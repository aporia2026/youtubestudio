import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listRecentlyRemovedFavorites } from '@/lib/niche-finder/favorites';

/**
 * GET /api/niche-finder/favorites/recently-removed
 *   → { favorites: NicheFavoriteRow[] }
 *
 * Soft-deleted favorites still inside the 30-day restore window.
 * Used by the "Recently removed" disclosure at the bottom of the
 * Favorites tab.
 */
export const GET = apiRoute.authed(async (session) => {
  const favorites = await listRecentlyRemovedFavorites(session.ws);
  return NextResponse.json({ favorites });
});
