/**
 * Publishing pipeline — single read.
 *
 * GET /api/publishing/[id] returns the row, scoped to the workspace.
 * Pure DB read — does NOT call YouTube. The client polls
 * `/api/publishing/[id]/poll` explicitly when it wants fresh status.
 *
 * Why split? Auto-polling YouTube on every GET stacks up fast: the
 * modal polls every 5s, the hourly cron also polls, page-list reads
 * implicitly poll too. With a single active publish that's 12+
 * YouTube requests per minute against a single videoId — quota waste.
 */

import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getPublishedVideo } from '@/lib/publishing';

export const maxDuration = 30;

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const row = await getPublishedVideo(id, session.ws);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ publish: row });
  },
);
