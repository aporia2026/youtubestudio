import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { removeFromWatchlist } from '@/lib/niche-finder/watchlist';
import { slugifyNiche } from '@/lib/niche-finder/slug';

/**
 * DELETE /api/niche-finder/watchlist/[slug]
 *
 * Idempotent — returns 200 whether or not a row was deleted. The
 * UI consumes only the response status; the body reports whether
 * the row existed.
 */
export const DELETE = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;
    const canonical = slugifyNiche(slug);
    const removed = await removeFromWatchlist(session.ws, canonical);
    return NextResponse.json({ removed });
  },
);
