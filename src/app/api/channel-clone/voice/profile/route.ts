/**
 * POST /api/channel-clone/voice/profile
 *
 * Manual retry of the voice-profile LLM stage (Plan 1A). The stage
 * normally auto-runs at the tail of intake, but it's deliberately
 * best-effort: silent bail-outs on Kie 500s, model-defaults pointed
 * at a non-Gemini model, R2 read failures, etc. When that happens
 * the panel is stuck on "analyzing…" with no recovery path. This
 * route is the recovery path.
 *
 * Body: { jobId: string }
 *
 * On success: 200 with `{ ok: true, voiceProfile }` — the populated
 * profile, mirroring the auto-run path. The route bails 409 when
 * the job has no voiceSample (nothing to analyze).
 *
 * See _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runVoiceProfile } from '@/lib/channel-clone/voice-profile-runner';

export const maxDuration = 120;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const jobId = typeof (body as { jobId?: unknown })?.jobId === 'string'
    ? (body as { jobId: string }).jobId.trim()
    : '';
  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }

  const before = await getChannelCloneJob(jobId, session.ws);
  if (!before) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  if (!before.state_jsonb.voiceSample) {
    return NextResponse.json(
      { error: 'No voice sample on this job to analyze. Re-run intake on a video with audible narration to capture one.' },
      { status: 409 },
    );
  }

  logger.info('[channel-clone voice-profile retry] kickoff', {
    jobId, workspaceId: session.ws,
  });
  await runVoiceProfile({ jobId, workspaceId: session.ws });

  const after = await getChannelCloneJob(jobId, session.ws);
  if (!after) {
    return NextResponse.json({ error: 'job vanished mid-run' }, { status: 500 });
  }
  if (!after.state_jsonb.voiceProfile) {
    // Runner bailed silently again. Surface a clearer error than the
    // silent UI stuck state — usually this is the model-defaults
    // pointing at a non-Kie-Gemini model.
    return NextResponse.json(
      {
        error: 'Voice profile did not populate. Most common cause: your Settings → Model Defaults for "Channel Clone — Narrator Voice Profile" is set to a non-Kie-Gemini model. Check the workspace job log for the bail reason.',
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, voiceProfile: after.state_jsonb.voiceProfile });
});
