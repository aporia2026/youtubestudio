/**
 * POST /api/channel-clone/analyze
 *
 * Body: { jobId: string }
 *
 * Runs the deep channel analysis (STATEs 6/7/8/13 from the V2.0
 * prompt) against a job whose intake is complete. The work is
 * synchronous from the client's POV — the request returns once the
 * LLM call has landed and the parsed analysis is on the job row.
 * Typical wall time is 30-90 s; well within the 300 s function
 * budget.
 *
 * On success: 200 with the updated job state.
 * On failure: 4xx + { error }; the job row's `status` is set to
 *             `analyze_failed` and `last_error` carries the detail
 *             so the UI can show what went wrong on the next poll.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { runAnalyze } from '@/lib/channel-clone/analyze-runner';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';

export const maxDuration = 300;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const jobId = typeof b.jobId === 'string' ? b.jobId.trim() : '';
  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }

  const before = await getChannelCloneJob(jobId, session.ws);
  if (!before) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  if (!before.state_jsonb.intake) {
    return NextResponse.json(
      { error: 'Intake is not yet complete for this job.' },
      { status: 409 },
    );
  }
  if (before.status === 'analyze_running') {
    return NextResponse.json(
      { error: 'Analysis is already running for this job.' },
      { status: 409 },
    );
  }

  logger.info('[channel-clone analyze] kickoff', {
    jobId,
    workspaceId: session.ws,
  });

  await runAnalyze({ jobId, workspaceId: session.ws });

  const after = await getChannelCloneJob(jobId, session.ws);
  if (!after) {
    return NextResponse.json({ error: 'job vanished mid-run' }, { status: 500 });
  }
  if (after.status === 'analyze_failed') {
    return NextResponse.json(
      { error: after.last_error ?? 'analyze failed' },
      { status: 502 },
    );
  }
  return NextResponse.json({
    id: after.id,
    status: after.status,
    state: after.state_jsonb,
  });
});
