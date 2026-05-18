import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { EDITOR_V1_ENABLED } from '@/lib/feature-flags';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import { hashVoiceoverUrl, type CaptionSegment, type CaptionsBundle } from '@/lib/editor/captions';

/**
 * Caption regenerate endpoint — Phase 4 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * POST /api/edit/:projectId/captions/regenerate
 *
 * Reads the project's voiceoverUrl from the saved payload, fetches
 * the audio, sends it to OpenAI gpt-4o-mini-transcribe, and stores
 * the resulting segments in `payload.captions` (which round-trips
 * through the existing save endpoint).
 *
 * The hash of voiceoverUrl is recorded with the bundle so a future
 * read can tell "the VO changed since these captions were
 * generated" — the editor surfaces a "regenerate" hint when the
 * hash mismatches the live URL.
 *
 * Pricing
 * ───────
 * gpt-4o-mini-transcribe: $0.003 / minute of audio. A typical
 * 3-minute YouTube draft costs < $0.01 to caption. Cache hits cost
 * nothing — subsequent loads read the stored bundle.
 *
 * No Vercel KV: caching lives in `payload.captions` because we
 * don't have KV configured AND the payload is the single source of
 * truth that round-trips through save anyway.
 */

export const maxDuration = 120;

const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

interface OpenAITranscriptionSegment {
  start?: number;
  end?: number;
  text?: string;
}

interface OpenAITranscriptionResponse {
  segments?: OpenAITranscriptionSegment[];
  text?: string;
}

export const POST = apiRoute.authed(async (
  session,
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => {
  if (!EDITOR_V1_ENABLED) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Stricter rate limit than rephrase — transcription is much more
  // expensive (per-second cost vs per-call) and a runaway loop is
  // costly. 6 per minute is generous for "the user is iterating on
  // VO regen."
  const { limited } = checkRateLimit(`editor-captions:${getClientIP(req)}`, 6, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Too many caption regenerations — slow down.' }, { status: 429 });
  }

  const { projectId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY is not configured' }, { status: 500 });
  }

  // Read the payload server-side so the caller can't lie about
  // voiceoverUrl. (Even with single-owner-edits, the workspace +
  // collaborator scope is what we trust, not the client.)
  const { rows } = await sql<{ payload: unknown; version: number }>`
    SELECT payload, version
      FROM user_history
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  const payload = rows[0].payload;
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Payload not parseable' }, { status: 500 });
  }
  const p = payload as Record<string, unknown>;
  const voiceoverUrl = typeof p.voiceoverUrl === 'string' ? p.voiceoverUrl : '';
  if (!voiceoverUrl) {
    return NextResponse.json(
      { error: 'No voiceover URL on this project. Assign or generate a voiceover first.' },
      { status: 400 },
    );
  }

  // Fetch the audio. The URL is workspace-private Blob/R2 but
  // publicly readable — fine for OpenAI to consume.
  const audioRes = await fetch(voiceoverUrl);
  if (!audioRes.ok) {
    logger.warn('[editor captions] audio fetch failed', {
      project_id: projectId,
      status: audioRes.status,
    });
    return NextResponse.json(
      { error: `Failed to fetch voiceover audio (HTTP ${audioRes.status})` },
      { status: 502 },
    );
  }
  const audioBuffer = await audioRes.arrayBuffer();
  const audioBlob = new Blob([audioBuffer], {
    type: audioRes.headers.get('content-type') || 'audio/mpeg',
  });

  // OpenAI's transcription API expects a multipart form. We build it
  // manually because the openai SDK's file handling adds 30+ KB to
  // the bundle for a single call.
  const form = new FormData();
  form.set('file', audioBlob, 'voiceover.mp3');
  form.set('model', TRANSCRIBE_MODEL);
  form.set('response_format', 'verbose_json');
  form.set('timestamp_granularities[]', 'segment');

  const transcribeRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!transcribeRes.ok) {
    const errText = await transcribeRes.text().catch(() => '');
    logger.warn('[editor captions] transcription failed', {
      project_id: projectId,
      status: transcribeRes.status,
      detail: errText.slice(0, 200),
    });
    return NextResponse.json(
      { error: `Transcription failed (HTTP ${transcribeRes.status}): ${errText.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const data = (await transcribeRes.json()) as OpenAITranscriptionResponse;
  const rawSegments = Array.isArray(data.segments) ? data.segments : [];
  const segments: CaptionSegment[] = rawSegments
    .filter((s) => typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string')
    .map((s) => ({
      start: s.start as number,
      end: s.end as number,
      text: (s.text as string).trim(),
    }))
    .filter((s) => s.text.length > 0);

  const voiceoverUrlHash = await hashVoiceoverUrl(voiceoverUrl);
  const bundle: CaptionsBundle = {
    voiceoverUrlHash,
    modelId: TRANSCRIBE_MODEL,
    generatedAt: new Date().toISOString(),
    segments,
  };

  // Persist into the payload alongside doc / rowImages. We use a
  // JSONB merge so concurrent edits to OTHER fields don't get
  // clobbered. Bumps `version` so the editor's optimistic-lock
  // sees the change and reloads.
  await sql`
    UPDATE user_history
       SET payload = payload || ${JSON.stringify({ captions: bundle })}::jsonb,
           version = version + 1
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
  `;

  logger.info('[editor captions] regenerated', {
    project_id: projectId,
    segment_count: segments.length,
    workspace_id: session.ws,
  });

  return NextResponse.json({ ok: true, bundle });
});
