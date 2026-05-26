/**
 * Google Cloud Text-to-Speech Synthesizer.
 *
 * Uses the official `@google-cloud/text-to-speech` Node SDK with inline
 * service-account credentials (no JSON key file on disk — see
 * `src/lib/tts/google-env.ts` for the credential loader and the Vercel
 * `\n` footgun fix).
 *
 * Tier handling
 * -------------
 * The `voice.voiceId` carries the full Google voice name (e.g.
 * 'en-US-Chirp3-HD-Charon') and the dispatcher routes the request to
 * this provider based on `voice.providerId === 'google'`. We don't
 * select the tier explicitly in the synthesis request — Google infers
 * the model from the voice name. Tier is metadata for cost lookup +
 * UI display only.
 *
 * Chirp 3 HD quirks
 * -----------------
 * Chirp 3 HD voices ignore `pitchSemitones` and `speakingRate` and
 * support a restricted SSML subset (no `<mark>`, limited prosody). The
 * SDK does NOT throw on unsupported options — it silently ignores
 * them, which would let a misconfigured client think pitch control is
 * working when it isn't. We log a warning when the caller sets these
 * options on a Chirp 3 HD voice; we don't strip them (the user's
 * settings panel is the right place to gate the input).
 *
 * Long-form synthesis
 * -------------------
 * The synchronous `synthesizeSpeech` endpoint has a 5,000-byte input
 * limit. Scripts longer than that need the async `synthesizeLongAudio`
 * pathway (operation polling, output written to GCS). For v1 the
 * dispatcher rejects long inputs with a clear error so callers can
 * chunk client-side. Implementing long-form requires a GCS bucket +
 * IAM additions and is tracked as a follow-up in the plan.
 */

import type { protos } from '@google-cloud/text-to-speech';
import { logger } from '../../logger';
import { synthCostUsd } from '../cost';
import { chunkScriptForGoogle, DEFAULT_MAX_CHUNK_BYTES } from '../chunker';
import { assertGoogleCredentialsValid, loadGoogleCredentials } from '../google-env';
import { listGoogleVoices } from '../voices/google-catalog';
import {
  TtsProviderError,
  type ListVoicesFilter,
  type Synthesizer,
  type SynthesizeRequest,
  type SynthesizeResult,
  type VoiceCatalogEntry,
} from '../types';

const PROVIDER_ID = 'google' as const;

/**
 * Hard input ceiling for the synchronous synthesizeSpeech endpoint.
 * Google's documented limit is 5,000 *bytes* (not characters), and
 * Hebrew uses multi-byte UTF-8 chars. We approximate conservatively:
 * use byte length, not char length, for the check.
 */
const SYNC_INPUT_BYTE_LIMIT = 5000;

/**
 * Gemini-TTS has tighter limits than Chirp 3 HD:
 *   - text field alone: max 4,000 bytes
 *   - text + prompt combined: max 8,000 bytes
 * Source: docs.cloud.google.com/text-to-speech/docs/gemini-tts.
 * The chunker takes a smaller maxBytes when the request targets a
 * Gemini model so long-form synthesis stays in spec.
 */
const GEMINI_TEXT_BYTE_LIMIT = 4000;
const GEMINI_COMBINED_BYTE_LIMIT = 8000;

/**
 * Map our tier enum to the Google model_name field. Tiers not in this
 * map use Google's default model selection (driven by the voice name's
 * prefix — e.g. en-US-Chirp3-HD-* → Chirp 3 HD).
 */
const TIER_TO_MODEL_NAME: Readonly<Partial<Record<string, string>>> = {
  'gemini-25-flash-tts': 'gemini-2.5-flash-tts',
  'gemini-31-flash-tts': 'gemini-3.1-flash-tts-preview',
};

function isGeminiTier(tier: string): boolean {
  return tier === 'gemini-25-flash-tts' || tier === 'gemini-31-flash-tts';
}

/**
 * Gemini-TTS reuses the Chirp voice catalog but expects the BARE voice
 * name in the synthesis request — not the locale-prefixed form.
 *
 *   Chirp 3 HD sync:  voice.name = "en-US-Chirp3-HD-Charon"
 *   Gemini-TTS:       voice.name = "Charon"  + voice.modelName = "gemini-3.1-flash-tts-preview"
 *
 * Passing the full Chirp name to Gemini throws:
 *   "Gemini models cannot be used with non-Gemini voices."
 *
 * Our catalog stores the full Chirp name as voiceId so re-renders
 * stay deterministic against media_assets.metadata.voiceId — this
 * helper strips the locale + Chirp3-HD prefix to recover the bare
 * name at synthesis time. Falls back to the raw voiceId if the
 * pattern doesn't match (defensive — non-Chirp voice names won't
 * have the prefix in the first place).
 */
