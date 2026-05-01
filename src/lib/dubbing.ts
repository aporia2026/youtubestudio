/**
 * Auto-dubbing pipeline. Translates a script into a target language and
 * generates a voiceover with ElevenLabs `eleven_multilingual_v2`, then
 * persists the audio to Vercel Blob and the metadata to `dubbed_voiceovers`.
 *
 * Pipeline (per language):
 *   1. UPSERT row with status = 'translating'
 *   2. Translate the script via the workspace's preferred LLM
 *   3. UPDATE row with translated_script + status = 'generating'
 *   4. Generate audio via ElevenLabs multilingual_v2 with the chosen voice
 *   5. Upload audio to Vercel Blob → public URL
 *   6. UPDATE row with audio_url + duration_seconds + status = 'ready'
 *   On error at any step: UPDATE status = 'failed' + error_message.
 *
 * Single-language API by design — multi-language requests fan out client-side
 * so the 60s Vercel hobby function-budget covers one language comfortably
 * (~25s typical: 1-3s translate + 15-20s TTS + 2s upload).
 */
import { sql } from '@vercel/postgres';
import { put } from '@vercel/blob';
import { generateText } from './ai';
import { generateVoiceover } from './elevenlabs';
import { logger } from './logger';
import {
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
  type SupportedLanguage,
} from './dubbing-languages';

// Re-export the client-safe constants for server-side callers that already
// import everything from `@/lib/dubbing`. Client components should import
// from `@/lib/dubbing-languages` directly to avoid pulling in the
// orchestrator (which depends on next/headers via ai.ts).
export { SUPPORTED_LANGUAGES, isSupportedLanguage };
export type { SupportedLanguage };

const ELEVENLABS_MULTILINGUAL_MODEL = 'eleven_multilingual_v2';

/** Default translation model — Claude Haiku 4.5 is fast + cheap and handles
 *  the 8 target languages well. Override per-call by passing translationModelId. */
const DEFAULT_TRANSLATION_MODEL = 'claude-haiku-4-5-20251001';

export type DubStatus = 'translating' | 'generating' | 'ready' | 'failed';

export interface DubRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  script_id: string;
  source_language: string;
  target_language: string;
  translated_script: string | null;
  voice_id: string;
  audio_url: string | null;
  blob_pathname: string | null;
  duration_seconds: number | null;
  char_count: number | null;
  status: DubStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Build the system + user prompt for the translation step. Pure — exported
 *  for tests so we can assert the language label, the markup-preservation
 *  rules, and the no-quote-wrapping rule are all present. */
export function buildTranslationPrompt(
  sourceText: string,
  targetCode: SupportedLanguage,
): { system: string; user: string } {
  const label = SUPPORTED_LANGUAGES.find((l) => l.code === targetCode)?.label || targetCode;
  return {
    system: `You are a senior YouTube script translator. You translate from English into ${label} for delivery as a voiceover.

Rules — apply every line:
- Translate naturally for SPOKEN delivery. The translation must sound like a confident native speaker talking on camera, not like written prose.
- Preserve the source's energy, pacing, and rhythm. Short punchy English sentences stay short and punchy in ${label}.
- Match the source's register: casual stays casual, technical stays technical.
- DO NOT translate brand names, channel handles, product names, or proper nouns of people/places that are recognised in the original (e.g. "YouTube", "ChatGPT", "Bitcoin" stay as-is).
- Preserve markup VERBATIM: [VISUAL CUE: ...] stays [VISUAL CUE: ...] (only the inner description is translated). [PAUSE] stays [PAUSE]. **bold** stays **bold**. ## Section headers stay ##, with the header text translated.
- DO NOT add explanatory notes, translator's footnotes, or any text outside the translation itself.
- DO NOT wrap the response in quotes or markdown fences. Output ONLY the translated script body.

The translation will be fed directly into a TTS engine. Anything you add that isn't speakable will be read aloud verbatim — keep the output clean.`,
    user: sourceText,
  };
}

/** Estimate audio duration from char count. Rough: ElevenLabs averages
 *  ~13 chars per second for English-like cadence on multilingual_v2. We use
 *  this only as a fallback when actual duration isn't available; the real
 *  number comes from the audio file's metadata when we eventually parse
 *  it. */
