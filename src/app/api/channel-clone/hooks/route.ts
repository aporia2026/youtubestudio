/**
 * POST /api/channel-clone/hooks
 *
 * Body: { jobId: string; selectedTopicIndex: number }
 *
 * Runs STATE 9 against a job whose topics are complete. Returns
 * the updated job state on success (with `state.hooks` populated).
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runHooks } from '@/lib/channel-clone/hooks-runner';

export const maxDuration = 90;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const jobId = typeof b.jobId === 'string' ? b.jobId.trim() : '';
  const selectedTopicIndex = Number(b.selectedTopicIndex);
  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }
  if (!Number.isInteger(selectedTopicIndex) || selectedTopicIndex < 1) {
    return NextResponse.json({ error: 'selectedTopicIndex must be a positive integer' }, { status: 400 });
  }

  const before = await getChannelCloneJob(jobId, session.ws);
  if (!before) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  if (!before.state_jsonb.topics || before.state_jsonb.topics.length === 0) {
    return NextResponse.json(
      { error: 'Topics are not yet generated for this job.' },
      { status: 409 },
    );
  }
  if (before.status === 'hooks_running') {
    return NextResponse.json(
      { error: 'Hook engineering is already running for this job.' },
      { status: 409 },
    );
  }

  logger.info('[channel-clone hooks] kickoff', { jobId, workspaceId: session.ws, selectedTopicIndex });
  await runHooks({ jobId, workspaceId: session.ws, selectedTopicIndex });

  const after = await getChannelCloneJob(jobId, session.ws);
  if (!after) return NextResponse.json({ error: 'job vanished mid-run' }, { status: 500 });
  if (after.status === 'hooks_failed') {
    return NextResponse.json({ error: after.last_error ?? 'hooks failed' }, { status: 502 });
  }
  return NextResponse.json({ id: after.id, status: after.status, state: after.state_jsonb });
});
