/**
 * POST /api/voiceovers/align
 *
 * Pre-warm or refresh the voiceover alignment cache for a (voiceover
 * media_asset + production-doc canonical script) pair. Returns the
 * alignment JSON + a `cached` flag so the production-doc page can
 * render the four-state pill near its Render button.
 *
 * Security posture (rule 13):
 *   - `apiRoute.authed` — only logged-in users can trigger an
 *     ElevenLabs alignment call, since each miss costs $0.22/hr.
 *   - Same-origin restriction — the `audioPath` body field must be a
 *     same-origin path under `/api/voiceovers/<uuid>/audio`. We
 *     refuse arbitrary URLs to defuse SSRF: the cache module
 *     server-side-fetches the audio bytes, and an attacker who could
 *     pass any URL would get a free internal port scanner.
 *   - Daily spend cap — enforced inside `ensureAlignmentForVoiceover`
 *     against `ELEVENLABS_ALIGNMENT_MAX_USD_PER_DAY` (default $2/day).
 *     Once reached, the response carries `status: 'failed'` with a
 *     user-facing reason; the production-doc page surfaces it as the
 *     "Re-align needed" pill with the cap note.
 *
 * Body shape:
 *   {
 *     audioPath: '/api/voiceovers/<uuid>/audio',
 *     rowScripts: string[],          // per row, already stripped
 *     forceRefresh?: boolean         // skip cache, always re-run
 *   }
 *
 * Response shape (on success):
 *   {
 *     status: 'ready',
 *     alignment: ForcedAlignmentResponse,
 *     durationMs: number,
 *     cacheKey: string,
 *     cached: boolean,
 *     cost: number
 *   }
 *
 * Response shape (on failure):
 *   { status: 'failed', reason: string, cacheKey: string }
 *
 * The route always returns 200 on the success/failed branch — the
 * client switches on `status`. Genuine 4xx/5xx is reserved for
 * validation errors (bad body shape) and infrastructure failures.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { sql } from '@/lib/db';
import {
  ensureAlignmentForVoiceover,
  buildCanonicalScript,
} from '@/lib/voiceover-alignment-cache';
import { stripProductionMarkers } from '@/lib/script-markers';
import { logger } from '@/lib/logger';
import type { TtsProviderId, VoiceRef, VoiceTier } from '@/lib/tts/types';

export const runtime = 'nodejs';
// ElevenLabs Forced Alignment for ~15 min of audio runs in 5-15 s.
// 300 s leaves headroom for the audio fetch + a retry on a flaky
// network without spilling into the Vercel function ceiling.
export const maxDuration = 300;

// Strict path shape: same-origin proxy, UUID id, `/audio` terminator.
// Matches the format the production-doc voiceover picker writes.
const VOICEOVER_PATH_RE =
  /^\/api\/voiceovers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/audio$/i;

interface AlignRequestBody {
  audioPath?: unknown;
  rowScripts?: unknown;
  forceRefresh?: unknown;
}

export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  let body: AlignRequestBody;
  try {
    body = (await req.json()) as AlignRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ── Validate body shape ──────────────────────────────────────────
  const audioPath = typeof body.audioPath === 'string' ? body.audioPath : '';
  if (!audioPath) {
    return NextResponse.json({ error: 'audioPath is required' }, { status: 400 });
  }
  if (!VOICEOVER_PATH_RE.test(audioPath)) {
    return NextResponse.json(
      { error: 'audioPath must be a same-origin /api/voiceovers/<uuid>/audio path' },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.rowScripts) || body.rowScripts.length === 0) {
    return NextResponse.json({ error: 'rowScripts must be a non-empty array' }, { status: 400 });
  }
  // The plan caps shots at 500; mirror it here so a wildly large body
  // can't pin the canonical-script builder.
  if (body.rowScripts.length > 500) {
    return NextResponse.json({ error: 'rowScripts has too many entries (max 500)' }, { status: 400 });
  }
  for (const s of body.rowScripts) {
    if (typeof s !== 'string') {
      return NextResponse.json({ error: 'rowScripts entries must be strings' }, { status: 400 });
    }
  }

  const forceRefresh = body.forceRefresh === true;

  // ── Resolve absolute URL ──────────────────────────────────────────
  // `req.nextUrl.origin` reflects the request's protocol + host, so
  // the alignment cache fetches against the same domain the browser
  // hit. Cache keys are origin-bound — preview / prod don't share
  // alignment rows, which is the desired isolation.
  const absoluteUrl = new URL(audioPath, req.nextUrl.origin).toString();

  // ── Look up the voiceover row so the aligner knows which provider
  // produced the audio. Pre-dispatch rows have no `provider` in
  // metadata — we default to ElevenLabs for them, which preserves the
  // exact alignment behavior they had before the 2026-05-25 migration.
  const assetId = audioPath.match(VOICEOVER_PATH_RE)
    ? audioPath.split('/')[3]
    : null;
  let voice: VoiceRef | undefined;
  if (assetId) {
    try {
      const { rows } = await sql<{ metadata: Record<string, unknown> | null }>`
        SELECT metadata FROM media_assets WHERE id = ${assetId}::uuid LIMIT 1
      `;
      const metadata = rows[0]?.metadata ?? null;
      if (metadata) {
        const provider = typeof metadata.provider === 'string'
          ? metadata.provider
          : 'elevenlabs';
        const voiceId = typeof metadata.voiceId === 'string' ? metadata.voiceId : 'unknown';
        const languageCode = typeof metadata.languageCode === 'string'
          ? metadata.languageCode
          : 'en-US';
        const tier = typeof metadata.tier === 'string'
          ? (metadata.tier as VoiceTier)
          : (provider === 'google' ? 'chirp3-hd' : 'multilingual-v2');
        voice = {
          providerId: provider as TtsProviderId,
          voiceId,
          languageCode,
          tier,
        };
      }
    } catch (err) {
      logger.warn('voiceover/align: media_assets lookup failed', {
        assetId,
        detail: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal — alignment falls through to the default ElevenLabs path.
    }
  }

  // ── Build the canonical script the aligner saw ────────────────────
  // Strip production markers per row, then join newline-style — same
  // shape `buildAlignmentScript` produces for the narrator-take path,
  // so the alignment that comes back is consumable by `alignRowsToWords`.
  const stripped = (body.rowScripts as string[]).map((s) => stripProductionMarkers(s));
  const canonicalScript = buildCanonicalScript(stripped);

  if (!canonicalScript.trim()) {
    return NextResponse.json(
      { status: 'failed', reason: 'Script is empty after stripping production markers.', cacheKey: '' },
      { status: 200 },
    );
  }

  // ── Run / cache the alignment ─────────────────────────────────────
  const result = await ensureAlignmentForVoiceover(absoluteUrl, canonicalScript, {
    forceRefresh,
    voice,
  });

  if (result.status === 'failed') {
    logger.warn('voiceover/align: failed', { reason: result.reason, cacheKey: result.cacheKey });
    return NextResponse.json(result, { status: 200 });
  }

  return NextResponse.json(result, { status: 200 });
});
