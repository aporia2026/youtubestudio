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
  setChannelCloneJobStatus,
} from '@/lib/channel-clone/job-store';
import { deleteR2Prefix } from '@/lib/channel-clone/templates-r2';
import { logger } from '@/lib/logger';
import type { ChannelCloneJobStatus } from '@/lib/channel-clone/types';

export const maxDuration = 10;

type Params = { id: string };

/** A `*_running` job whose last DB write is older than this is treated
 *  as orphaned — the Vercel function that owned it almost certainly
 *  died (timeout, OOM, redeploy mid-flight). Threshold is the longest
 *  per-stage maxDuration (intake-upload = 600 s) plus a 2-minute buffer
 *  for downstream voice-profile / final DB writes that don't refresh
 *  updated_at until they emit a log. */
const STALE_RUNNING_THRESHOLD_MS = 12 * 60 * 1000;

/** Map a `*_running` status to its `*_failed` sibling so the panel
 *  can surface a clean Retry path. Anything not in this map is
 *  considered active by definition. */
const RUNNING_TO_FAILED: Partial<Record<ChannelCloneJobStatus, ChannelCloneJobStatus>> = {
  intake_running: 'intake_failed',
  analyze_running: 'analyze_failed',
  topics_running: 'topics_failed',
  hooks_running: 'hooks_failed',
  script_running: 'script_failed',
  rowify_running: 'rowify_failed',
  publish_pack_running: 'publish_pack_failed',
  handoff_running: 'handoff_failed',
};

export const GET = apiRoute.authed(async (session, _req: NextRequest, ctx: RouteContext<Params>) => {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: 'job id is required' }, { status: 400 });
  }
  let row = await getChannelCloneJob(id, session.ws);
  if (!row) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }

  // Stale-job auto-recovery. The runner appends to state_jsonb on
  // every log line, so updated_at is a reliable heartbeat. When a
  // *_running row goes that long without a write the underlying
  // function is dead — converting the status to *_failed surfaces a
  // clean Retry path in the UI instead of an "INTAKE RUNNING — 30min
  // ago" zombie. We only do this for *_running statuses; *_complete
  // and *_failed are correct on the row.
  const failedStatus = RUNNING_TO_FAILED[row.status];
  if (failedStatus) {
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    if (ageMs > STALE_RUNNING_THRESHOLD_MS) {
      const minutes = Math.floor(ageMs / 60_000);
      const message = `${row.status.replace('_running', '')} runner went silent for ${minutes}min — the serverless function was killed. Retry from the panel.`;
      logger.warn('[channel-clone jobs GET] auto-recovering stale running job', {
        jobId: id, status: row.status, ageMs, ageMin: minutes,
      });
      await setChannelCloneJobStatus(id, session.ws, failedStatus, { lastError: message });
      // Re-read so the response reflects the change without a second
      // GET round-trip.
      row = await getChannelCloneJob(id, session.ws);
      if (!row) {
        return NextResponse.json({ error: 'job not found' }, { status: 404 });
      }
    }
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
