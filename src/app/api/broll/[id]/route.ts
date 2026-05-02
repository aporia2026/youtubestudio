import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteBrollClip, getAndAdvanceBrollClip, getBrollClip } from '@/lib/broll';

export const maxDuration = 30;

/**
 * GET /api/broll/[id]
 *
 * Read the clip and, if it's still 'generating', do ONE Kie status check
 * inline (cheap, ~1s) and persist the result. Clients poll this endpoint
 * every 5-10s until status === 'ready' | 'failed'.
 *
 * If KIE_API_KEY is missing the row is returned as-is (the fetch path
 * just doesn't advance) so the UI keeps working in "read-only" mode for
 * historical clips even when the integration is offline.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const apiKey = process.env.KIE_API_KEY;
    const clip = apiKey
      ? await getAndAdvanceBrollClip(id, session.ws, apiKey)
      : await getBrollClip(id, session.ws);
    if (!clip) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ clip });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteBrollClip(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
