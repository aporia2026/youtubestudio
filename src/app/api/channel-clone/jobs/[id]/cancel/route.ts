/**
 * POST /api/channel-clone/jobs/[id]/cancel
 *
 * Mark a channel-clone job for cancellation. The DB UPDATE sets
 * `state_jsonb.cancelRequested = true` AND flips the row's status to
 * `'cancelled'` in one atomic write, but only when the job is in an
 * active state (`*_running` / `intake_pending`). Terminal jobs
 * (`*_complete`, `*_failed`, `archived`, already-`cancelled`) reply
 * 409 so the UI knows nothing happened.
 *
 * The runner polls `cancelRequested` between every step and bails
 * cleanly into its finally block when it sees true — so a sandbox
 * mid-flight gets stopped (CPU refunded sooner than the auto-reap)
 * and a partially-built `state_jsonb.intake` is left in place for
 * post-mortem.
 *
 * Workspace-scoped: a cross-tenant id is indistinguishable from a
 * non-existent id (both return 404). Auth is enforced by
 * `apiRoute.authed`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, type RouteContext } from '@/lib/route-helpers';
import {
  getChannelCloneJob,
  requestChannelCloneJobCancel,
} from '@/lib/channel-clone/job-store';
import { logger } from '@/lib/logger';

export const maxDuration = 10;

type Params = { id: string };

export const POST = apiRoute.authed(
  async (session, _req: NextRequest, ctx: RouteContext<Params>) => {
    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json({ error: 'job id is required' }, { status: 400 });
    }
    const ok = await requestChannelCloneJobCancel(id, session.ws);
    if (!ok) {
      // Either the job doesn't exist in this workspace, or it was
      // already in a terminal state. Distinguish for the UI so a
      // "cancel" on a just-completed job gets a sensible 409 rather
      // than a misleading 404.
      const row = await getChannelCloneJob(id, session.ws);
      if (!row) {
        return NextResponse.json({ error: 'job not found' }, { status: 404 });
      }
      return NextResponse.json(
        { error: `cannot cancel: job is already in terminal state '${row.status}'` },
        { status: 409 },
      );
    }
    logger.info('[channel-clone cancel] cancel requested', { jobId: id, workspaceId: session.ws });
    return NextResponse.json({ ok: true, status: 'cancelled' });
  },
);
