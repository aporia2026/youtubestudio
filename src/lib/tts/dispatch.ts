/**
 * TTS dispatch — the single entry point routes call.
 *
 * Owns the provider + aligner registries and routes each request to
 * the right implementation. Pure dispatch — no DB, no R2, no caching.
 * Storage/persistence is the caller's job (so providers stay
 * mockable and surfaces choose their own R2 prefix).
 *
 * Provider selection
 * ------------------
 * Every request carries a `voice: VoiceRef` whose `providerId` field
 * picks the synthesizer. The aligner is picked the same way: an
 * ElevenLabs voiceover gets ElevenLabs forced-alignment; a Google
 * voiceover gets Google Speech-to-Text. The aligner choice is not
 * configurable per-request to avoid the audio-format mismatch class of
 * bugs (feeding Google MP3 into ElevenLabs' aligner works but pays a
 * second vendor unnecessarily, and the reverse — Google STT on
 * ElevenLabs audio — has no current customer benefit).
 *
 * Observability
 * -------------
 * Every entry/exit logs through `logger` with the `[tts dispatch]`
 * namespace. Providers and aligners add their own `[tts elevenlabs synth]`
 * / `[tts google synth]` / `[tts align ...]` lines. A trace through
 * the logs is enough to reconstruct exactly which path a request took
 * without diff'ing the code.
 */

import { logger } from '../logger';
import { elevenLabsSynthesizer } from './providers/elevenlabs';
import { googleSynthesizer } from './providers/google';
import { elevenLabsAligner } from './aligners/elevenlabs';
import { googleSttAligner } from './aligners/google-stt';
import {
  TtsProviderError,
  type AlignRequest,
  type AlignResult,
  type Aligner,
  type ListVoicesFilter,
  type Synthesizer,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TtsProviderId,
  type VoiceCatalogEntry,
} from './types';

// ─── Registries ──────────────────────────────────────────────────────────────

const SYNTHESIZERS: Record<TtsProviderId, Synthesizer> = {
  elevenlabs: elevenLabsSynthesizer,
  google: googleSynthesizer,
};

/**
 * Provider id → aligner. Hard-coded mapping — see the file jsdoc for
 * why it's not request-configurable.
 */
const ALIGNERS_BY_PROVIDER: Record<TtsProviderId, Aligner> = {
  elevenlabs: elevenLabsAligner,
  google: googleSttAligner,
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Set of providers configured on this deploy. Empty when no API keys
 * are set; the picker UI hides un-configured providers entirely. Cheap
 * — synchronous env check, no network.
 */
export function listConfiguredProviders(): TtsProviderId[] {
  return (Object.keys(SYNTHESIZERS) as TtsProviderId[]).filter((id) =>
    SYNTHESIZERS[id].isConfigured(),
  );
}

export function getSynthesizer(providerId: TtsProviderId): Synthesizer {
  const s = SYNTHESIZERS[providerId];
  if (!s) {
    throw new TtsProviderError(
      `Unknown TTS provider: ${providerId}`,
      providerId as TtsProviderId,
      'invalid_request',
      false,
    );
  }
  return s;
}

export function getAlignerForProvider(providerId: TtsProviderId): Aligner {
  const a = ALIGNERS_BY_PROVIDER[providerId];
  if (!a) {
    throw new TtsProviderError(
      `No aligner registered for provider: ${providerId}`,
      providerId as TtsProviderId,
      'invalid_request',
      false,
    );
  }
  return a;
}

/**
 * Synthesize via the right provider. Routes call this; the dispatcher
 * routes by `req.voice.providerId`. Errors are `TtsProviderError`
 * instances — routes can branch on `.code` and `.retryable`.
 */
export async function synthesize(req: SynthesizeRequest): Promise<SynthesizeResult> {
  const startedAt = Date.now();
  logger.info('[tts dispatch] synthesize start', {
    providerId: req.voice.providerId,
    voiceId: req.voice.voiceId,
    tier: req.voice.tier,
    languageCode: req.voice.languageCode,
    chars: req.text.length,
    ssml: Boolean(req.ssml),
  });

  const synth = getSynthesizer(req.voice.providerId);
  if (!synth.isConfigured()) {
    throw new TtsProviderError(
      `TTS provider '${req.voice.providerId}' is not configured on this server.`,
      req.voice.providerId,
      'unauthorized',
      false,
    );
  }

  try {
    const result = await synth.synthesize(req);
    logger.info('[tts dispatch] synthesize ok', {
      providerId: req.voice.providerId,
      voiceId: req.voice.voiceId,
      bytes: result.audioBytes.byteLength,
      durationMs: Date.now() - startedAt,
      costUsd: result.costUsd,
    });
    logger.info('[tts cost]', {
      providerId: req.voice.providerId,
      voiceId: req.voice.voiceId,
      tier: req.voice.tier,
      chars: result.charCount,
      durationSec: result.durationSeconds,
      costUsd: result.costUsd,
    });
    return result;
  } catch (err) {
    logger.warn('[tts dispatch] synthesize err', {
      providerId: req.voice.providerId,
      voiceId: req.voice.voiceId,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Align via the aligner matched to the voice's source provider.
 */
export async function align(req: AlignRequest): Promise<AlignResult> {
  const startedAt = Date.now();
  const aligner = getAlignerForProvider(req.voice.providerId);

  logger.info('[tts align dispatch]', {
    alignerSelected: aligner.id,
    voiceProvider: req.voice.providerId,
    languageCode: req.languageCode,
    audioBytes: req.audio.byteLength,
    chars: req.text.length,
  });

  if (!aligner.isConfigured()) {
    throw new TtsProviderError(
      `Aligner '${aligner.id}' is not configured on this server.`,
      aligner.id,
      'unauthorized',
      false,
    );
  }
  if (!aligner.supportsLanguage(req.languageCode)) {
    throw new TtsProviderError(
      `Aligner '${aligner.id}' does not support language ${req.languageCode}.`,
      aligner.id,
      'unsupported_language',
      false,
    );
  }

  const result = await aligner.align(req);
  logger.info('[tts align dispatch] ok', {
    alignerUsed: result.alignerUsed,
    wordCount: result.words.length,
    durationSec: result.durationSec,
    costUsd: result.costUsd,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

/**
 * Aggregate voice catalog across all configured providers — used by
 * the picker UI to render the full list once and let the user filter
 * client-side. Each provider's `listVoices` already handles its own
 * cache and errors; the dispatcher just merges.
 */
export async function listAllVoices(
  filter?: ListVoicesFilter,
): Promise<VoiceCatalogEntry[]> {
  const providers = listConfiguredProviders();
  const lists = await Promise.all(providers.map((id) => SYNTHESIZERS[id].listVoices(filter)));
  return lists.flat();
}

/**
 * Pure pre-flight cost estimate for the picker UI — no network call.
 */
export function estimateSynthCost(
  req: Pick<SynthesizeRequest, 'voice' | 'text' | 'ssml'>,
): number {
  return getSynthesizer(req.voice.providerId).estimateCost(req);
}
