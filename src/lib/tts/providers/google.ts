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
import { chunkSsmlForGoogle, isSsml, ssmlToGeminiText } from '../ssml-chunker';
import { buildWav, parseWav } from '../wav-concat';
import { normalizeChunks, rmsToDb } from '../pcm-normalize';
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

/**
 * Encoding decision matrix for the Google provider:
 *
 *   - Single-chunk synthesis: LINEAR16/WAV. Highest quality (lossless),
 *     no concat involved.
 *   - Multi-chunk (long-form): MP3. MP3 frames are self-contained, so
 *     byte-concatenating chunks at sentence boundaries produces a
 *     fully playable file. The previous LINEAR16/WAV long-form path
 *     surfaced two issues: (a) WAV RIFF headers landing mid-stream
 *     after naive concat, and (b) even after switching to header-
 *     aware concat, Chirp 3 HD's per-call auto-gain varied between
 *     chunks producing audible volume drift across long narrations.
 *     MP3 doesn't have the header-in-middle problem AND each MP3
 *     frame is independently decoded, so per-chunk amplitude
 *     differences manifest at frame boundaries (a few ms) rather
 *     than accumulating into noticeable drift.
 *
 * Trade-off: long narrations get ~32 kbps MP3 (Google's default for
 * audioEncoding=MP3) instead of lossless WAV. For YouTube — which
 * re-encodes everything anyway — this is inaudible. What you gain is
 * complete reliability at any script length.
 */
