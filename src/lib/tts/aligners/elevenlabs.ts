/**
 * ElevenLabs forced-alignment aligner.
 *
 * Wraps the existing `forceAlign` function in `src/lib/elevenlabs.ts`
 * behind the dispatch-layer `Aligner` contract. The actual side-effecty
 * cache + daily-cap orchestration still lives in
 * `src/lib/voiceover-alignment-cache.ts` — that file is the entry point
 * the routes call. This aligner is the pure provider adapter that the
 * cache layer (and future per-provider dispatchers) call into.
 */

import { forceAlign } from '../../elevenlabs';
import { logger } from '../../logger';
import { alignCostUsd } from '../cost';
import {
  TtsProviderError,
  type Aligner,
  type AlignRequest,
  type AlignResult,
} from '../types';

const ALIGNER_ID = 'elevenlabs' as const;

class ElevenLabsAligner implements Aligner {
  readonly id = ALIGNER_ID;

  isConfigured(): boolean {
    return Boolean(process.env.ELEVENLABS_API_KEY);
  }

  supportsLanguage(): boolean {
    // ElevenLabs forced alignment is language-agnostic — it works
    // against whatever script you supply. Documented at
    // elevenlabs.io/docs/api-reference/forced-alignment.
    return true;
  }

  async align(req: AlignRequest): Promise<AlignResult> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new TtsProviderError(
        'ELEVENLABS_API_KEY is not configured.',
        ALIGNER_ID,
        'unauthorized',
        false,
      );
    }

    logger.info('[tts align elevenlabs] start', {
      audioBytes: req.audio.byteLength,
      chars: req.text.length,
      languageCode: req.languageCode,
    });

    const startedAt = Date.now();
    // Cast through BlobPart: TS's BlobPart union is `BufferSource | Blob | string`
    // and Uint8Array<ArrayBufferLike> is technically a BufferSource, but the
    // recent strict generic narrowing rejects it without the explicit cast.
    const blob = new Blob([req.audio as BlobPart], { type: req.mimeType });

    let result;
    try {
      result = await forceAlign(apiKey, {
        audioBlob: blob,
        audioFilename: 'voiceover.mp3',
        text: req.text,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const sanitized = raw.replace(/https?:\/\/\S+/g, '<url>').slice(0, 240);
      logger.warn('[tts align elevenlabs err]', { detail: sanitized });
      throw new TtsProviderError(
        `ElevenLabs alignment failed: ${sanitized}`,
        ALIGNER_ID,
        'vendor_5xx',
        true,
        sanitized,
      );
    }

    const words = (result.words ?? []).map((w) => ({
      text: w.text,
      startSec: w.start,
      endSec: w.end,
    }));

    const durationSec = words.length > 0 ? words[words.length - 1].endSec : 0;
    const costUsd = alignCostUsd('elevenlabs', durationSec);

    logger.info('[tts align elevenlabs] ok', {
      wordCount: words.length,
      durationSec,
      costUsd,
      apiLatencyMs: Date.now() - startedAt,
    });

    return {
      words,
      durationSec,
      costUsd,
      alignerUsed: ALIGNER_ID,
    };
  }
}

export const elevenLabsAligner: Aligner = new ElevenLabsAligner();
