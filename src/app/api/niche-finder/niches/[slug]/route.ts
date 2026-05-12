import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getNicheReport } from '@/lib/niche-finder/db';
import { slugifyNiche } from '@/lib/niche-finder/slug';

/**
 * GET /api/niche-finder/niches/[slug]
 *
 * Reads the cached deep-dive report for the workspace + slug.
 *
 * Returns:
 *   200 { report }   — happy path
 *   404              — no report exists for this slug in this
 *                      workspace. Same status used for
 *                      cross-workspace ids to avoid existence
 *                      leaks (matches the competitors-route
 *                      hardening from Phase 8.1).
 *
 * The slug is renormalised via `slugifyNiche` before lookup so
 * stray casing or punctuation in the URL still collides on the
 * canonical row.
 */
export const GET = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;
    const canonical = slugifyNiche(slug);
    const report = await getNicheReport(session.ws, canonical);
    if (!report) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ report });
  },
);
