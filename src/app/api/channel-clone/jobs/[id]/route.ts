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
import { deleteR2Prefix } from '@/lib/channel-clone/templates-r2';
import { logger } from '@/lib/logger';

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
  // Fire-and-forget the staging-prefix cleanup. 2026-06-08 — we
  // dropped the 7-day R2 lifecycle on this prefix so reuse stays
  // possible indefinitely; the only way the prefix gets reclaimed
  // now is when the operator deletes the run (here) or saves it as
  // a template (which migrates into the templates prefix). Errors
  // are swallowed so a slow R2 doesn't bubble back to the user.
  void deleteR2Prefix(`channel-clone-uploads-staging/${session.ws}/${id}/`).catch((err) => {
    logger.warn('[channel-clone job-delete] staging prefix cleanup failed', {
      jobId: id, error: err instanceof Error ? err.message : String(err),
    });
  });
  return NextResponse.json({ ok: true });
});
