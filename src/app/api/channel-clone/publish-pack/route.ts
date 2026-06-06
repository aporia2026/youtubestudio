/**
 * POST /api/channel-clone/publish-pack
 *
 * Body: { jobId: string }
 *
 * Runs STATEs 18 + 19 + 21 in one call: thumbnail concepts, SEO
 * metadata, 30-day content calendar. Persists onto state.publishPack
 * and bumps job status to publish_pack_complete.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runPublishPack } from '@/lib/channel-clone/publish-pack-runner';

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
  if (!before.state_jsonb.approvedScript) {
    return NextResponse.json(
      { error: 'No approved script — run /script first.' },
      { status: 409 },
    );
  }
  if (before.status === 'publish_pack_running') {
    return NextResponse.json(
      { error: 'Publish pack is already running for this job.' },
      { status: 409 },
    );
  }

  const modelOverride = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : undefined;
  logger.info('[channel-clone publish-pack] kickoff', { jobId, workspaceId: session.ws, modelOverride: modelOverride ?? null });
  await runPublishPack({ jobId, workspaceId: session.ws, modelOverride });

  const after = await getChannelCloneJob(jobId, session.ws);
  if (!after) return NextResponse.json({ error: 'job vanished mid-run' }, { status: 500 });
  if (after.status === 'publish_pack_failed') {
    return NextResponse.json({ error: after.last_error ?? 'publish-pack failed' }, { status: 502 });
  }
  return NextResponse.json({ id: after.id, status: after.status, state: after.state_jsonb });
});
