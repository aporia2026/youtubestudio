/**
 * OpenAI Whisper transcription with word-level timestamps.
 *
 * Used by the pronunciation-review pipeline as the unconstrained ASR
 * pass — what the narrator actually said, in their own words, with
 * per-word timing. The downstream diff step (Phase 2) compares this
 * against the script to surface substitutions, omissions, and
 * insertions; the Gemini judge then confirms / rejects each candidate.
 *
 * Why not reuse the existing alignment? The forced-alignment passes in
 * `src/lib/tts/aligners/google-stt.ts` and ElevenLabs Scribe both
 * constrain the recognizer to the script — they're built to PROJECT
 * audio onto known words, not to surface mismatches. For deviation
 * detection we need a recognizer that's free to disagree.
 *
 * Model: `whisper-1`. The newer `gpt-4o-transcribe` and
 * `gpt-4o-mini-transcribe` models DO NOT support `verbose_json` or
 * word-level timestamps as of the openai SDK v6 type declarations — see
 * `node_modules/openai/resources/audio/transcriptions.d.ts:603`. If
 * those constraints change, revisit this choice.
 *
 * Pricing: $0.006/min (whisper-1, verified via OpenAI Speech-to-Text
 * guide search 2026-06-01). The orchestrator computes the actual cost
 * from the audio's `duration_seconds` field rather than re-billing per
 * the Whisper response's `usage.seconds` — the local value is
 * authoritative and avoids an extra fetch.
 */

import type { TranscriptionVerbose, TranscriptionWord } from 'openai/resources/audio/transcriptions';
import { logger } from '../logger';
import type { WhisperTranscriptionCache } from './db';

/** Published pricing for the `whisper-1` model, $/minute. Verified
 *  2026-06-01 against OpenAI's Speech-to-Text documentation. Update
 *  alongside any model swap. */
export const WHISPER_USD_PER_MINUTE = 0.006;

const MODEL_ID = 'whisper-1' as const;

export interface WhisperTranscribeArgs {
  /** Raw audio bytes. Whisper accepts up to 25 MB per request — the
   *  caller is responsible for chunking longer files (out of scope for
   *  v1; we cap supported narrations at ~30 min ≈ 20 MB MP3). */
  audio: Blob;
  /** Suggested filename — Whisper uses the extension to detect the
   *  audio format. Pass `narration.mp3` for MP3, `narration.wav` for
   *  WAV. The orchestrator picks this based on the take's mime type. */
  filename: string;
  /** ISO-639-1 language code (e.g. `en`). Supplying this improves
   *  accuracy and latency per the OpenAI docs. Defaults to undefined
   *  (auto-detect). */
  languageCode?: string;
  /** Optional priming prompt to bias the recognizer toward terms it
   *  would otherwise miss — proper nouns, technical vocabulary. Feed
   *  the first ~200 chars of the canonical script here; it's a soft
   *  hint, not a hard constraint, so it doesn't bias the diff step. */
  primingPrompt?: string;
  /** Audio duration in seconds. Used to compute cost without re-reading
   *  the response. */
  durationSeconds: number;
}

export class WhisperError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'unauthorized'
      | 'payload_too_large'
      | 'rate_limited'
      | 'invalid_request'
      | 'timeout'
      | 'vendor_5xx'
      | 'no_api_key',
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WhisperError';
  }
}

/**
 * Run Whisper against the supplied audio. Returns a cache-shaped
 * payload ready to be persisted into
 * `narrator_takes.pronunciation_review_whisper_json` (see
 * `WhisperTranscriptionCache` in `./db.ts`).
 *
 * Throws `WhisperError` on every failure path so the orchestrator can
 * decide whether to surface a specific message (`payload_too_large` →
 * "Audio file too large for transcription; split the recording") vs.
 * the generic "Whisper failed: <safe detail>".
 */
