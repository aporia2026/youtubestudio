/**
 * POST /api/channel-clone/voice/delete
 *
 * Drop a previously-cloned voice from the operator's ElevenLabs
 * account and clear `state_jsonb.clonedVoice` on the job. Body:
 *   { jobId: string }
 *
 * The DELETE-on-ElevenLabs runs FIRST. Only on success do we clear
 * the job state, so a 404 on their side (voice already gone) is
 * surfaced rather than silently committing the local clear and
 * leaving a stranded UI.
 *
 * On success: 200 with `{ ok: true }`.
 * On failure: 4xx + `{ error, kind }`.
 *
 * See _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import {
  ElevenLabsApiError,
  deleteVoice,
  type ElevenLabsErrorKind,
} from '@/lib/channel-clone/elevenlabs';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
} from '@/lib/channel-clone/job-store';

export const maxDuration = 30;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const o = (body ?? {}) as Record<string, unknown>;
  const jobId = typeof o.jobId === 'string' ? o.jobId.trim() : '';
  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  }
  const job = await getChannelCloneJob(jobId, session.ws);
  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  const cloned = job.state_jsonb.clonedVoice;
  if (!cloned?.voiceId) {
    return NextResponse.json(
      { error: 'No cloned voice on this job — nothing to delete.' },
      { status: 409 },
    );
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ElevenLabs API key is not configured on the server.' },
      { status: 503 },
    );
  }

  try {
    await deleteVoice({ apiKey, voiceId: cloned.voiceId });
  } catch (err) {
    if (err instanceof ElevenLabsApiError) {
      logger.warn('[channel-clone voice-delete] elevenlabs error', {
        jobId, voiceId: cloned.voiceId, kind: err.kind, status: err.status,
      });
      // 404 on their side: voice was already deleted (manually via
      // dashboard, or by a previous run). Treat as success — clear
      // local state and move on.
      if (err.status === 404) {
        logger.info('[channel-clone voice-delete] voice already gone upstream — clearing local state', {
          jobId, voiceId: cloned.voiceId,
        });
      } else {
        return NextResponse.json(
          { error: err.message, kind: err.kind },
          { status: mapKindToHttpStatus(err.kind) },
        );
      }
    } else {
      logger.error('[channel-clone voice-delete] unexpected throw', {
        jobId, error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: 'Delete failed for an unknown reason.' }, { status: 500 });
    }
  }

  // Clear `clonedVoice` from the job state. Using
  // `replaceChannelCloneJobState` so the spread-omit pattern works
  // cleanly — the JSONB merge helper doesn't support field removal.
  try {
    const fresh = await getChannelCloneJob(jobId, session.ws);
    if (fresh) {
      const { clonedVoice: _omit, ...rest } = fresh.state_jsonb;
      await replaceChannelCloneJobState(jobId, session.ws, rest);
    }
  } catch (err) {
    logger.error('[channel-clone voice-delete] persist clear failed', {
      jobId, error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Voice was deleted on ElevenLabs but we could not update the job state. Refresh to reconcile.' },
      { status: 500 },
    );
  }

  logger.info('[channel-clone voice-delete] done', { jobId, voiceId: cloned.voiceId });
  return NextResponse.json({ ok: true });
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