function geminiVoiceName(voiceId: string): string {
  const match = voiceId.match(/Chirp3-HD-(.+)$/i);
  return match ? match[1] : voiceId;
}

/**
 * Parallelism cap for long-form chunked synthesis. Google's per-project
 * QPS quotas for TTS are generous (300/min default at writing) but
 * concurrent requests on Chirp 3 HD can throttle. 3 in-flight is a
 * conservative ceiling that keeps a 30-minute YouTube narration
 * (~5 chunks) completing in two waves.
 */
const LONG_FORM_CONCURRENCY = 3;

/**
 * Lazy SDK import. Keeps cold-start cheap on routes that don't touch
 * Google.
 */
async function getClient() {
  const creds = assertGoogleCredentialsValid();
  const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
  return new TextToSpeechClient({
    projectId: creds.projectId,
    credentials: {
      client_email: creds.clientEmail,
      private_key: creds.privateKey,
    },
  });
}

function isChirp3Hd(voiceId: string): boolean {
  return /-Chirp3-HD-/i.test(voiceId);
}

class GoogleSynthesizer implements Synthesizer {
  readonly id = PROVIDER_ID;

  isConfigured(): boolean {
    return loadGoogleCredentials() !== null;
  }

  async synthesize(req: SynthesizeRequest): Promise<SynthesizeResult> {
    if (req.options.providerId !== 'google') {
      throw new TtsProviderError(
        'Google provider received non-google options.',
        PROVIDER_ID,
        'invalid_request',
        false,
      );
    }

    const text = req.text;
    const ssml = req.ssml;
    const useSsml = Boolean(ssml);
    const payloadBytes = Buffer.byteLength(useSsml ? ssml! : text, 'utf8');

    // Gemini-TTS has tighter limits than Chirp 3 HD. The chunker
    // honors them when this is a Gemini request.
    const isGemini = isGeminiTier(req.voice.tier);
    const textByteLimit = isGemini ? GEMINI_TEXT_BYTE_LIMIT : SYNC_INPUT_BYTE_LIMIT;

    // For Gemini, the prompt counts toward an 8KB combined cap.
    // Validate before chunking so an oversized prompt fails loudly
    // rather than splitting weirdly.
    if (isGemini) {
      const stylePrompt = (req.options.providerId === 'google' && req.options.stylePrompt) || '';
      const promptBytes = Buffer.byteLength(stylePrompt, 'utf8');
      if (promptBytes > GEMINI_TEXT_BYTE_LIMIT) {
        throw new TtsProviderError(
          `Gemini-TTS style prompt exceeds ${GEMINI_TEXT_BYTE_LIMIT}-byte limit (${promptBytes} bytes).`,
          PROVIDER_ID,
          'invalid_request',
          false,
        );
      }
      // Per-chunk text + prompt must stay under 8KB. Reserve the prompt
      // size from each chunk so the combined call never overflows.
      const perChunkTextBudget = Math.max(500, GEMINI_COMBINED_BYTE_LIMIT - promptBytes);
      if (payloadBytes <= Math.min(textByteLimit, perChunkTextBudget)) {
        // Fits in one request — fall through to the short-form path.
      } else {
        if (useSsml) {
          throw new TtsProviderError(
            `Gemini-TTS SSML input exceeds size limit. Pass plain text instead.`,
            PROVIDER_ID,
            'invalid_request',
            false,
          );
        }
        return this.synthesizeLongForm(req, Math.min(textByteLimit, perChunkTextBudget));
      }
    } else if (payloadBytes > SYNC_INPUT_BYTE_LIMIT) {
      if (useSsml) {
        // SSML can't be chunked safely — tags would slice across chunk
        // boundaries and produce broken markup. Callers passing SSML
        // must keep each request under the limit themselves.
        throw new TtsProviderError(
          `Google SSML input exceeds ${SYNC_INPUT_BYTE_LIMIT}-byte limit ` +
            `(${payloadBytes} bytes). Chunking SSML is not supported because ` +
            `tags would break across boundaries. Pass plain text instead, or ` +
            `chunk the SSML caller-side at safe tag boundaries.`,
          PROVIDER_ID,
          'invalid_request',
          false,
        );
      }
      // Plain text — chunk + parallel synth + concat MP3 bytes.
      return this.synthesizeLongForm(req);
    }

    if (isChirp3Hd(req.voice.voiceId)) {
      if (req.options.pitchSemitones !== undefined || req.options.speakingRate !== undefined) {
        logger.warn('[tts google synth] chirp3-hd ignores pitch/speakingRate', {
          voiceId: req.voice.voiceId,
          pitch: req.options.pitchSemitones,
          rate: req.options.speakingRate,
        });
      }
    }

    logger.info('[tts google synth] start', {
      voiceId: req.voice.voiceId,
      tier: req.voice.tier,
      languageCode: req.voice.languageCode,
      chars: text.length,
      bytes: payloadBytes,
      ssml: useSsml,
    });

    const client = await getClient();

    const geminiModelName = isGemini ? TIER_TO_MODEL_NAME[req.voice.tier] : undefined;
    const stylePrompt =
      isGemini && req.options.providerId === 'google' ? req.options.stylePrompt : undefined;

    const synthRequest: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
      input: useSsml
        ? { ssml }
        : isGemini && stylePrompt
          ? // Gemini-TTS accepts a parallel `prompt` field carrying
            // natural-language style instructions ("Read this in a
            // conspiratorial whisper") alongside the literal text.
            // Typed via 'as never' because the SDK's generated d.ts
            // hasn't been updated yet to expose the Gemini-only prompt
            // field; the API accepts it (verified 2026-05-26 against
            // docs.cloud.google.com/text-to-speech/docs/gemini-tts).
            ({ text, prompt: stylePrompt } as never)
          : { text },
      voice: {
        languageCode: req.voice.languageCode,
        // Gemini expects the bare voice name ("Charon"); Chirp 3 HD and
        // all other tiers want the full locale-prefixed form
        // ("en-US-Chirp3-HD-Charon"). See geminiVoiceName() comment.
        name: isGemini ? geminiVoiceName(req.voice.voiceId) : req.voice.voiceId,
        // Set model_name only for Gemini tiers — for everything else
        // Google infers the model from the voice name's prefix
        // (en-US-Chirp3-HD-* → Chirp 3 HD, en-US-Studio-* → Studio).
        ...(geminiModelName ? ({ modelName: geminiModelName } as never) : {}),
      },
      audioConfig: {
        // 'MP3' is accepted as the enum string form by the SDK — its
        // typed signature is `AudioEncoding | keyof typeof AudioEncoding | null`.
        audioEncoding: 'MP3',
        // Chirp 3 HD AND Gemini-TTS both ignore pitch/speakingRate —
        // their expressive control comes from the prompt + audio tags.
        ...(isChirp3Hd(req.voice.voiceId) || isGemini
          ? {}
          : {
              pitch: req.options.pitchSemitones,
              speakingRate: req.options.speakingRate,
              effectsProfileId: req.options.audioProfile
                ? [req.options.audioProfile]
                : undefined,
            }),
      },
    };

