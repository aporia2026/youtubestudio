import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { removeFavoriteVideo } from '@/lib/niche-finder/favorites';
import { slugifyNiche } from '@/lib/niche-finder/slug';

/**
 * DELETE /api/niche-finder/favorites/[slug]/videos/[videoId]
 *   → { removed: boolean }
 *
 * Idempotent — returns 200 whether or not a row was removed. The UI
 * uses the response status; the body reports the actual effect for
 * the toast.
 */
export const DELETE = apiRoute.authed(
  async (
    session,
    _req,
    { params }: { params: Promise<{ slug: string; videoId: string }> },
  ) => {
    const { slug: rawSlug, videoId } = await params;
    const slug = slugifyNiche(rawSlug);
    // The video id itself is opaque text — we don't normalise it.
    // Cap to a reasonable length so the URL param can't be abused.
    if (typeof videoId !== 'string' || videoId.length === 0 || videoId.length > 64) {
      return NextResponse.json({ error: 'Invalid videoId' }, { status: 400 });
    }
    const removed = await removeFavoriteVideo({
      workspaceId: session.ws,
      nicheSlug: slug,
      videoId,
    });
    return NextResponse.json({ removed });
  },
);
