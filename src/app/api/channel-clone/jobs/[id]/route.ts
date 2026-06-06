/**
 * /api/channel-clone/jobs/[id]
 *
 *   GET    — return the current state of a channel-clone job. The
 *            client polls this while the intake runner is doing
 *            subprocess work to keep the UI status indicator current.
 *   DELETE — permanently remove the row. Used by the recent-runs
 *            list's per-row delete button.
 *
 * Workspace-scoped: a job id from a different workspace returns 404
 * rather than 403 so we don't leak existence across workspace
 * boundaries.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, type RouteContext } from '@/lib/route-helpers';
import {
  deleteChannelCloneJob,
  getChannelCloneJob,
} from '@/lib/channel-clone/job-store';

export const maxDuration = 10;

type Params = { id: string };

export const GET = apiRoute.authed(async (session, _req: NextRequest, ctx: RouteContext<Params>) => {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: 'job id is required' }, { status: 400 });
  }
  const row = await getChannelCloneJob(id, session.ws);
  if (!row) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  return NextResponse.json({
    id: row.id,
    sourceChannelUrl: row.source_channel_url,
    sourceCanonicalUrl: row.source_canonical_url,
    status: row.status,
    state: row.state_jsonb,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

export const DELETE = apiRoute.authed(async (session, _req: NextRequest, ctx: RouteContext<Params>) => {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: 'job id is required' }, { status: 400 });
  }
  const ok = await deleteChannelCloneJob(id, session.ws);
  if (!ok) {
    // No-op delete is indistinguishable from cross-tenant id —
    // 404 for both keeps existence private.
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
});
