import { NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { deleteSeries, getSeries } from '@/lib/shorts-series';

/**
 * GET    /api/shorts/series/[id]    — read one (workspace-scoped, 404 cross-tenant)
 * DELETE /api/shorts/series/[id]    — remove the series; the FK on
 *                                     `shorts.series_id` is ON DELETE SET NULL,
 *                                     so existing Shorts stay around without
 *                                     a series link.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const series = await getSeries(id, session.ws);
      if (!series) return NextResponse.json({ error: 'Series not found' }, { status: 404 });
      return NextResponse.json({ series });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: read series',
        fallbackMessage: 'Failed to load the Shorts series.',
      });
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const ok = await deleteSeries(id, session.ws);
      if (!ok) return NextResponse.json({ error: 'Series not found' }, { status: 404 });
      logger.info('[shorts series delete]', { workspaceId: session.ws, seriesId: id });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: delete series',
        fallbackMessage: 'Failed to delete the series.',
      });
    }
  },
);
