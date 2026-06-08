/**
 * Voice-profile LLM stage for channel-clone (Plan 1A — 9th stage).
 *
 * Takes a job whose intake produced a `voiceSample` (mono 16 kHz MP3
 * in R2) and asks a multimodal LLM to describe the narrator's voice
 * along structured axes (gender, age, pace, timbre, accent, energy,
 * emotional register, signature delivery moves) PLUS a paste-ready
 * ElevenLabs Voice Design prompt.
 *
 * The result lands on `state_jsonb.voiceProfile`. This stage is
 * best-effort: on any failure (no sample, model error, parse error)
 * it logs and bails — the rest of the channel-clone pipeline runs
 * unchanged. See
 * `_plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md`.
 *
 * IMPORTANT — audio input wire format:
 *   The repo's central `generateText` helper in `src/lib/ai.ts` does
 *   NOT yet support audio content parts (image yes, audio no). This
 *   runner therefore hand-rolls a direct HTTP call to Kie.ai's
 *   Google-native `:generateContent` endpoint, which IS documented
 *   to accept audio via `inline_data` with a `mime_type` like
 *   `audio/mpeg`.
 *
 *   Plan 1B verification spike (2026-06-07) confirmed that
 *   `kie-gemini-3-5-flash` works in two shapes (see the spike script
 *   at `scripts/diag-kie-3-5-flash-audio.ts`):
 *     A) Google-native `:generateContent` with `inline_data` — what
 *        this runner uses.
 *     B) Kie's OpenAI-compatible alias accepting `image_url` data URI
 *        carrying the audio mime — undocumented but works, and would
 *        let us route through `ai.ts` once it learns the
 *        image_url-as-audio smuggle.
 *   The third shape (OpenAI `input_audio` content part) returns 200
 *   but the bytes are silently dropped, so we avoid it.
 */

import { logger } from '@/lib/logger';
import { getDownloadUrlForBucket, getReviewBucket } from '@/lib/r2';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { KIE_MODEL_MAP } from '@/lib/ai-models';
import {
  getChannelCloneJob,
  mergeChannelCloneJobState,
} from './job-store';
import { makeJobLogger, type JobLogger } from './job-logger';
import { extractJsonObjectFromModelResponse } from './parse-llm-json';
import type { ChannelCloneJobState } from './types';

const KIE_BASE = 'https://api.kie.ai';

const VOICE_PROFILE_OUTPUT_SCHEMA_INSTRUCTION = `Respond with a single JSON object matching this TypeScript shape exactly:
{
  "gender": "male" | "female" | "androgynous",
  "ageBracket": "young-adult" | "adult" | "middle-aged" | "senior",
  "pace": "slow" | "moderate" | "fast" | "variable",
  "timbre": string,                  // 2-6 words, e.g. "warm baritone", "bright tenor", "raspy alto"
  "accent": string,                  // 2-6 words, e.g. "general american", "rp british", "australian"
  "energy": "low" | "measured" | "high",
  "emotionalRegister": string,       // 1 short sentence, e.g. "wry, knowing, slightly detached"
  "signatureMoves": string[],        // 2-5 short phrases describing delivery patterns (pauses, terminals, emphasis tics)
  "voiceDesignPrompt": string        // 1-3 sentences, paste-ready for ElevenLabs Voice Design — describes the voice such that a generative TTS system could match it without hearing the original
}

Listen to the attached audio (a 30-second narration sample) and fill in every field. Be specific and concrete. Avoid generic adjectives like "professional" or "engaging" — name the actual quality you hear.

Output ONLY the JSON object. No prose before or after. No markdown code fences. The first character of your response MUST be \`{\` and the last must be \`}\`.`;

const VOICE_PROFILE_USER_PROMPT = [
  'You are a voice-casting director who can describe a narrator\'s voice in precise, technical terms.',
  '',
  'Listen to the attached 30-second audio sample of a YouTube narrator and produce a structured voice description plus a paste-ready ElevenLabs Voice Design prompt that another system could use to synthesise a matching voice.',
  '',
  'Be specific. "Warm" is fine; "warm baritone with a slight nasal resonance and a wry terminal lift" is better. The voiceDesignPrompt should read like a Voice Design brief, not a marketing blurb.',
].join('\n');

