/**
 * POST /api/channel-clone/voice/clone
 *
 * One-click Instant Voice Cloning button (Plan 1B). Body:
 *   { jobId: string, name: string, ownershipAck: true }
 *
 *   - `jobId` — the channel-clone job whose `voiceSample` we'll
 *     upload to ElevenLabs. Workspace-scoped; cross-tenant ids are
 *     indistinguishable from non-existent (both 404).
 *   - `name` — display name for the cloned voice. Defaults to
 *     `Clone: {sourceChannelName}` on the client when omitted.
 *   - `ownershipAck` — the operator MUST tick a "I own the voice
 *     rights" checkbox before this route accepts the upload. The
 *     check is enforced server-side so the client can't bypass it.
 *
 * On success: 200 with `{ voiceId, name, subscriptionTier, clonedAt }`.
 * On failure: 4xx + `{ error }` mapping the ElevenLabs failure mode
 *             to a human-readable line (auth / quota / ownership /
 *             rate-limit / server / unknown).
 *
 * The cloned voice metadata is persisted to `state_jsonb.clonedVoice`
 * so the panel survives a refresh. Plan 1 (parent):
 * _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getDownloadUrlForBucket, getReviewBucket } from '@/lib/r2';
import {
  ElevenLabsApiError,
  cloneInstantVoice,
  getSubscriptionTier,
  type ElevenLabsErrorKind,
} from '@/lib/channel-clone/elevenlabs';
import {
  getChannelCloneJob,
  mergeChannelCloneJobState,
} from '@/lib/channel-clone/job-store';

export const maxDuration = 60;

interface CloneRequestBody {
  jobId: string;
  name: string;
  ownershipAck: boolean;
}

function parseBody(raw: unknown): CloneRequestBody | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid request body' };
  const o = raw as Record<string, unknown>;
  const jobId = typeof o.jobId === 'string' ? o.jobId.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const ownershipAck = o.ownershipAck === true;
  if (!jobId) return { error: 'jobId is required' };
  if (!name) return { error: 'name is required' };
  if (name.length > 80) return { error: 'name must be 80 characters or fewer' };
  if (!ownershipAck) {
    return {
      error: 'You must confirm you own the voice rights before cloning. Tick the consent checkbox in the panel and try again.',
    };
  }
  return { jobId, name, ownershipAck: true };
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const parsed = parseBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { jobId, name } = parsed;

  const job = await getChannelCloneJob(jobId, session.ws);
  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  const voiceSample = job.state_jsonb.voiceSample;
  if (!voiceSample) {
    return NextResponse.json(
      { error: 'This job has no captured voice sample. Re-run intake on a video with audible narration to generate one.' },
      { status: 409 },
    );
  }
  if (job.state_jsonb.clonedVoice?.voiceId) {
    return NextResponse.json(
      { error: 'A voice is already cloned for this job. Delete it first if you want to re-clone.' },
      { status: 409 },
    );
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    logger.warn('[channel-clone voice-clone] ELEVENLABS_API_KEY not configured');
    return NextResponse.json(
      { error: 'ElevenLabs API key is not configured on the server. Add ELEVENLABS_API_KEY to your Vercel env vars to enable cloning.' },
      { status: 503 },
    );
  }

  // Fetch the audio sample bytes from R2 into memory for the
  // ElevenLabs upload. The clip is ~250 KB so memory pressure is
  // negligible.
  let mp3Buffer: Buffer;
  try {
    const url = await getDownloadUrlForBucket(getReviewBucket(), voiceSample.r2Key);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`R2 GET returned ${res.status}`);
    mp3Buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.error('[channel-clone voice-clone] R2 fetch failed', {
      jobId, r2Key: voiceSample.r2Key,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Could not load the captured audio sample from storage. Please retry.' },
      { status: 500 },
    );
  }

  // Probe subscription tier first so the panel can show the user
  // their current plan + headroom alongside the clone result. The
  // probe is cheap (one GET) and shouldn't fail unless auth is bad —
  // in which case the clone POST would also fail. Surface the same
  // error.
  let subscriptionTier = 'unknown';
  try {
    const probed = await getSubscriptionTier({ apiKey });
    subscriptionTier = probed.tier;
    logger.info('[channel-clone voice-clone] tier probe', {
      jobId, tier: probed.tier, charactersLeft: probed.charactersLeft,
    });
  } catch (err) {
    // Non-fatal — keep going. If the clone fails too we'll surface
    // its more specific error.
    logger.warn('[channel-clone voice-clone] tier probe failed; proceeding', {
      jobId, error: err instanceof Error ? err.message : String(err),
    });
  }

  let voiceId: string;
  try {
    const result = await cloneInstantVoice({
      apiKey,
      name,
      mp3Buffer,
      description: `channel-clone job ${jobId} (workspace ${session.ws})`,
      // ElevenLabs labels: free-form. We surface workspace + jobId so
      // an operator can correlate clones later from the ElevenLabs UI.
      labels: { workspaceId: session.ws, jobId },
    });
    voiceId = result.voiceId;
  } catch (err) {
    if (err instanceof ElevenLabsApiError) {
      const httpStatus = mapKindToHttpStatus(err.kind);
      logger.warn('[channel-clone voice-clone] elevenlabs error', {
        jobId, kind: err.kind, status: err.status, message: err.message,
      });
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatus });
    }
    logger.error('[channel-clone voice-clone] unexpected throw', {
      jobId, error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Cloning failed for an unknown reason. Try again.' }, { status: 500 });
  }

  const clonedVoice = {
    voiceId,
    name,
    subscriptionTier,
    clonedAt: new Date().toISOString(),
    clonedBy: session.uid,
  };
  try {
    await mergeChannelCloneJobState(jobId, session.ws, { clonedVoice });
  } catch (err) {
    // Persistence failed AFTER the clone was created on ElevenLabs.
    // Surface a clear message; the operator can manually delete the
    // orphan from ElevenLabs if they care. Better than silently
    // losing the voiceId.
    logger.error('[channel-clone voice-clone] persist failed; voice was created but not saved', {
      jobId, voiceId, error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: `Voice cloned (voice_id: ${voiceId}) but we could not save it to the job. You can re-clone, or copy the voice_id from the ElevenLabs dashboard.`,
        voiceId,
      },
      { status: 500 },
    );
  }

  logger.info('[channel-clone voice-clone] done', { jobId, voiceId, subscriptionTier });
  return NextResponse.json({ ok: true, clonedVoice });
});

function mapKindToHttpStatus(kind: ElevenLabsErrorKind): number {
  switch (kind) {
    case 'missing-key':
      return 503;
    case 'auth':
      return 502;
    case 'quota':
      return 402;
    case 'ownership':
      return 422;
    case 'rate-limit':
      return 429;
    case 'server':
      return 502;
    case 'unknown':
      return 500;
  }
}