export async function whisperTranscribeWithWordTimestamps(
  args: WhisperTranscribeArgs,
): Promise<WhisperTranscriptionCache> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new WhisperError(
      'OpenAI API key not configured on the server.',
      'no_api_key',
      false,
    );
  }

  // Dynamic import — keeps the cold-start path of unrelated routes
  // from pulling in the openai SDK. Same pattern as `src/lib/ai.ts`.
  const OpenAIModule = await import('openai');
  const OpenAI = OpenAIModule.default;
  const client = new OpenAI({ apiKey });

  // Whisper-1's `Uploadable` requires a filename so it can detect the
  // audio format. `OpenAI.toFile` wraps the Blob into the SDK's
  // `Uploadable` shape with the right filename and content-type.
  const uploadable = await OpenAI.toFile(args.audio, args.filename);

  logger.info('[pronunciation-review whisper] start', {
    filename: args.filename,
    bytes: args.audio.size,
    durationSeconds: args.durationSeconds,
    languageCode: args.languageCode ?? 'auto',
  });

  const startedAt = Date.now();
  let response: TranscriptionVerbose;
  try {
    // `verbose_json` + `timestamp_granularities: ['word']` is the only
    // combination that surfaces per-word start/end times. The SDK's
    // discriminated union narrows the response shape based on
    // `response_format`, so the cast is safe here.
    const raw = await client.audio.transcriptions.create({
      file: uploadable,
      model: MODEL_ID,
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
      language: args.languageCode,
      prompt: args.primingPrompt,
      // temperature=0 is the documented "deterministic" setting; we
      // want stable output across re-runs (the user can re-trigger the
      // review and expect the same flags).
      temperature: 0,
    });
    response = raw as TranscriptionVerbose;
  } catch (err) {
    throw classifyOpenAIError(err);
  }

  const apiLatencyMs = Date.now() - startedAt;
  const words = normalizeWords(response.words ?? []);
  const costUsd = (args.durationSeconds / 60) * WHISPER_USD_PER_MINUTE;

  logger.info('[pronunciation-review whisper] ok', {
    wordCount: words.length,
    apiLatencyMs,
    durationSeconds: response.duration,
    detectedLanguage: response.language,
    costUsd,
  });

  return {
    text: response.text,
    duration_seconds: response.duration,
    language: response.language,
    words,
    model: MODEL_ID,
    cost_usd: costUsd,
    completed_at: new Date().toISOString(),
  };
}

/**
 * Whisper's `TranscriptionWord` uses `word` for the text field; we
 * normalize to `text` so the JSONB shape matches the existing
 * `AlignedWord` convention used across the rest of the codebase (e.g.
 * `src/lib/tts/types.ts`). The renaming happens here, at the boundary,
 * so downstream code can pretend Whisper used `text` all along.
 */
function normalizeWords(
  words: Array<TranscriptionWord>,
): WhisperTranscriptionCache['words'] {
  return words.map((w) => ({
    text: w.word,
    start_sec: w.start,
    end_sec: w.end,
  }));
}

/**
 * Map an OpenAI SDK error to a typed WhisperError so the orchestrator
 * can choose the right user-facing message. The SDK throws subclasses
 * of `APIError` with `.status` populated; we read that without
 * importing the type so this module doesn't bloat its dependency
 * graph.
 */
function classifyOpenAIError(err: unknown): WhisperError {
  const raw = err instanceof Error ? err.message : String(err);
  const sanitized = raw.replace(/https?:\/\/\S+/g, '<url>').slice(0, 280);
  const status =
    typeof (err as { status?: unknown })?.status === 'number'
      ? ((err as { status: number }).status)
      : undefined;

  if (status === 401 || status === 403) {
    return new WhisperError(
      `Whisper auth failed: ${sanitized}`,
      'unauthorized',
      false,
    );
  }
  if (status === 413) {
    return new WhisperError(
      'Audio file is too large for Whisper transcription (25 MB limit). Split the recording or compress before retrying.',
      'payload_too_large',
      false,
    );
  }
  if (status === 429) {
    return new WhisperError(
      `Whisper rate-limited: ${sanitized}`,
      'rate_limited',
      true,
    );
  }
  if (status === 400 || status === 422) {
    return new WhisperError(
      `Whisper rejected the request: ${sanitized}`,
      'invalid_request',
      false,
    );
  }
  // AbortSignal.timeout fires DOMException name='TimeoutError'.
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new WhisperError(
      'Whisper request timed out.',
      'timeout',
      true,
    );
  }
  return new WhisperError(
    `Whisper failed: ${sanitized}`,
    'vendor_5xx',
    true,
  );
}
