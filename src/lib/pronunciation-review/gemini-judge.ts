/**
 * Gemini 2.5 Flash audio judge for pronunciation-review candidates.
 *
 * For each candidate produced by `./candidates.ts`, we send Gemini a
 * short WAV slice + the surrounding script context and ask: "did the
 * narrator say this correctly?" The model returns a structured verdict
 * (is_real_issue, confidence, category, explanation, suggested_comment)
 * via Gemini's `responseSchema` JSON-output mode.
 *
 * Bias: false-negatives over false-positives. The prompt explicitly
 * tells the model to default `is_real_issue=false` when uncertain. The
 * orchestrator further filters by confidence >= 0.75. This two-layer
 * defense keeps the flag list tight even when Whisper mis-recognizes
 * a word or the narrator merely paused.
 *
 * Cost (verified 2026-06-01):
 *   - audio input: $1.00 / M tokens
 *   - text input:  $0.30 / M tokens
 *   - output:      $2.50 / M tokens
 *   Estimated per-call cost: ~$0.0004 (75 audio + ~200 text in, ~80
 *   out). Negligible relative to Whisper.
 *
 * Concurrency: the orchestrator dispatches up to 5 judge calls in
 * parallel. Each call typically returns in 1-3 s, so a 60-candidate
 * batch finishes in ~30 s — well under Vercel's 800 s ceiling.
 */

import { SchemaType, type ResponseSchema } from '@google/generative-ai';
import { logger } from '../logger';
import type { Candidate, CandidateKind } from './candidates';

/** Gemini's published audio tokens-per-second. Used to estimate input
 *  cost when usageMetadata isn't returned (older response shapes). */
const AUDIO_TOKENS_PER_SECOND = 25;
/** Verified 2026-06-01 against Gemini Developer API pricing. */
const GEMINI_FLASH_AUDIO_INPUT_USD_PER_M = 1.0;
const GEMINI_FLASH_TEXT_INPUT_USD_PER_M = 0.3;
const GEMINI_FLASH_OUTPUT_USD_PER_M = 2.5;

const MODEL_ID = 'gemini-2.5-flash' as const;

/** Per-call timeout. Gemini Flash audio judgments typically return in
 *  1–3 s; 25 s is a safety net for tail latency. */
const GEMINI_TIMEOUT_MS = 25_000;

export type JudgeVerdictCategory =
  | 'script_deviation'
  | 'mispronunciation'
  | 'omission'
  | 'insertion'
  | 'ok';

export interface JudgeVerdict {
  is_real_issue: boolean;
  confidence: number;
  category: JudgeVerdictCategory;
  explanation: string;
  suggested_comment: string;
}

export interface JudgeArgs {
  /** WAV-encoded audio slice covering the candidate's window. Produced
   *  by `./audio-slice.ts`. */
  audioWav: Buffer;
  /** ~1 sentence of script context around the candidate. Helps the
   *  judge reason about whether "WPA" should be pronounced as letters
   *  vs. as a word, etc. */
  scriptContext: string;
  /** The candidate itself — the prompt uses `kind`, `scriptWord`,
   *  `whisperWord` to frame the question. */
  candidate: Candidate;
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  /** Wall-clock cost we attribute to this judgment (USD). Used by the
   *  orchestrator to roll up the per-take cost. */
  costUsd: number;
  /** Raw token counts from Gemini's usageMetadata (when present),
   *  for observability. */
  tokens: {
    prompt: number;
    output: number;
  };
}

export class GeminiJudgeError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'no_api_key'
      | 'unauthorized'
      | 'rate_limited'
      | 'invalid_request'
      | 'timeout'
      | 'vendor_5xx'
      | 'malformed_response',
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeminiJudgeError';
  }
}

/** Response schema fed to Gemini's structured-output mode. Cast at
 *  build time so SchemaType's enum compares cleanly with the
 *  discriminated union. */
const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    is_real_issue: {
      type: SchemaType.BOOLEAN,
      description:
        'True only if you are confident the narrator made a real mistake. Default to false on uncertainty.',
    },
    confidence: {
      type: SchemaType.NUMBER,
      description: 'Your confidence that is_real_issue is correct, 0.0 to 1.0.',
    },
    category: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['script_deviation', 'mispronunciation', 'omission', 'insertion', 'ok'],
      description:
        'script_deviation = wrong word; mispronunciation = right word, wrong pronunciation; omission = word skipped; insertion = extra word added; ok = no issue.',
    },
    explanation: {
      type: SchemaType.STRING,
      description: 'One short sentence describing what you heard vs. what the script says.',
    },
    suggested_comment: {
      type: SchemaType.STRING,
      description:
        'A polite, specific comment to send to the narrator describing what to fix. Empty string when category=ok.',
    },
  },
  required: ['is_real_issue', 'confidence', 'category', 'explanation', 'suggested_comment'],
};