export function estimateDubDuration(charCount: number): number {
  return Math.max(1, Math.round(charCount / 13));
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

interface UpsertArgs {
  workspaceId: string;
  projectId: string | null;
  scriptId: string;
  targetLanguage: SupportedLanguage;
  voiceId: string;
}

async function upsertDubRow(args: UpsertArgs): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO dubbed_voiceovers (
      workspace_id, project_id, script_id,
      source_language, target_language,
      voice_id, status
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.projectId}::uuid,
      ${args.scriptId}::uuid,
      'en',
      ${args.targetLanguage},
      ${args.voiceId},
      'translating'
    )
    ON CONFLICT (script_id, target_language) DO UPDATE SET
      voice_id = EXCLUDED.voice_id,
      status = 'translating',
      translated_script = NULL,
      audio_url = NULL,
      blob_pathname = NULL,
      duration_seconds = NULL,
      char_count = NULL,
      error_message = NULL,
      updated_at = NOW(),
      completed_at = NULL
    RETURNING id
  `;
  return rows[0]!.id;
}

async function markFailed(dubId: string, message: string): Promise<void> {
  await sql`
    UPDATE dubbed_voiceovers
       SET status = 'failed',
           error_message = ${message},
           updated_at = NOW()
     WHERE id = ${dubId}::uuid
  `;
}

async function markGenerating(dubId: string, translated: string): Promise<void> {
  await sql`
    UPDATE dubbed_voiceovers
       SET status = 'generating',
           translated_script = ${translated},
           char_count = ${translated.length},
           updated_at = NOW()
     WHERE id = ${dubId}::uuid
  `;
}

async function markReady(
  dubId: string,
  audioUrl: string,
  blobPathname: string,
  durationSeconds: number,
): Promise<void> {
  await sql`
    UPDATE dubbed_voiceovers
       SET status = 'ready',
           audio_url = ${audioUrl},
           blob_pathname = ${blobPathname},
           duration_seconds = ${durationSeconds},
           updated_at = NOW(),
           completed_at = NOW()
     WHERE id = ${dubId}::uuid
  `;
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

export interface DubScriptArgs {
  workspaceId: string;
  projectId: string | null;
  scriptId: string;
  sourceText: string;
  targetLanguage: SupportedLanguage;
  voiceId: string;
  /** Override for tests / non-default LLM. Defaults to Claude Haiku 4.5. */
  translationModelId?: string;
  /** ElevenLabs API key — caller resolves. Required. */
  elevenLabsApiKey: string;
}

export class DubError extends Error {
  constructor(
    message: string,
    public readonly stage: 'translate' | 'tts' | 'upload' | 'persist',
  ) {
    super(message);
    this.name = 'DubError';
  }
}

/**
 * Run the full dubbing pipeline for a single language. Returns the dub row
 * id once status reaches `ready` or `failed`. Never throws to the caller —
 * the row's status + error_message are the canonical signal.
 */
export async function dubScript(args: DubScriptArgs): Promise<{ id: string; status: DubStatus }> {
  if (!isSupportedLanguage(args.targetLanguage)) {
    throw new Error(`Unsupported target language: ${args.targetLanguage}`);
  }
  if (!args.sourceText || args.sourceText.trim().length < 10) {
    throw new Error('Source text is empty or too short.');
  }
  if (!args.voiceId) throw new Error('voiceId is required');
  if (!args.elevenLabsApiKey) throw new Error('elevenLabsApiKey is required');

  const dubId = await upsertDubRow({
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    scriptId: args.scriptId,
    targetLanguage: args.targetLanguage,
    voiceId: args.voiceId,
  });

  // -- Translate -----------------------------------------------------------
  let translated: string;
  try {
    const { system, user } = buildTranslationPrompt(args.sourceText, args.targetLanguage);
    translated = (await generateText({
      modelId: args.translationModelId || DEFAULT_TRANSLATION_MODEL,
      systemPrompt: system,
      prompt: user,
      maxTokens: 8000,
      temperature: 0.3,
    })).trim();
    if (translated.length < 10) {
      throw new DubError('Translation came back empty or too short', 'translate');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('dub translation failed', { dubId, language: args.targetLanguage, detail: msg });
    await markFailed(dubId, `Translation failed: ${msg}`);
    return { id: dubId, status: 'failed' };
  }
  await markGenerating(dubId, translated);

  // -- TTS -----------------------------------------------------------------
  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await generateVoiceover(args.elevenLabsApiKey, {
      text: translated,
      voiceId: args.voiceId,
      modelId: ELEVENLABS_MULTILINGUAL_MODEL,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('dub TTS failed', { dubId, language: args.targetLanguage, detail: msg });
    await markFailed(dubId, `TTS failed: ${msg}`);
    return { id: dubId, status: 'failed' };
  }

  // -- Upload --------------------------------------------------------------
  const blobPathname = `dubs/${args.scriptId}/${args.targetLanguage}.mp3`;
  let audioUrl: string;
  try {
    const result = await put(blobPathname, audioBuffer, {
      access: 'public',
      contentType: 'audio/mpeg',
      // The same (script, language) gets re-dubbed on re-run; allow overwrite.
      allowOverwrite: true,
    });
    audioUrl = result.url;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('dub upload failed', { dubId, language: args.targetLanguage, detail: msg });
    await markFailed(dubId, `Upload failed: ${msg}`);
    return { id: dubId, status: 'failed' };
  }

  // -- Persist -------------------------------------------------------------
  const durationSeconds = estimateDubDuration(translated.length);
  try {
    await markReady(dubId, audioUrl, blobPathname, durationSeconds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('dub persist failed', { dubId, language: args.targetLanguage, detail: msg });
    await markFailed(dubId, `Persist failed: ${msg}`);
    return { id: dubId, status: 'failed' };
  }

  return { id: dubId, status: 'ready' };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/** List all dubs for a script, scoped to the workspace. */
export async function listDubsForScript(
  scriptId: string,
  workspaceId: string,
): Promise<DubRow[]> {
  const { rows } = await sql<DubRow>`
    SELECT
      id, workspace_id, project_id, script_id,
      source_language, target_language,
      translated_script, voice_id,
      audio_url, blob_pathname, duration_seconds, char_count,
      status, error_message,
      created_at::text AS created_at,
      updated_at::text AS updated_at,
      completed_at::text AS completed_at
    FROM dubbed_voiceovers
    WHERE script_id = ${scriptId}::uuid
      AND workspace_id = ${workspaceId}::uuid
    ORDER BY target_language ASC
  `;
  return rows;
}
