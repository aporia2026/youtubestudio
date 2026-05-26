import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { EDITOR_V1_ENABLED } from '@/lib/feature-flags';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import { synthesize } from '@/lib/tts/dispatch';
import { TtsProviderError, type TtsProviderId, type VoiceTier } from '@/lib/tts/types';
import {
  buildElevenLabsVoiceoverKey,
  getNarrationDownloadUrl,
  mimeTypeToExt,
  uploadToBucket,
} from '@/lib/r2';
import type { ProductionDoc } from '@/remotion/utils';

/**
 * Voiceover regeneration endpoint — Phase 3+ audio-retiming work
 * from `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * POST /api/edit/:projectId/voiceover/regenerate
 *
 * Concatenates every row's `script_text` from the saved doc,
 * generates a fresh voiceover via ElevenLabs with the user-picked
 * voice, mirrors the MP3 to R2, and JSONB-merges the new URL +
 * provider metadata into payload.voiceoverUrl. The editor's
 * optimistic-lock reload picks up the new URL on the next reload.
 *
 * Honest scope
 * ────────────
 * ElevenLabs doesn't have per-segment duration controls — this is
 * whole-VO regen, not per-shot retiming. The new take WILL sound
 * different from the original (voice randomness across generations).
 * Combined with the drift report, this gives creators a workflow:
 *
 *   1. Edit the timeline / script in the editor.
 *   2. Check the drift report to see where narration overruns.
 *   3. Regenerate VO → new take fits the updated script lengths.
 *   4. Rerun captions so they match the new audio.
 *
 * Future ffmpeg-based retiming (atempo per segment) would preserve
 * the original take + only stretch/compress mismatched segments.
 * That's a separate dedicated commit.
 *
 * Pricing
 * ───────
 * ElevenLabs charges per character. A typical 3-min draft (~450
 * words ≈ 2,800 chars) costs about $0.50–$1 per regen depending on
 * the tier. Rate-limited at 3 req/min/IP to stop runaway loops.
 */

export const maxDuration = 800;

const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';
const MAX_CONCAT_CHARS = 50_000;