    const startedAt = Date.now();
    let response: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechResponse;
    try {
      const [res] = await client.synthesizeSpeech(synthRequest);
      response = res;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const sanitized = raw.replace(/https?:\/\/\S+/g, '<url>').slice(0, 280);
      logger.warn('[tts google synth err]', {
        voiceId: req.voice.voiceId,
        detail: sanitized,
      });
      throw classifyGoogleError(sanitized);
    }

    const audioContent = response.audioContent;
    if (!audioContent || (typeof audioContent === 'string' && !audioContent.length)) {
      throw new TtsProviderError(
        'Google synthesis returned empty audio.',
        PROVIDER_ID,
        'vendor_5xx',
        true,
      );
    }

    const audioBytes =
      typeof audioContent === 'string'
        ? new Uint8Array(Buffer.from(audioContent, 'base64'))
        : audioContent instanceof Uint8Array
          ? audioContent
          : new Uint8Array(audioContent as ArrayBuffer);

    const charCount = text.length;
    const durationSeconds = Math.max(1, charCount / 15);
    const costUsd = synthCostUsd(req.voice.tier, charCount);

    logger.info('[tts google synth] ok', {
      voiceId: req.voice.voiceId,
      bytes: audioBytes.byteLength,
      durationMs: Date.now() - startedAt,
      estimatedDurationSec: durationSeconds,
      costUsd,
    });

