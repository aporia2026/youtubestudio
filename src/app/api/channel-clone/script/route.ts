/**
 * POST /api/channel-clone/script
 *
 * Body: {
 *   jobId: string;
 *   selectedHookIndex: number;
 *   threshold?: 80 | 90 | 95 | 100;
 *   maxIterations?: 1 | 3 | 5;
 * }
 *
 * Runs STATE 10 → STATE 11 → fix-loop. Synchronous within
 * maxDuration=300. Heavy operation — typical wall time is 60–180s
 * depending on iteration count and model.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runScript } from '@/lib/channel-clone/script-runner';

export const maxDuration = 300;

const VALID_THRESHOLDS = new Set([80, 90, 95, 100]);
const VALID_MAX_ITERATIONS = new Set([1, 3, 5]);

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const jobId = typeof b.jobId === 'string' ? b.jobId.trim() : '';
  const selectedHookIndex = Number(b.selectedHookIndex);
  const threshold = Number(b.threshold ?? 90);
  const maxIterations = Number(b.maxIterations ?? 3);
  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }
  if (!Number.isInteger(selectedHookIndex) || selectedHookIndex < 1) {
    return NextResponse.json({ error: 'selectedHookIndex must be a positive integer' }, { status: 400 });
  }
  if (!VALID_THRESHOLDS.has(threshold)) {
    return NextResponse.json(
      { error: `threshold must be one of ${[...VALID_THRESHOLDS].join(', ')}` },
      { status: 400 },
    );
  }
  if (!VALID_MAX_ITERATIONS.has(maxIterations)) {
    return NextResponse.json(
      { error: `maxIterations must be one of ${[...VALID_MAX_ITERATIONS].join(', ')}` },
      { status: 400 },
    );
  }

  const before = await getChannelCloneJob(jobId, session.ws);
  if (!before) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  if (!before.state_jsonb.hooks || before.state_jsonb.hooks.length === 0) {
    return NextResponse.json(
      { error: 'Hooks are not yet generated for this job.' },
      { status: 409 },
    );
  }
  if (before.status === 'script_running') {
    return NextResponse.json(
      { error: 'Script generation is already running for this job.' },
      { status: 409 },
    );
  }

  logger.info('[channel-clone script] kickoff', {
    jobId,
    workspaceId: session.ws,
    selectedHookIndex,
    threshold,
    maxIterations,
  });
  const modelOverride = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : undefined;
  await runScript({
    jobId,
    workspaceId: session.ws,
    selectedHookIndex,
    threshold: threshold as 80 | 90 | 95 | 100,
    maxIterations: maxIterations as 1 | 3 | 5,
    modelOverride,
  });

  const after = await getChannelCloneJob(jobId, session.ws);
  if (!after) return NextResponse.json({ error: 'job vanished mid-run' }, { status: 500 });
  if (after.status === 'script_failed') {
    return NextResponse.json({ error: after.last_error ?? 'script failed' }, { status: 502 });
  }
  return NextResponse.json({ id: after.id, status: after.status, state: after.state_jsonb });
});
