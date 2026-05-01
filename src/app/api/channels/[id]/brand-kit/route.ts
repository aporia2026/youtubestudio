import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  getChannelBrandKit,
  updateChannelBrandKit,
  ChannelNotFoundError,
} from '@/lib/channel-brand-kit';

/**
 * GET /api/channels/[id]/brand-kit
 *
 * Returns the channel's brand kit (workspace-scoped). 404 if the channel
 * doesn't belong to the user's workspace.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const kit = await getChannelBrandKit(id, session.ws);
    if (!kit) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ brand_kit: kit });
  },
);

/**
 * PUT /api/channels/[id]/brand-kit  body: ChannelBrandKit (partial OK)
 *
 * Replaces the channel's brand kit with the provided patch. The patch is
 * sanitized through parseBrandKit before persistence so unexpected fields
 * are dropped and array sizes are capped.
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
      const saved = await updateChannelBrandKit(
        id,
        session.ws,
        body as Parameters<typeof updateChannelBrandKit>[2],
      );
      return NextResponse.json({ brand_kit: saved });
    } catch (err) {
      if (err instanceof ChannelNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }
  },
);