    return {
      audioBytes,
      mimeType: 'audio/mpeg',
      durationSeconds,
      charCount,
      costUsd,
      providerMetadata: {
        voiceId: req.voice.voiceId,
        tier: req.voice.tier,
        languageCode: req.voice.languageCode,
        ssml: useSsml,
        ...(geminiModelName ? { modelName: geminiModelName } : {}),
        ...(stylePrompt ? { stylePromptChars: stylePrompt.length } : {}),
      },
    };
  }

  async listVoices(filter?: ListVoicesFilter): Promise<VoiceCatalogEntry[]> {
    return listGoogleVoices(filter);
  }

  estimateCost(req: Pick<SynthesizeRequest, 'voice' | 'text' | 'ssml'>): number {
    const charCount = (req.ssml ?? req.text).length;
    return synthCostUsd(req.voice.tier, charCount);
  }

  /**
   * Long-form synthesis path: text exceeds the sync endpoint's 5,000-
   * byte limit. We chunk on sentence boundaries (see ../chunker.ts),
   * synthesize each chunk in waves of `LONG_FORM_CONCURRENCY`, then
   * concatenate the MP3 byte streams.
   *
   * MP3 frames are self-contained, so byte-level concatenation works
   * for playback. Sentence-boundary joints fall during natural pauses
   * where Google's TTS already adds ~250 ms of silence — the seam is
   * inaudible to listeners. If a user encounters audible artifacts on
   * a specific script, the fix is usually to add a paragraph break
   * earlier in that sentence so the chunker picks a different
   * boundary.
   *
   * Errors mid-batch are propagated as TtsProviderError — we don't
   * partially return audio for a partially-failed batch, since the
   * caller would have no way to know which sentences were missing.
   */
  private async synthesizeLongForm(
    req: SynthesizeRequest,
    overrideMaxBytes?: number,
  ): Promise<SynthesizeResult> {
    // Gemini-TTS callers pass a smaller maxBytes to honor the
    // 4KB-text + 8KB-combined limit minus the style prompt size.
    const chunks = chunkScriptForGoogle(req.text, overrideMaxBytes ?? DEFAULT_MAX_CHUNK_BYTES);
    if (chunks.length === 0) {
      throw new TtsProviderError(
        'Google long-form synthesis received empty text after chunking.',
        PROVIDER_ID,
        'invalid_request',
        false,
      );
    }

    logger.info('[tts google synth long-form] start', {
      voiceId: req.voice.voiceId,
      tier: req.voice.tier,
      languageCode: req.voice.languageCode,
      totalChars: req.text.length,
      totalBytes: Buffer.byteLength(req.text, 'utf8'),
      chunkCount: chunks.length,
      concurrency: LONG_FORM_CONCURRENCY,
    });

    const startedAt = Date.now();
    const audioBuffers: Uint8Array[] = [];
    let totalCharCount = 0;
    let totalCostUsd = 0;

    for (let i = 0; i < chunks.length; i += LONG_FORM_CONCURRENCY) {
      const wave = chunks.slice(i, i + LONG_FORM_CONCURRENCY);
      // Recursive call back into synthesize() — each chunk is below
      // the limit so it lands on the short-form path. Strip ssml from
      // the request: we already validated up front that the long-form
      // path is text-only.
      const results = await Promise.all(
        wave.map((chunkText) =>
          this.synthesize({
            ...req,
            text: chunkText,
            ssml: undefined,
          }),
        ),
      );
      for (const r of results) {
        audioBuffers.push(r.audioBytes);
        totalCharCount += r.charCount;
        totalCostUsd += r.costUsd;
      }
    }

    const totalBytes = audioBuffers.reduce((sum, b) => sum + b.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const buf of audioBuffers) {
      merged.set(buf, offset);
      offset += buf.byteLength;
    }

    const durationSeconds = Math.max(1, totalCharCount / 15);

    logger.info('[tts google synth long-form] ok', {
      voiceId: req.voice.voiceId,
      chunkCount: chunks.length,
      totalBytes,
      totalCharCount,
      totalCostUsd,
      durationMs: Date.now() - startedAt,
      estimatedDurationSec: durationSeconds,
    });

    return {
      audioBytes: merged,
      mimeType: 'audio/mpeg',
      durationSeconds,
      charCount: totalCharCount,
      costUsd: totalCostUsd,
      providerMetadata: {
        voiceId: req.voice.voiceId,
        tier: req.voice.tier,
        languageCode: req.voice.languageCode,
        chunked: true,
        chunkCount: chunks.length,
      },
    };
  }
}

function classifyGoogleError(sanitized: string): TtsProviderError {
  const lower = sanitized.toLowerCase();
  if (lower.includes('unauthenticated') || lower.includes('permission_denied')) {
    return new TtsProviderError(
      `Google authentication failed: ${sanitized}`,
      PROVIDER_ID,
      'unauthorized',
      false,
      sanitized,
    );
  }
  if (lower.includes('resource_exhausted') || lower.includes('quota')) {
    return new TtsProviderError(
      `Google quota exceeded: ${sanitized}`,
      PROVIDER_ID,
      'rate_limited',
      true,
      sanitized,
    );
  }
  if (lower.includes('invalid_argument') || lower.includes('invalid')) {
    return new TtsProviderError(
      `Google rejected the request: ${sanitized}`,
      PROVIDER_ID,
      'invalid_request',
      false,
      sanitized,
    );
  }
  if (lower.includes('deadline') || lower.includes('timeout')) {
    return new TtsProviderError(
      `Google synthesis timed out: ${sanitized}`,
      PROVIDER_ID,
      'timeout',
      true,
      sanitized,
    );
  }
  return new TtsProviderError(
    `Google synthesis failed: ${sanitized}`,
    PROVIDER_ID,
    'vendor_5xx',
    true,
    sanitized,
  );
}

export const googleSynthesizer: Synthesizer = new GoogleSynthesizer();