export interface RunVoiceProfileOptions {
  jobId: string;
  workspaceId: string;
  /** Per-invocation model override. When set, the runner uses this
   *  model id instead of the workspace's configured default for
   *  `channel-clone-voice-profile`. Surfaced via the stuck-analyzing
   *  retry picker so operators can route around a Kie outage by
   *  switching to a different Kie Gemini variant. 2026-06-08. */
  modelOverride?: string;
}

/** Ordered fallback chain of audio-capable models. When one model
 *  fails (Kie 500, parse error, network), the runner walks down this
 *  list before giving up. Order: try the operator-picked / configured
 *  model FIRST, then 3.5 Flash (fast + cheap + good), then 2.5 Flash
 *  (older but stable), then 3 Pro (slower but smart), then 2.5 Pro,
 *  then 3 Flash, then 3.1 Pro. All Kie Gemini variants — those are
 *  the only audio-capable models on our current Kie wiring. */
const VOICE_PROFILE_FALLBACK_MODELS: readonly string[] = [
  'kie-gemini-3-5-flash',
  'kie-gemini-2.5-flash',
  'kie-gemini-3-pro',
  'kie-gemini-2.5-pro',
  'kie-gemini-3-flash',
  'kie-gemini-3.1-pro',
];

/** Build the ordered list of model ids to try for ONE invocation of
 *  runVoiceProfile. Operator-picked / configured model goes first,
 *  then the fallback chain (deduped). Exported for unit tests. */
export function buildVoiceProfileModelChain(primary: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!seen.has(id) && KIE_MODEL_MAP[id]) {
      chain.push(id);
      seen.add(id);
    }
  };
  push(primary);
  for (const fallback of VOICE_PROFILE_FALLBACK_MODELS) {
    push(fallback);
  }
  return chain;
}

/** Run the voice-profile stage. Walks an ordered fallback chain of
 *  Kie Gemini models so a transient Kie 500 (or parse failure on one
 *  model) doesn't strand the operator. Never throws — failure paths
 *  log and return without touching the job's status. */
