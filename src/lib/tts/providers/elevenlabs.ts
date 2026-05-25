/**
 * ElevenLabs Synthesizer adapter.
 *
 * Wraps the existing pure-fetch functions in `src/lib/elevenlabs.ts`
 * behind the `Synthesizer` contract from `src/lib/tts/types.ts`. The
 * existing module stays as-is so any callers that haven't migrated to
 * the dispatch layer continue to work unchanged — this file is purely
 * additive.
 *
 * The API-key sourcing logic intentionally mirrors what the existing
 * routes do: read from server env, fall through to a request-supplied
 * key when present. The dispatcher passes the request-supplied key (if
 * any) through `SynthesizeRequest.options` via a future extension; for
 * now the env key is the only path because that matches every server-
 * side call site (the only client-side override path is the voiceover
 * studio page, which will start using `apiKey` after PR-equivalent
 * surface refactor — see plan §"Per-surface integration").
 */

import {
  generateVoiceover,
  getVoices,
  type ElevenLabsVoice,
} from '../../elevenlabs';
import { synthCostUsd } from '../cost';
import { logger } from '../../logger';
import {
  TtsProviderError,
  type ElevenLabsVoiceTier,
  type ListVoicesFilter,
  type Synthesizer,
  type SynthesizeRequest,
  type SynthesizeResult,
  type VoiceCatalogEntry,
} from '../types';

const PROVIDER_ID = 'elevenlabs' as const;

/**
 * Map the ElevenLabs model id (e.g. 'eleven_multilingual_v2') onto the
 * `ElevenLabsVoiceTier` enum used by the cost table. Defaults to
 * 'multilingual-v2' for unknown ids — picker UI will still show a
 * sensible label and the cost estimate won't be wildly wrong.
 */
function modelIdToTier(modelId: string): ElevenLabsVoiceTier {
  if (modelId === 'eleven_turbo_v2_5') return 'turbo-v2-5';
  if (modelId === 'eleven_turbo_v2') return 'turbo-v2';
  if (modelId === 'eleven_monolingual_v1') return 'monolingual-v1';
  return 'multilingual-v2';
}

/**
 * Estimate spoken duration from text length. ElevenLabs doesn't expose
 * audio duration in the synthesis response and parsing the MP3 header
 * server-side adds a dependency for marginal value (the true duration
 * is recovered later by the aligner). 15 chars/sec is a reasonable
 * average across English/Hebrew narration speed.
 */
function estimateDurationSec(text: string): number {
  return Math.max(1, text.length / 15);
}

class ElevenLabsSynthesizer implements Synthesizer {
  readonly id = PROVIDER_ID;

  isConfigured(): boolean {
    return Boolean(process.env.ELEVENLABS_API_KEY);
  }

  async synthesize(req: SynthesizeRequest): Promise<SynthesizeResult> {
    if (req.options.providerId !== 'elevenlabs') {
      throw new TtsProviderError(
        'ElevenLabs provider received non-elevenlabs options.',
        PROVIDER_ID,
        'invalid_request',
        false,
      );
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new TtsProviderError(
        'ELEVENLABS_API_KEY is not configured.',
        PROVIDER_ID,
        'unauthorized',
        false,
      );
    }

    const text = req.ssml ?? req.text;
    const charCount = text.length;
    const tier = modelIdToTier(req.options.modelId);

    logger.info('[tts elevenlabs synth] start', {
      voiceId: req.voice.voiceId,
      modelId: req.options.modelId,
      tier,
      chars: charCount,
      languageCode: req.voice.languageCode,
    });

    const startedAt = Date.now();
    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await generateVoiceover(apiKey, {
        text,
        voiceId: req.voice.voiceId,
        modelId: req.options.modelId,
        voiceSettings: {
          stability: req.options.stability,
          similarity_boost: req.options.similarity,
          style: req.options.style,
          use_speaker_boost: req.options.useSpeakerBoost,
        },
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const sanitized = raw.replace(/https?:\/\/\S+/g, '<url>').slice(0, 240);
      logger.warn('[tts elevenlabs synth err]', {
        voiceId: req.voice.voiceId,
        detail: sanitized,
      });
      throw new TtsProviderError(
        `ElevenLabs synthesis failed: ${sanitized}`,
        PROVIDER_ID,
        sanitized.includes('429') ? 'rate_limited' : 'vendor_5xx',
        sanitized.includes('429'),
        sanitized,
      );
    }

    const audioBytes = new Uint8Array(arrayBuffer);
    const durationSeconds = estimateDurationSec(text);
    const costUsd = synthCostUsd(tier, charCount);

    logger.info('[tts elevenlabs synth] ok', {
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
        modelId: req.options.modelId,
        voiceId: req.voice.voiceId,
        tier,
      },
    };
  }

  async listVoices(filter?: ListVoicesFilter): Promise<VoiceCatalogEntry[]> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return [];

    let voices: ElevenLabsVoice[];
    try {
      voices = await getVoices(apiKey);
    } catch (err) {
      logger.warn('[tts elevenlabs listVoices err]', {
        detail: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    // ElevenLabs voices don't carry a tier directly — the tier is a
    // property of the model used at synthesis time. Default each voice
    // to Multilingual v2 (the most common pick) and let the UI override
    // when the user picks a non-default model in the settings panel.
    const tier: ElevenLabsVoiceTier = 'multilingual-v2';

    return voices
      .filter((v) => {
        if (!filter?.languageCode) return true;
        const lang = v.fine_tuning?.language ?? '';
        return lang.toLowerCase().startsWith(filter.languageCode.toLowerCase().slice(0, 2));
      })
      .map<VoiceCatalogEntry>((v) => ({
        voice: {
          providerId: PROVIDER_ID,
          voiceId: v.voice_id,
          languageCode: v.fine_tuning?.language ?? 'en-US',
          tier,
        },
        displayName: v.name,
        description: v.description,
        gender: parseGender(v.fine_tuning?.gender),
        previewUrl: v.preview_url,
      }));
  }

  estimateCost(req: Pick<SynthesizeRequest, 'voice' | 'text' | 'ssml'>): number {
    const charCount = (req.ssml ?? req.text).length;
    return synthCostUsd(req.voice.tier, charCount);
  }
}

function parseGender(raw?: string): 'male' | 'female' | 'neutral' | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v.startsWith('m')) return 'male';
  if (v.startsWith('f')) return 'female';
  if (v.startsWith('n')) return 'neutral';
  return undefined;
}

export const elevenLabsSynthesizer: Synthesizer = new ElevenLabsSynthesizer();