/**
 * Run one judgment against Gemini. Returns the structured verdict +
 * the cost attributed to this call. Throws `GeminiJudgeError` on
 * failure so the orchestrator can decide whether to drop the candidate
 * or fail the run.
 *
 * Stateless — safe to call N times in parallel from the same
 * orchestrator instance.
 */
export async function judgeCandidate(args: JudgeArgs): Promise<JudgeResult> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new GeminiJudgeError(
      'GOOGLE_AI_API_KEY not configured on the server.',
      'no_api_key',
      false,
    );
  }

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: {
      // temperature=0 + structured output gives stable, reproducible
      // verdicts across re-runs.
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const prompt = buildPrompt(args);
  const audioBase64 = args.audioWav.toString('base64');

  let rawText: string;
  let promptTokens = 0;
  let outputTokens = 0;
  try {
    const result = await Promise.race([
      model.generateContent([
        prompt,
        { inlineData: { mimeType: 'audio/wav', data: audioBase64 } },
      ]),
      timeoutPromise(GEMINI_TIMEOUT_MS),
    ]);
    rawText = result.response.text();
    const usage = (result.response as unknown as {
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    }).usageMetadata;
    promptTokens = usage?.promptTokenCount ?? 0;
    outputTokens = usage?.candidatesTokenCount ?? 0;
  } catch (err) {
    throw classifyGeminiError(err);
  }

  let verdict: JudgeVerdict;
  try {
    verdict = parseAndValidateVerdict(rawText);
  } catch (err) {
    throw new GeminiJudgeError(
      `Gemini returned malformed structured output: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'malformed_response',
      false,
    );
  }

  // ── Cost attribution ───────────────────────────────────────────────
  // Estimated audio tokens from clip duration — usageMetadata gives a
  // single promptTokenCount that bundles audio + text. We subtract our
  // estimated audio portion from the prompt total to get the text
  // portion, then bill each at the matching rate. Off by ±20% in
  // practice — the absolute numbers are tiny enough that doesn't
  // matter for the budget cap.
  const sliceDurationSec = estimateSliceDurationSec(args);
  const estimatedAudioTokens = Math.round(sliceDurationSec * AUDIO_TOKENS_PER_SECOND);
  const estimatedTextTokens = Math.max(0, promptTokens - estimatedAudioTokens);
  const costUsd =
    (estimatedAudioTokens * GEMINI_FLASH_AUDIO_INPUT_USD_PER_M) / 1_000_000 +
    (estimatedTextTokens * GEMINI_FLASH_TEXT_INPUT_USD_PER_M) / 1_000_000 +
    (outputTokens * GEMINI_FLASH_OUTPUT_USD_PER_M) / 1_000_000;

  logger.info('[pronunciation-review judge] ok', {
    kind: args.candidate.kind,
    scriptWord: args.candidate.scriptWord,
    whisperWord: args.candidate.whisperWord,
    verdict: verdict.category,
    confidence: verdict.confidence,
    promptTokens,
    outputTokens,
    costUsd,
  });

  return {
    verdict,
    costUsd,
    tokens: { prompt: promptTokens, output: outputTokens },
  };
}

/**
 * Compose the per-candidate prompt. Includes:
 *   - role framing (audio-review expert)
 *   - the script context (so the model knows what was supposed to be said)
 *   - the specific candidate (script word, what Whisper heard, kind hint)
 *   - the false-positive bias directive
 *
 * Keep this short. Gemini's audio context is the load-bearing input;
 * the text portion is just framing.
 */
function buildPrompt(args: JudgeArgs): string {
  const { candidate, scriptContext } = args;
  const kindHint = describeKind(candidate.kind);

  // Two columns of evidence: what the script said, and what Whisper
  // transcribed. Either may be empty (omission has no whisper word,
  // insertion has no script word).
  const scriptLine = candidate.scriptWord ? `"${candidate.scriptWord}"` : '(nothing)';
  const whisperLine = candidate.whisperWord ? `"${candidate.whisperWord}"` : '(nothing)';

  return [
    'You are reviewing a single moment from a YouTube narration.',
    'You will hear a short audio clip. The narrator was supposed to read from a script.',
    '',
    'Script context (the sentence the narrator was reading):',
    `  ${scriptContext}`,
    '',
    `What the script says at this moment: ${scriptLine}`,
    `What an unconstrained transcriber heard: ${whisperLine}`,
    `Hint about why this moment was flagged: ${kindHint}`,
    '',
    'Listen to the audio and answer:',
    '  • Did the narrator make a real mistake at this exact moment?',
    '  • If yes, what kind (wrong word, mispronunciation, skipped, extra word)?',
    '  • One short sentence describing what you heard vs. what was scripted.',
    '  • A polite, specific comment to send to the narrator (rewriteable later).',
    '',
    'IMPORTANT: bias toward is_real_issue=false when uncertain. The reviewer',
    'will see every flag and trusts you to only surface confident issues. A',
    'narrator who pauses, breathes, or says a word slightly differently is',
    'NOT a real issue. A narrator who said a clearly different word IS.',
    'For acronyms like "WPA", expect letter-by-letter reading unless context',
    'says otherwise. For proper nouns in other languages, accept reasonable',
    'pronunciation variants.',
  ].join('\n');
}

function describeKind(kind: CandidateKind): string {
  switch (kind) {
    case 'substitution':
      return 'Whisper transcribed a different word than the script — possible script deviation.';
    case 'omission':
      return 'Whisper found no word here — possible skipped word.';
    case 'insertion':
      return 'Whisper transcribed an extra word — possible filler or added phrase.';
    case 'tricky_word':
      return 'This word is a proper noun, acronym, or technical term — check the pronunciation.';
  }
}

function estimateSliceDurationSec(args: JudgeArgs): number {
  const range = args.candidate.endSec - args.candidate.startSec;
  // SLICE_PADDING_SEC = 0.3 on each side. Floor at 0.5s for very
  // short candidates.
  return Math.max(0.5, range + 0.6);
}

function parseAndValidateVerdict(rawText: string): JudgeVerdict {
  // Gemini occasionally wraps JSON in markdown fences despite the
  // structured-output mode. Strip them defensively.
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('expected object at top level');
  }
  const obj = parsed as Record<string, unknown>;

  const is_real_issue = obj.is_real_issue;
  if (typeof is_real_issue !== 'boolean') {
    throw new Error('is_real_issue must be a boolean');
  }
  const confidence = obj.confidence;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be a number in [0, 1]');
  }
  const category = obj.category;
  if (
    category !== 'script_deviation' &&
    category !== 'mispronunciation' &&
    category !== 'omission' &&
    category !== 'insertion' &&
    category !== 'ok'
  ) {
    throw new Error('category must be one of the enum values');
  }
  const explanation = obj.explanation;
  if (typeof explanation !== 'string') {
    throw new Error('explanation must be a string');
  }
  const suggested_comment = obj.suggested_comment;
  if (typeof suggested_comment !== 'string') {
    throw new Error('suggested_comment must be a string');
  }

  return {
    is_real_issue,
    confidence,
    category,
    explanation,
    suggested_comment,
  };
}

function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new GeminiJudgeError(`Gemini timed out after ${ms}ms.`, 'timeout', true)), ms);
  });
}

function classifyGeminiError(err: unknown): GeminiJudgeError {
  if (err instanceof GeminiJudgeError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const sanitized = raw.replace(/https?:\/\/\S+/g, '<url>').slice(0, 280);
  const lower = sanitized.toLowerCase();

  if (lower.includes('401') || lower.includes('403') || lower.includes('permission')) {
    return new GeminiJudgeError(`Gemini auth failed: ${sanitized}`, 'unauthorized', false);
  }
  if (lower.includes('429') || lower.includes('rate') || lower.includes('quota')) {
    return new GeminiJudgeError(`Gemini rate-limited: ${sanitized}`, 'rate_limited', true);
  }
  if (lower.includes('400') || lower.includes('invalid')) {
    return new GeminiJudgeError(`Gemini rejected the request: ${sanitized}`, 'invalid_request', false);
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new GeminiJudgeError(`Gemini timed out: ${sanitized}`, 'timeout', true);
  }
  return new GeminiJudgeError(`Gemini failed: ${sanitized}`, 'vendor_5xx', true);
}
