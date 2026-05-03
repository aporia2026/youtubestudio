/**
 * Publishing pipeline — explicit YouTube status poll.
 *
 * POST /api/publishing/[id]/poll
 *
 * Hits the YouTube Data API once for this row's video, persists the
 * latest upload/processing/privacy status, and returns the updated
 * row. The publish modal calls this every 5s while the row is in
 * 'processing'; non-active surfaces (page list, status badge in
 * /projects) just GET the row and let the hourly cron flip it
 * eventually.
 *
 * Splitting poll into its own POST keeps the GET cheap and avoids
 * the YouTube-quota waste of polling on every read (audit M9).
 */

import { NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { getPublishedVideo, pollPublishStatus } from '@/lib/publishing';

export const maxDuration = 30;

export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const existing = await getPublishedVideo(id, session.ws);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Terminal states are no-ops — return immediately. Polling YouTube
    // for a 'live' or 'failed' row would burn quota for nothing.
    if (existing.status === 'live' || existing.status === 'failed') {
      return NextResponse.json({ publish: existing });
    }

    try {
      await pollPublishStatus(id, session.ws);
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'publishing: poll',
        knownPatterns: [{ match: /not found/i, status: 404 }],
        fallbackMessage: 'Could not refresh status from YouTube.',
      });
    }
    const refreshed = await getPublishedVideo(id, session.ws);
    return NextResponse.json({ publish: refreshed ?? existing });
  },
);
