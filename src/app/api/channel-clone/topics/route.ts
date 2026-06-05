/**
 * POST /api/channel-clone/topics
 *
 * Body: { jobId: string; topicCount?: 5 | 10 | 15 }
 *
 * Runs STATE 5 against a job whose analysis is complete. Returns
 * the updated job state on success (with `state.topics` populated)
 * or 4xx/502 on failure. Synchronous within maxDuration=120.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runTopics } from '@/lib/channel-clone/topics-runner';

export const maxDuration = 120;

const VALID_TOPIC_COUNTS = new Set([5, 10, 15]);

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
  const topicCount = Number(b.topicCount ?? 10);
  if (!VALID_TOPIC_COUNTS.has(topicCount)) {
    return NextResponse.json(
      { error: `topicCount must be one of ${[...VALID_TOPIC_COUNTS].join(', ')}` },
      { status: 400 },
    );
  }

  const before = await getChannelCloneJob(jobId, session.ws);
  if (!before) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  if (!before.state_jsonb.analysis) {
    return NextResponse.json(
      { error: 'Analysis is not yet complete for this job.' },
      { status: 409 },
    );
  }
  if (before.status === 'topics_running') {
    return NextResponse.json(
      { error: 'Topics generation is already running for this job.' },
      { status: 409 },
    );
  }

  logger.info('[channel-clone topics] kickoff', { jobId, workspaceId: session.ws, topicCount });
  await runTopics({ jobId, workspaceId: session.ws, topicCount });

  const after = await getChannelCloneJob(jobId, session.ws);
  if (!after) return NextResponse.json({ error: 'job vanished mid-run' }, { status: 500 });
  if (after.status === 'topics_failed') {
    return NextResponse.json({ error: after.last_error ?? 'topics failed' }, { status: 502 });
  }
  return NextResponse.json({ id: after.id, status: after.status, state: after.state_jsonb });
});