export async function runVoiceProfile(opts: RunVoiceProfileOptions): Promise<void> {
  const { jobId, workspaceId } = opts;
  const log: JobLogger = makeJobLogger(jobId, workspaceId, 'voice-profile');
  log.info('voice-profile', 'start');

  const job = await getChannelCloneJob(jobId, workspaceId);
  if (!job) {
    log.error('voice-profile', 'job missing — aborting');
    return;
  }
  const state = job.state_jsonb as ChannelCloneJobState;
  if (!state.voiceSample) {
    log.warn('voice-profile', 'no voiceSample on job — extraction must have failed; skipping');
    return;
  }

  const configured = opts.modelOverride
    ?? await getEffectiveModelId(workspaceId, 'channel-clone-voice-profile');
  const chain = buildVoiceProfileModelChain(configured);
  log.info('voice-profile', 'model chain', { primary: configured, chain });

  // Pull the audio bytes back from R2 → memory → base64 ONCE. Every
  // model in the chain sees the same buffer.
  let audioBase64: string;
  try {
    const downloadUrl = await getDownloadUrlForBucket(getReviewBucket(), state.voiceSample.r2Key);
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`R2 GET returned ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    audioBase64 = Buffer.from(arrayBuf).toString('base64');
  } catch (err) {
    log.error('voice-profile', 'failed reading voice sample from R2', {
      r2Key: state.voiceSample.r2Key, error: errorMessage(err),
    });
    return;
  }

  const attemptErrors: { modelId: string; reason: string }[] = [];
  for (const modelId of chain) {
    const kieConfig = KIE_MODEL_MAP[modelId];
    if (!kieConfig) {
      attemptErrors.push({ modelId, reason: 'no KIE_MODEL_MAP entry' });
      continue;
    }
    const nativeModelId = kieConfig.kieModelId.replace(/-openai$/, '');
    log.info('voice-profile', 'model-call', { modelId, nativeModelId, audioBase64Bytes: audioBase64.length });

    let raw: string;
    try {
      raw = await callKieGeminiAudio(nativeModelId, audioBase64);
    } catch (err) {
      const reason = errorMessage(err);
      attemptErrors.push({ modelId, reason: `call failed: ${reason}` });
      log.warn('voice-profile', 'model call failed; trying next in chain', { modelId, reason });
      continue;
    }

    let parsed: ChannelCloneJobState['voiceProfile'];
    try {
      parsed = parseVoiceProfileResponse(raw, modelId);
    } catch (err) {
      const reason = errorMessage(err);
      attemptErrors.push({ modelId, reason: `parse failed: ${reason}` });
      log.warn('voice-profile', 'parse failed; trying next in chain', {
        modelId, rawPreview: raw.slice(0, 200), reason,
      });
      continue;
    }

    try {
      await mergeChannelCloneJobState(jobId, workspaceId, { voiceProfile: parsed });
    } catch (err) {
      log.error('voice-profile', 'persist failed — aborting (data integrity beats fallback here)', {
        error: errorMessage(err),
      });
      return;
    }

    log.info('voice-profile', 'persisted', {
      modelId, gender: parsed?.gender, age: parsed?.ageBracket, pace: parsed?.pace,
      attemptsBeforeSuccess: attemptErrors.length,
      attemptErrors: attemptErrors.length > 0 ? attemptErrors : undefined,
    });
    logger.info('[channel-clone voice-profile] done', { jobId, modelId, attemptsBeforeSuccess: attemptErrors.length });
    return;
  }

  // Every model in the chain failed. Surface a summary in the log so
  // the operator can see WHY rather than just "still analyzing…".
  log.error('voice-profile', 'every model in the fallback chain failed', {
    chainLength: chain.length, attemptErrors,
  });
  logger.error('[channel-clone voice-profile] chain exhausted', { jobId, attemptErrors });
}

/** Direct call to Kie.ai's Google-native generateContent endpoint
 *  with audio inline_data. Bypasses the OpenAI-compatible alias the
 *  rest of the app uses for Gemini. Returns the model's raw text
 *  response (expected to be a single JSON object — schema enforced
 *  by the prompt).
 *
 *  Diagnostic contract: every failure mode (HTTP non-2xx, empty body,
 *  non-JSON body, missing candidates, MAX_TOKENS finish reason)
 *  surfaces enough detail in the thrown error for the runner's log
 *  line to be actionable without re-running. 2026-06-08 — the user
 *  hit a full-chain failure ("every model in the fallback chain
 *  failed" with reasons "Unexpected end of JSON input") and there
 *  was no way to tell whether Kie returned empty bodies, error
 *  payloads, or truncated output. */
async function callKieGeminiAudio(nativeModelId: string, audioBase64: string): Promise<string> {
  const key = process.env.KIE_API_KEY;
  if (!key) {
    throw new Error('KIE_API_KEY environment variable is not configured.');
  }
  const url = `${KIE_BASE}/gemini/v1/models/${nativeModelId}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: VOICE_PROFILE_OUTPUT_SCHEMA_INSTRUCTION }] },
    contents: [
      {
        role: 'user',
        parts: [
          { text: VOICE_PROFILE_USER_PROMPT },
          { inline_data: { mime_type: 'audio/mpeg', data: audioBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      // Bumped from 1024 → 4096 on 2026-06-08 after a 3-5-flash run
      // returned truncated JSON ("unbalanced braces"). The voice-
      // profile schema sums to ~400 output tokens in practice; 4096
      // is comfortable headroom that still bounds the model and keeps
      // cost predictable.
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  // Read as text first so we can surface the body on parse failure.
  // res.json() throws "Unexpected end of JSON input" on empty bodies
  // with no way to tell from the error message what came back.
  const rawText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 500)}`);
  }
  if (!rawText.trim()) {
    throw new Error('Kie returned empty response body (200 OK but no content)');
  }
  let data: KieGenerateContentResponse;
  try {
    data = JSON.parse(rawText) as KieGenerateContentResponse;
  } catch {
    throw new Error(`Kie returned non-JSON body: ${rawText.slice(0, 500)}`);
  }
  // Capture finishReason (MAX_TOKENS, SAFETY, RECITATION, STOP) on the
  // thrown error when no text comes back so the operator can tell the
  // difference between "model refused" and "we asked for too few
  // tokens" and "API misconfigured".
  const finishReason = data.candidates?.[0]?.finishReason ?? null;
  const text = extractTextFromGeminiResponse(data);
  if (!text) {
    const promptFeedback = data.promptFeedback ? ` promptFeedback=${JSON.stringify(data.promptFeedback)}` : '';
    throw new Error(
      `Kie returned no text content (finishReason=${finishReason ?? 'absent'}${promptFeedback}; body preview: ${rawText.slice(0, 300)})`,
    );
  }
  // If the model HIT max tokens we'd rather know than silently accept
  // a truncated response that the brace-matching parser will choke on.
  // Throw so the chain falls through; the next model gets a fresh
  // shot with the same budget.
  if (finishReason === 'MAX_TOKENS') {
    throw new Error(
      `Kie hit MAX_TOKENS on ${nativeModelId} (output likely truncated; consider bumping maxOutputTokens further or shortening the schema instruction)`,
    );
  }
  return text;
}

interface KieGenerateContentResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
    finishReason?: string;
  }[];
  /** Gemini surfaces input-side issues (blocked prompt / safety) here
   *  rather than in candidates. Logging it on the failure path tells
   *  us whether the AUDIO was rejected vs the OUTPUT was empty. */
  promptFeedback?: unknown;
}

/** Pull the first text part from a Gemini generateContent response.
 *  Exported for unit tests so we can verify parser robustness without
 *  spinning up a real Kie call. */
export function extractTextFromGeminiResponse(data: KieGenerateContentResponse): string {
  if (!data.candidates || data.candidates.length === 0) return '';
  for (const c of data.candidates) {
    const parts = c.content?.parts ?? [];
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text.length > 0) return p.text;
    }
  }
  return '';
}

/** Parse the model's raw JSON response into a strongly-typed
 *  voiceProfile. Throws when required fields are missing or carry
 *  invalid enum values. Exported for unit tests in
 *  `tests/voice-profile-runner.test.ts`. */
export function parseVoiceProfileResponse(
  raw: string,
  modelId: string,
): NonNullable<ChannelCloneJobState['voiceProfile']> {
  const obj = extractJsonObjectFromModelResponse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('response was not a JSON object');
  const o = obj as Record<string, unknown>;

  const gender = enumField(o.gender, 'gender', ['male', 'female', 'androgynous'] as const);
  const ageBracket = enumField(o.ageBracket, 'ageBracket', ['young-adult', 'adult', 'middle-aged', 'senior'] as const);
  const pace = enumField(o.pace, 'pace', ['slow', 'moderate', 'fast', 'variable'] as const);
  const energy = enumField(o.energy, 'energy', ['low', 'measured', 'high'] as const);
  const timbre = stringField(o.timbre, 'timbre');
  const accent = stringField(o.accent, 'accent');
  const emotionalRegister = stringField(o.emotionalRegister, 'emotionalRegister');
  const voiceDesignPrompt = stringField(o.voiceDesignPrompt, 'voiceDesignPrompt');
  const signatureMoves = stringArrayField(o.signatureMoves, 'signatureMoves');

  return {
    gender, ageBracket, pace, timbre, accent, energy,
    emotionalRegister, signatureMoves, voiceDesignPrompt,
    modelUsed: modelId,
    analyzedAt: new Date().toISOString(),
  };
}

function enumField<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string') throw new Error(`${field} must be a string, got ${typeof value}`);
  if (!allowed.includes(value as T[number])) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}; got "${value}"`);
  }
  return value as T[number];
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stringArrayField(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v.trim().length > 0) out.push(v.trim());
  }
  if (out.length === 0) throw new Error(`${field} must contain at least one non-empty string`);
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
