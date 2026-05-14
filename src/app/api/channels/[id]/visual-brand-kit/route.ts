import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  getChannelVisualBrandKit,
  updateChannelVisualBrandKit,
  ChannelNotFoundError,
} from '@/lib/channel-visual-brand-kit';

/**
 * GET /api/channels/[id]/visual-brand-kit
 *
 * Returns the channel's visual brand kit (workspace-scoped). 404 if the
 * channel doesn't belong to the user's workspace — same not-found-leak
 * policy as the script brand-kit route next door.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const kit = await getChannelVisualBrandKit(id, session.ws);
    if (!kit) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ visual_brand_kit: kit });
  },
);

/**
 * PUT /api/channels/[id]/visual-brand-kit  body: ChannelVisualBrandKit (partial OK)
 *
 * Replaces the channel's visual brand kit with the provided patch. The patch
 * is sanitised through parseVisualBrandKit before persistence so unknown
 * font names, malformed hex colors, and off-allowlist logo URLs are
 * silently dropped — the request never persists invalid state, no matter
 * how clean the route-level validation is.
 */
export const PUT = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
    }
    try {
      const saved = await updateChannelVisualBrandKit(
        id,
        session.ws,
        body as Parameters<typeof updateChannelVisualBrandKit>[2],
      );
      return NextResponse.json({ visual_brand_kit: saved });
    } catch (err) {
      if (err instanceof ChannelNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }
  },
);
