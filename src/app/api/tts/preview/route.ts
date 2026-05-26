import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { apiRoute } from '@/lib/route-helpers';
import {
  getNarrationDownloadUrl,
  mimeTypeToExt,
  uploadToBucket,
} from '@/lib/r2';
import { synthesize } from '@/lib/tts/dispatch';
import { TtsProviderError, type TtsProviderId, type VoiceTier } from '@/lib/tts/types';

export const maxDuration = 60;

/**
 * GET /api/tts/preview
 *
 * Generate a short audio sample for a Google voice so the picker can
 * play a preview before the user commits. ElevenLabs voices already
 * carry `preview_url` from /v1/voices — this endpoint exists because
 * Google's listVoices API doesn't expose previews.
 *
 * Query params:
 *   - provider:     'google' (required; ElevenLabs is handled client-side)
 *   - voiceId:      e.g. 'en-US-Chirp3-HD-Charon'
 *   - tier:         'chirp3-hd' | 'gemini-25-flash-tts' | 'gemini-31-flash-tts' | ...
 *   - languageCode: 'en-US', 'he-IL', etc.
 *
 * Response: `{ url: string }`. The URL points at an MP3 in the R2
 * narration bucket under the `voice-previews/` prefix.
 *
 * Caching:
 *   - In-memory dedup per function instance keys (provider, voiceId,
 *     tier, languageCode) → URL. A repeat request hits this map and
 *     returns immediately (no synthesis, no R2 round-trip).
 *   - R2 holds the audio bytes persistently. Function-instance
 *     restarts re-synthesize once and repopulate the map.
 *
 * Cost: ~$0.0015 per Chirp 3 HD preview, ~$0.0017 per Gemini, ~$0.008
 * per Studio. Bounded — only one synthesis per (voice, tier,
 * language) tuple ever. A workspace previewing every Google voice
 * once costs pennies.
 */

const SAMPLE_TEXT_BY_LANG: Readonly<Record<string, string>> = {
  'en-US': 'Hello, this is a voice preview.',
  'en-GB': 'Hello, this is a voice preview.',
  'es-ES': 'Hola, esta es una vista previa de voz.',
  'fr-FR': 'Bonjour, ceci est un aperçu vocal.',
  'de-DE': 'Hallo, dies ist eine Sprachvorschau.',
  'ar-XA': 'مرحبا، هذه معاينة صوتية.',
  'ja-JP': 'こんにちは、これは音声プレビューです。',
  'he-IL': 'שלום, זוהי דוגמה לקול.',
};

const FALLBACK_SAMPLE = 'Hello, this is a voice preview.';

const previewUrlCache = new Map<string, string>();

const ALLOWED_TIERS: ReadonlySet<VoiceTier> = new Set([
  'standard',
  'wavenet',
  'neural2',
  'polyglot',
  'chirp3-hd',
  'studio',
  'gemini-25-flash-tts',
  'gemini-31-flash-tts',
]);

export const GET = apiRoute.authed(async (_session, req: NextRequest) => {
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider');
  const voiceId = url.searchParams.get('voiceId');
  const tier = url.searchParams.get('tier');
  const languageCode = url.searchParams.get('languageCode') ?? 'en-US';

  if (provider !== 'google') {
    return NextResponse.json(
      { error: "provider must be 'google' (ElevenLabs previews come from their voice catalog directly)." },
      { status: 400 },
    );
  }
  if (!voiceId || !tier) {
    return NextResponse.json({ error: 'voiceId and tier are required' }, { status: 400 });
  }
  if (!ALLOWED_TIERS.has(tier as VoiceTier)) {
    return NextResponse.json({ error: `Unknown tier: ${tier}` }, { status: 400 });
  }

  const cacheKey = `${provider}|${voiceId}|${tier}|${languageCode}`;
  const cached = previewUrlCache.get(cacheKey);
  if (cached) {
    return NextResponse.json({ url: cached, cached: true });
  }

  const sampleText = SAMPLE_TEXT_BY_LANG[languageCode] ?? FALLBACK_SAMPLE;

  try {
    const result = await synthesize({
      voice: {
        providerId: 'google' as TtsProviderId,
        voiceId,
        languageCode,
        tier: tier as VoiceTier,
      },
      text: sampleText,
      options: { providerId: 'google' },
    });

    const bucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
    const safeVoiceId = voiceId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = mimeTypeToExt(result.mimeType);
    const r2Key = `voice-previews/google/${safeVoiceId}__${tier}__${languageCode}.${ext}`;
    await uploadToBucket(bucket, r2Key, Buffer.from(result.audioBytes), result.mimeType);
    const audioUrl = await getNarrationDownloadUrl(r2Key);

    previewUrlCache.set(cacheKey, audioUrl);

    logger.info('[tts api preview] generated', {
      voiceId,
      tier,
      languageCode,
      bytes: result.audioBytes.byteLength,
      costUsd: result.costUsd,
    });

    return NextResponse.json({ url: audioUrl, cached: false });
  } catch (err) {
    if (err instanceof TtsProviderError) {
      logger.warn('[tts api preview] provider error', {
        voiceId,
        tier,
        code: err.code,
      });
      const status = err.code === 'unauthorized' ? 503 : err.code === 'rate_limited' ? 429 : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    logger.error('[tts api preview] unexpected error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Preview generation failed' },
      { status: 500 },
    );
  }
});
