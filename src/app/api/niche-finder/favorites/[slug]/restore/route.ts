import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { restoreFavorite } from '@/lib/niche-finder/favorites';
import { slugifyNiche } from '@/lib/niche-finder/slug';

/**
 * POST /api/niche-finder/favorites/[slug]/restore
 *   → { restored: boolean }
 *
 * Lifts a favorite out of the 30-day soft-delete bin. Idempotent —
 * restoring an already-live favorite returns `{ restored: false }`
 * (no row was changed). Cross-workspace slugs also return false,
 * mirroring the DELETE pattern, so the endpoint doesn't leak
 * existence.
 */
export const POST = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug: raw } = await params;
    const slug = slugifyNiche(raw);
    const restored = await restoreFavorite(session.ws, slug);
    return NextResponse.json({ restored });
  },
);