type GoogleEncoding = 'LINEAR16' | 'MP3';

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

    // Auto-detect SSML in the text field. Users often paste SSML
    // (`<speak>...<break time="2s"/>...</speak>`) into the script
    // textarea expecting it to "just work". Without detection, the
    // long-form chunker splits at sentence boundaries and cuts the
    // <speak> wrapper across chunks — Chirp 3 HD gets malformed SSML
    // in every chunk after the first, producing the "starts good,
    // gets worse" volume/quality drift users have reported.
    //
    // Promote SSML-looking text into req.ssml so all downstream
    // logic (size check, long-form routing, chunker selection) does
    // the right thing.
    let text = req.text;
    let ssml = req.ssml;
    if (!ssml && text && isSsml(text)) {
      logger.info('[tts google synth] auto-detected SSML in text field', {
        bytes: Buffer.byteLength(text, 'utf8'),
      });
      ssml = text;
      text = '';
    }

    const isGemini = isGeminiTier(req.voice.tier);

    // Gemini-TTS does not accept SSML — its expressive vocabulary is
    // inline bracketed tags. When the user picks a Gemini voice with
    // SSML input, convert the SSML to Gemini-flavored text (stripping
    // tags, rewriting <break> → [long pause] / [medium pause] /
    // [short pause]) and route through the text path.
    if (isGemini && ssml) {
      const converted = ssmlToGeminiText(ssml);
      logger.info('[tts google synth] converted SSML to Gemini inline tags', {
        ssmlBytes: Buffer.byteLength(ssml, 'utf8'),
        textBytes: Buffer.byteLength(converted, 'utf8'),
      });
      text = converted;
      ssml = undefined;
    }

    const useSsml = Boolean(ssml);
    const payloadBytes = Buffer.byteLength(useSsml ? ssml! : text, 'utf8');
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
      const perChunkTextBudget = Math.max(500, GEMINI_COMBINED_BYTE_LIMIT - promptBytes);
      if (payloadBytes > Math.min(textByteLimit, perChunkTextBudget)) {
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
      // Long-form path — SSML now supported via the SSML-aware
      // chunker (splits on <break> tag boundaries, preserves tag
      // balance per chunk). Pass the normalized req with the
      // resolved ssml/text fields so synthesizeLongForm sees what
      // we detected.
      return this.synthesizeLongForm({ ...req, text, ssml });
    }

    // Update req for the short-form path if we promoted text→ssml.
    req = { ...req, text, ssml };

    // Single-chunk path: LINEAR16 for maximum quality.
    //
    // Safety hatch: `GOOGLE_TTS_FORCE_MP3=true` forces MP3 even for
    // short content. Useful if a future single-chunk LINEAR16 issue
    // surfaces and the deploy needs an immediate downgrade without a
    // code change.
    const forceMp3 = process.env.GOOGLE_TTS_FORCE_MP3 === 'true';
    return this.synthesizeOnce(req, forceMp3 ? 'MP3' : 'LINEAR16');
  }

  /**
   * Single API call to Google's synthesizeSpeech, with explicit
   * audio encoding. The short-form path calls this with LINEAR16
   * (lossless WAV); the long-form chunked path calls it with MP3
   * for every chunk so byte-concat produces a clean file.
   */
  private async synthesizeOnce(
    req: SynthesizeRequest,
    encoding: GoogleEncoding,
  ): Promise<SynthesizeResult> {
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
    const isGemini = isGeminiTier(req.voice.tier);

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
      encoding,
    });

    const client = await getClient();

    const geminiModelName = isGemini ? TIER_TO_MODEL_NAME[req.voice.tier] : undefined;
    const stylePrompt =
      isGemini && req.options.providerId === 'google' ? req.options.stylePrompt : undefined;

    const synthRequest: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
      input: useSsml
        ? { ssml }
        : isGemini && stylePrompt
          ? ({ text, prompt: stylePrompt } as never)
          : { text },
      voice: {
        languageCode: req.voice.languageCode,
        name: isGemini ? geminiVoiceName(req.voice.voiceId) : req.voice.voiceId,
        ...(geminiModelName ? ({ modelName: geminiModelName } as never) : {}),
      },
      audioConfig: {
        audioEncoding: encoding,
        // Pin sampleRateHertz only for LINEAR16 — for MP3 we let
        // Google emit at its default (matches the voice's native rate
        // for Chirp 3 HD / Studio at 24 kHz). Setting it on MP3 is a
        // no-op but explicit-is-better.
        ...(encoding === 'LINEAR16' ? { sampleRateHertz: 24000 } : { sampleRateHertz: 24000 }),
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

    const mimeType: 'audio/wav' | 'audio/mpeg' =
      encoding === 'LINEAR16' ? 'audio/wav' : 'audio/mpeg';
    const charCount = text.length;
    const durationSeconds = Math.max(1, charCount / 15);
    const costUsd = synthCostUsd(req.voice.tier, charCount);

    logger.info('[tts google synth] ok', {
      voiceId: req.voice.voiceId,
      encoding,
      mimeType,
      bytes: audioBytes.byteLength,
      durationMs: Date.now() - startedAt,
      estimatedDurationSec: durationSeconds,
      costUsd,
    });

    return {
      audioBytes,
      mimeType,
      durationSeconds,
      charCount,
      costUsd,
      providerMetadata: {
        voiceId: req.voice.voiceId,
        tier: req.voice.tier,
        languageCode: req.voice.languageCode,
        ssml: useSsml,
        encoding,
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
    // SSML vs plain text branch. The SSML path is critical: splitting
    // SSML at sentence boundaries (the plain-text behavior) leaves
    // `<speak>...</speak>` unbalanced across chunks, which Chirp 3 HD
    // either errors on or — worse — silently degrades. The SSML
    // chunker splits at `<break>` boundaries and re-wraps each chunk.
    const useSsml = Boolean(req.ssml);
    const sourcePayload = useSsml ? req.ssml! : req.text;
    const maxBytes = overrideMaxBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    // Each chunk's content (the string passed to Google) — plain text
    // for the text path, full `<speak>...</speak>` documents for SSML.
    const chunks: string[] = useSsml
      ? chunkSsmlForGoogle(sourcePayload, maxBytes)
      : chunkScriptForGoogle(sourcePayload, maxBytes);

    if (chunks.length === 0) {
      throw new TtsProviderError(
        'Google long-form synthesis received empty input after chunking.',
        PROVIDER_ID,
        'invalid_request',
        false,
      );
    }

    logger.info('[tts google synth long-form] start', {
      voiceId: req.voice.voiceId,
      tier: req.voice.tier,
      languageCode: req.voice.languageCode,
      totalChars: sourcePayload.length,
      totalBytes: Buffer.byteLength(sourcePayload, 'utf8'),
      chunkCount: chunks.length,
      concurrency: LONG_FORM_CONCURRENCY,
      inputType: useSsml ? 'ssml' : 'text',
    });

    const startedAt = Date.now();
    // Long-form uses LINEAR16/WAV chunks. Rationale: we need per-
    // chunk PCM to run RMS-based volume normalization (Chirp 3 HD
    // returns anomalously quiet audio for some chunks — verified
    // 2026-05-26 against a user-reported 14-min voiceover where
    // chunks at 150-210s and 330-450s were 12-22 dB quieter than
    // the rest). PCM lets us measure RMS in pure JS, identify
    // outliers, and amplify them to match the median — eliminating
    // the perceived "voice quality drops mid-narration" symptom.
    // MP3 would obscure the per-chunk volume in lossy compression
    // and prevent the fix.
    const pcmChunks: Uint8Array[] = [];
    let wavFormat:
      | { sampleRate: number; numChannels: number; bitsPerSample: number }
      | null = null;
    let totalCharCount = 0;
    let totalCostUsd = 0;
    let chunksReceived = 0;

    for (let i = 0; i < chunks.length; i += LONG_FORM_CONCURRENCY) {
      const wave = chunks.slice(i, i + LONG_FORM_CONCURRENCY);
      const results = await Promise.all(
        wave.map((chunkPayload) =>
          this.synthesizeOnce(
            useSsml
              ? { ...req, text: '', ssml: chunkPayload }
              : { ...req, text: chunkPayload, ssml: undefined },
            'LINEAR16',
          ),
        ),
      );
      for (const r of results) {
        if (!r.audioBytes || r.audioBytes.byteLength === 0) {
          throw new TtsProviderError(
            `Google long-form synthesis received empty audio for chunk ${chunksReceived + 1}/${chunks.length}.`,
            PROVIDER_ID,
            'vendor_5xx',
            true,
          );
        }
        if (r.mimeType !== 'audio/wav') {
          throw new TtsProviderError(
            `Google long-form chunk returned unexpected mimeType ${r.mimeType}; expected audio/wav.`,
            PROVIDER_ID,
            'vendor_5xx',
            false,
          );
        }
        chunksReceived++;
        totalCharCount += r.charCount;
        totalCostUsd += r.costUsd;
        const parsed = parseWav(r.audioBytes);
        if (!wavFormat) {
          wavFormat = {
            sampleRate: parsed.sampleRate,
            numChannels: parsed.numChannels,
            bitsPerSample: parsed.bitsPerSample,
          };
        } else if (
          parsed.sampleRate !== wavFormat.sampleRate ||
          parsed.numChannels !== wavFormat.numChannels ||
          parsed.bitsPerSample !== wavFormat.bitsPerSample
        ) {
          throw new TtsProviderError(
            `Google long-form chunk ${chunksReceived} has mismatched WAV format.`,
            PROVIDER_ID,
            'vendor_5xx',
            false,
          );
        }
        pcmChunks.push(parsed.pcm);
      }
    }

    if (chunksReceived !== chunks.length || !wavFormat) {
      throw new TtsProviderError(
        `Google long-form synthesis chunk count mismatch: sent ${chunks.length}, received ${chunksReceived}.`,
        PROVIDER_ID,
        'vendor_5xx',
        true,
      );
    }

    // Per-chunk volume normalization — the actual fix for the
    // "voice gets quiet mid-narration" symptom. Measures each
    // chunk's RMS, identifies outliers >6 dB below the median, and
    // amplifies them (capped at +6 dB gain to avoid noise-floor
    // amplification).
    const normalized = normalizeChunks(pcmChunks);
    const liftedCount = normalized.filter((n) => n.appliedGain > 1).length;
    if (liftedCount > 0) {
      logger.info('[tts google synth long-form] normalized quiet chunks', {
        totalChunks: normalized.length,
        liftedChunks: liftedCount,
        gainSummary: normalized
          .map((n, i) => (n.appliedGain > 1 ? { i, rmsDb: rmsToDb(n.rmsLinear).toFixed(1), gain: n.appliedGain.toFixed(2) } : null))
          .filter(Boolean),
      });
    }

    // Glue normalized PCM and emit one WAV with a single header.
    const totalPcmBytes = normalized.reduce((sum, n) => sum + n.pcm.byteLength, 0);
    const combinedPcm = new Uint8Array(totalPcmBytes);
    let offset = 0;
    for (const n of normalized) {
      combinedPcm.set(n.pcm, offset);
      offset += n.pcm.byteLength;
    }
    const merged = buildWav({ ...wavFormat, pcm: combinedPcm });
    const chunkMimeType: 'audio/wav' = 'audio/wav';

    const durationSeconds = Math.max(1, totalCharCount / 15);

    logger.info('[tts google synth long-form] ok', {
      voiceId: req.voice.voiceId,
      chunkCount: chunks.length,
      totalBytes: merged.byteLength,
      totalCharCount,
      totalCostUsd,
      mimeType: chunkMimeType,
      durationMs: Date.now() - startedAt,
      estimatedDurationSec: durationSeconds,
    });

    return {
      audioBytes: merged,
      mimeType: chunkMimeType,
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
