import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteCriticPanel, getCriticPanel, listCriticPanelEvents } from '@/lib/critic-panels';

export const maxDuration = 30;

/**
 * GET /api/critics/panels/[id]
 *
 * Returns the panel row + the full event transcript (chronological).
 * Used both for completed-panel detail views and for clients that want
 * the whole story without the SSE stream.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const panel = await getCriticPanel(id, session.ws);
    if (!panel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const events = await listCriticPanelEvents(id, session.ws);
    return NextResponse.json({ panel, events });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteCriticPanel(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
