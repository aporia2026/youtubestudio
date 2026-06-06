/**
 * POST /api/channel-clone/rowify
 *
 * Body: { jobId: string; stylePresetId?: string }
 *
 * Runs STATE 14 — converts the audit-approved script into a
 * ChannelCloneProductionRow[] matched to a style preset. If
 * stylePresetId is omitted, the runner falls back to
 * matchStylePreset(visualProfile).
 *
 * Synchronous within maxDuration=300. Typical wall time 30-90s.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import { isCandidateStylePresetId } from '@/lib/channel-clone/match-style-preset';
import { runRowify } from '@/lib/channel-clone/rowify-runner';

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
  const stylePresetIdRaw = typeof b.stylePresetId === 'string' ? b.stylePresetId.trim() : '';
  const stylePresetId = stylePresetIdRaw === '' ? undefined : stylePresetIdRaw;
  // Default to true — the WHOLE POINT of channel-clone is to clone
  // the channel's visual DNA, not to bucket it into a built-in style.
  // The operator can opt out by sending useChannelStyle: false (e.g.
  // they want a clean preset-only render with no channel overrides).
  const useChannelStyle = b.useChannelStyle === false ? false : true;

  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }
  if (stylePresetId !== undefined && !isCandidateStylePresetId(stylePresetId)) {
    return NextResponse.json(
      { error: `Unknown stylePresetId. Use one of the built-in channel-clone candidates or omit to auto-match.` },
      { status: 400 },
    );
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
  if (before.status === 'rowify_running') {
    return NextResponse.json(
      { error: 'Rowification is already running for this job.' },
      { status: 409 },
    );
  }

  const modelOverride = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : undefined;
  logger.info('[channel-clone rowify] kickoff', {
    jobId,
    workspaceId: session.ws,
    stylePresetIdHint: stylePresetId ?? null,
    useChannelStyle,
    modelOverride: modelOverride ?? null,
  });
  await runRowify({ jobId, workspaceId: session.ws, stylePresetId, useChannelStyle, modelOverride });

  const after = await getChannelCloneJob(jobId, session.ws);
  if (!after) return NextResponse.json({ error: 'job vanished mid-run' }, { status: 500 });
  if (after.status === 'rowify_failed') {
    return NextResponse.json({ error: after.last_error ?? 'rowify failed' }, { status: 502 });
  }
  return NextResponse.json({ id: after.id, status: after.status, state: after.state_jsonb });
});
