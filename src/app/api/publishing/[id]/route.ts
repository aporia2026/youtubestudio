/**
 * Publishing pipeline — single read.
 *
 * GET /api/publishing/[id] returns the row, scoped to the workspace.
 * If the row is in 'processing', it auto-polls YouTube once before
 * responding so the client always gets the freshest status without
 * needing a separate polling endpoint for the common "open the page,
 * see the latest" flow.
 */

import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getPublishedVideo, pollPublishStatus } from '@/lib/publishing';

export const maxDuration = 30;

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const row = await getPublishedVideo(id, session.ws);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Cheap freshness — if the row is still processing, poll once
    // before responding. The client doesn't have to know about the
    // poll endpoint to see the latest status.
    if (row.status === 'processing') {
      try {
        await pollPublishStatus(id, session.ws);
      } catch {
        // Polling is best-effort here; the stale row is fine to return.
      }
      const refreshed = await getPublishedVideo(id, session.ws);
      return NextResponse.json({ publish: refreshed ?? row });
    }
    return NextResponse.json({ publish: row });
  },
);