interface PostBody {
  voiceId?: unknown;
  modelId?: unknown;
  voiceSettings?: unknown;
  /** 'elevenlabs' | 'google'. Defaults to 'elevenlabs' (back-compat). */
  provider?: unknown;
  /** Required when provider is 'google'. Defaults to 'multilingual-v2'
   *  for ElevenLabs and 'chirp3-hd' for Google. */
  tier?: unknown;
  /** BCP-47, defaults to 'en-US'. */
  languageCode?: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Concatenate per-row scripts with a paragraph break, which
 *  ElevenLabs renders as a natural ~0.5 s pause between sections.
 *  Newer ElevenLabs models support SSML `<break>` tags too; we
 *  use the simpler approach for v1 to avoid escaping pitfalls. */
function buildConcatScript(doc: ProductionDoc): string {
  return doc.rows
    .map((r) => (r.script_text ?? '').trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

export const POST = apiRoute.authed(async (
  session,
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => {
  if (!EDITOR_V1_ENABLED) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // 3 regens per minute is generous for a creator iterating on
  // voice picks — well under what a scripted loop would burn.
  const { limited } = checkRateLimit(`editor-vo-regen:${getClientIP(req)}`, 3, 60_000);
  if (limited) {
    return NextResponse.json(
      { error: 'Too many voiceover regenerations — slow down.' },
      { status: 429 },
    );
  }

  const { projectId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : '';
  if (!voiceId) {
    return NextResponse.json({ error: 'voiceId is required' }, { status: 400 });
  }
  const modelId = typeof body.modelId === 'string' && body.modelId.trim()
    ? body.modelId.trim()
    : DEFAULT_TTS_MODEL;
  const voiceSettings = isPlainObject(body.voiceSettings) ? body.voiceSettings : undefined;
  const provider: TtsProviderId =
    body.provider === 'google' ? 'google' : 'elevenlabs';
  const tier: VoiceTier =
    typeof body.tier === 'string' && body.tier
      ? (body.tier as VoiceTier)
      : provider === 'google'
        ? 'chirp3-hd'
        : 'multilingual-v2';
  const languageCode =
    typeof body.languageCode === 'string' && body.languageCode
      ? body.languageCode
      : 'en-US';

  // Load the saved doc server-side. We trust ONLY the persisted
  // payload's script text — not anything in the request — so the
  // user can't smuggle their own (possibly malicious) text and get
  // it stamped as "this workspace's voiceover."
  const { rows } = await sql<{ payload: unknown }>`
    SELECT payload
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
  if (!isPlainObject(rows[0].payload)) {
    return NextResponse.json({ error: 'Payload not parseable' }, { status: 500 });
  }
  const payload = rows[0].payload;
  const doc = isPlainObject(payload.doc) ? (payload.doc as unknown as ProductionDoc) : null;
  if (!doc || !Array.isArray(doc.rows)) {
    return NextResponse.json({ error: 'Doc payload missing rows' }, { status: 500 });
  }

  const concatScript = buildConcatScript(doc);
  if (!concatScript) {
    return NextResponse.json(
      { error: 'No script text on any row. Edit the scripts first.' },
      { status: 400 },
    );
  }
  if (concatScript.length > MAX_CONCAT_CHARS) {
    return NextResponse.json(
      { error: `Combined script exceeds ${MAX_CONCAT_CHARS}-char cap.` },
      { status: 400 },
    );
  }

  // Generate VO through the dispatch layer — provider-aware. For
  // ElevenLabs this is the same flow as before; for Google it routes
  // through @google-cloud/text-to-speech under the same contract.
  let synthResult;
  try {
    const vs = isPlainObject(voiceSettings) ? voiceSettings : {};
    synthResult = await synthesize(
      {
        voice: { providerId: provider, voiceId, languageCode, tier },
        text: concatScript,
        options:
          provider === 'elevenlabs'
            ? {
                providerId: 'elevenlabs',
                modelId,
                stability: typeof vs.stability === 'number' ? vs.stability : 0.5,
                similarity:
                  typeof vs.similarity_boost === 'number' ? vs.similarity_boost : 0.75,
                style: typeof vs.style === 'number' ? vs.style : 0.5,
                useSpeakerBoost:
                  typeof vs.use_speaker_boost === 'boolean' ? vs.use_speaker_boost : true,
              }
            : { providerId: 'google' },
      },
      req.signal,
    );
  } catch (err) {
    if (err instanceof TtsProviderError) {
      const status =
        err.code === 'unauthorized'
          ? 503
          : err.code === 'rate_limited'
            ? 429
            : err.code === 'invalid_request'
              ? 400
              : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
  const audioBuffer = synthResult.audioBytes;

  const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
  const ext = mimeTypeToExt(synthResult.mimeType);
  const r2Key = buildElevenLabsVoiceoverKey(voiceId, ext);
  await uploadToBucket(narrationBucket, r2Key, Buffer.from(audioBuffer), synthResult.mimeType);
  const downloadUrl = await getNarrationDownloadUrl(r2Key);

  // JSONB-merge the new voiceoverUrl + bump version. Captions are
  // intentionally cleared (set to null in the merge) — they're
  // derived from the audio, and the audio just changed, so any
  // existing caption bundle is stale. The editor's "Regen captions"
  // button can rebuild them from the new VO.
  const { rows: savedRow } = await sql`
    UPDATE user_history
       SET payload = (payload || ${JSON.stringify({
         voiceoverUrl: downloadUrl,
         voiceoverProvider: {
           provider,
           voiceId,
           modelId: provider === 'elevenlabs' ? modelId : null,
           tier,
           languageCode,
           costUsd: synthResult.costUsd,
           generatedAt: new Date().toISOString(),
           charCount: synthResult.charCount,
         },
       })}::jsonb) - 'captions',
           version = version + 1
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     RETURNING version
  `;
  // Return the new version so the editor can SYNC_SERVER_VERSION and
  // avoid the next full-payload PATCH failing the optimistic check.
  // Without this, a regen here silently desynced the editor — every
  // subsequent autosave returned 409 until the user reloaded.
  const newVersion =
    Array.isArray(savedRow) && savedRow.length > 0 ? (savedRow[0] as { version?: number }).version : null;

  logger.info('[editor vo regen] success', {
    project_id: projectId,
    provider,
    voice_id: voiceId,
    model_id: provider === 'elevenlabs' ? modelId : null,
    tier,
    language_code: languageCode,
    char_count: synthResult.charCount,
    cost_usd: synthResult.costUsd,
    audio_bytes: audioBuffer.byteLength,
    workspace_id: session.ws,
    new_version: newVersion,
  });

  return NextResponse.json({
    ok: true,
    voiceoverUrl: downloadUrl,
    charCount: concatScript.length,
    version: newVersion,
  });
});
