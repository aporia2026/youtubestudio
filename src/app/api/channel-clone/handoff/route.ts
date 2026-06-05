/**
 * POST /api/channel-clone/handoff
 *
 * Body: { jobId: string; presetId?: string }
 *
 * Promotes a rowified channel-clone job into a real pipeline_run_videos
 * row so the existing image-gen / thumbnail / SEO / editor pipeline
 * can take over. After success, the user can find the new run in the
 * Auto-pipeline dashboard.
 *
 * Synchronous within maxDuration=30 — this is pure DB writes, no
 * model calls.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runHandoff } from '@/lib/channel-clone/handoff-runner';

export const maxDuration = 30;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const jobId = typeof b.jobId === 'string' ? b.jobId.trim() : '';
  const presetIdRaw = typeof b.presetId === 'string' ? b.presetId.trim() : '';
  const presetId = presetIdRaw === '' ? undefined : presetIdRaw;
  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }

  const before = await getChannelCloneJob(jobId, session.ws);
  if (!before) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  if (before.state_jsonb.handoff) {
    return NextResponse.json(
      { error: `Already handed off — pipeline_run_video ${before.state_jsonb.handoff.pipelineRunVideoId}.` },
      { status: 409 },
    );
  }
  if (!before.state_jsonb.productionRows || before.state_jsonb.productionRows.length === 0) {
    return NextResponse.json(
      { error: 'No production rows yet — run /rowify first.' },
      { status: 409 },
    );
  }
  if (before.status === 'handoff_running') {
    return NextResponse.json(
      { error: 'Handoff is already running for this job.' },
      { status: 409 },
    );
  }

  logger.info('[channel-clone handoff] kickoff', {
    jobId,
    workspaceId: session.ws,
    userId: session.uid,
    presetIdHint: presetId ?? null,
  });
  await runHandoff({
    jobId,
    workspaceId: session.ws,
    userId: session.uid,
    presetId,
  });

  const after = await getChannelCloneJob(jobId, session.ws);
  if (!after) return NextResponse.json({ error: 'job vanished mid-run' }, { status: 500 });
  if (after.status === 'handoff_failed') {
    return NextResponse.json({ error: after.last_error ?? 'handoff failed' }, { status: 502 });
  }
  return NextResponse.json({ id: after.id, status: after.status, state: after.state_jsonb });
});
