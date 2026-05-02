import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getCriticPanel, listCriticPanelEvents } from '@/lib/critic-panels';

export const maxDuration = 30;

/**
 * GET /api/critics/panels/[id]/events?since=N
 *
 * Replay endpoint. Returns every event with sequence_no > N for the given
 * panel. Used by clients that disconnected mid-run and need to catch up
 * before tailing — and by the courtroom UI on initial load to populate
 * its timeline before opening a fresh SSE stream for new events.
 *
 * Returns the panel's current `status` so the caller can decide whether
 * to keep polling. When status is 'completed' or 'failed', no further
 * events will arrive.
 */
export const GET = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { searchParams } = new URL(req.url);
    const since = Number.parseInt(searchParams.get('since') ?? '0', 10);
    const sinceSequence = Number.isFinite(since) && since >= 0 ? since : 0;

    const panel = await getCriticPanel(id, session.ws);
    if (!panel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const events = await listCriticPanelEvents(id, session.ws, { sinceSequence });
    return NextResponse.json({
      status: panel.status,
      events,
      latest_sequence: events.length > 0 ? events[events.length - 1]!.sequence_no : sinceSequence,
    });
  },
);
