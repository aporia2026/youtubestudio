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
import { getModelById, KIE_MODEL_MAP } from '@/lib/ai-models';
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
}

/** Run the voice-profile stage. Never throws — failure paths log
 *  and return without touching the job's status. */
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

  const modelId = await getEffectiveModelId(workspaceId, 'channel-clone-voice-profile');
  const model = getModelById(modelId);
  if (!model) {
    log.error('voice-profile', 'configured model id is not in the registry', { modelId });
    return;
  }
  // Today we only have a working audio wire format for Kie Gemini
  // (via Kie's Google-native `:generateContent` endpoint). Anything
  // else routes through a path that doesn't accept audio yet.
  if (model.provider !== 'kie' || !modelId.startsWith('kie-gemini')) {
    log.warn('voice-profile', 'configured model does not support audio in our current router; skipping', {
      modelId, provider: model.provider,
    });
    return;
  }
  const kieConfig = KIE_MODEL_MAP[modelId];
  if (!kieConfig) {
    log.error('voice-profile', 'no KIE_MODEL_MAP entry for configured model', { modelId });
    return;
  }
  // The kieModelId in KIE_MODEL_MAP for Gemini is typically the
  // OpenAI-compatible alias (e.g. `gemini-3-5-flash-openai`). For
  // the native :generateContent endpoint we strip that suffix —
  // Google's API doesn't recognise it.
  const nativeModelId = kieConfig.kieModelId.replace(/-openai$/, '');

  // Pull the audio bytes back from R2 → memory → base64 for the call.
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

  log.info('voice-profile', 'model-call', { modelId, nativeModelId, audioBase64Bytes: audioBase64.length });

  let raw: string;
  try {
    raw = await callKieGeminiAudio(nativeModelId, audioBase64);
  } catch (err) {
    log.error('voice-profile', 'model call failed', { error: errorMessage(err) });
    return;
  }

  let parsed: ChannelCloneJobState['voiceProfile'];
  try {
    parsed = parseVoiceProfileResponse(raw, modelId);
  } catch (err) {
    log.error('voice-profile', 'parse failed', {
      modelId, rawPreview: raw.slice(0, 400), error: errorMessage(err),
    });
    return;
  }

  try {
    await mergeChannelCloneJobState(jobId, workspaceId, { voiceProfile: parsed });
  } catch (err) {
    log.error('voice-profile', 'persist failed', { error: errorMessage(err) });
    return;
  }

  log.info('voice-profile', 'persisted', {
    modelId, gender: parsed?.gender, age: parsed?.ageBracket, pace: parsed?.pace,
  });
  logger.info('[channel-clone voice-profile] done', { jobId, modelId });
}

/** Direct call to Kie.ai's Google-native generateContent endpoint
 *  with audio inline_data. Bypasses the OpenAI-compatible alias the
 *  rest of the app uses for Gemini. Returns the model's raw text
 *  response (expected to be a single JSON object — schema enforced
 *  by the prompt). */
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
      maxOutputTokens: 1024,
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
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kie generateContent returned ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as KieGenerateContentResponse;
  const text = extractTextFromGeminiResponse(data);
  if (!text) {
    throw new Error('Kie generateContent returned no text content');
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
