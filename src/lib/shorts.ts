/**
 * Shorts pipeline. Extracts the most viral 30-60s slice from a long-form
 * script and produces a vertical-ready Short with structured beats.
 *
 * Two stages:
 *   1. Extract — LLM reads the long script + niche/tone, returns
 *      { title, hook, short_script, payoff, word_count }. Persisted to
 *      `shorts` table.
 *   2. Voiceover (optional) — ElevenLabs `multilingual_v2` TTS over the
 *      extracted script. Audio uploads to Vercel Blob and the URL goes
 *      back onto the row.
 *
 * The pure parts (prompt builder, JSON parser, word-count → duration
 * heuristic) are exported for tests so the extraction logic can be
 * verified without burning model calls.
 */
import { sql } from '@vercel/postgres';
import { put } from '@vercel/blob';
import { generateText } from './ai';
import { generateVoiceover } from './elevenlabs';
import { parseLlmJson } from './parse-llm-json';
import { logger } from './logger';
import {
  TARGET_DURATION_SECONDS_DEFAULT,
  WORDS_PER_SECOND,
  type ShortRow,
} from './shorts-types';

export type { ShortRow } from './shorts-types';

const ELEVENLABS_MULTILINGUAL_MODEL = 'eleven_multilingual_v2';

/** Default extraction model — Sonnet 4.6 over Haiku because the extractor
 *  needs more reasoning (pick the SHARPEST insight from a 7-min script).
 *  Cheap-tier ($3 in / $15 out per 1M tokens) compared to Opus, fast
 *  enough for the 60s function budget. Override per-call by passing modelId. */
const DEFAULT_EXTRACTION_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Pure prompt + parsing
// ---------------------------------------------------------------------------

export interface ExtractedShort {
  title: string;
  hook: string;
  short_script: string;
  payoff: string;
  word_count: number;
}

/** Cheap word-count helper — splits on whitespace + drops empties. Doesn't
 *  exclude markup like [VISUAL] / [PAUSE] because those will be read aloud
 *  if the user pipes the script directly into TTS without stripping. */
export function countSpokenWords(text: string): number {
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

export function estimateShortDurationSeconds(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / WORDS_PER_SECOND));
}

export function buildShortExtractionPrompt({
  longScript,
  niche,
  tone,
  targetSeconds,
}: {
  longScript: string;
  niche: string;
  tone?: string;
  targetSeconds: number;
}): { system: string; user: string } {
  const targetWords = Math.round(targetSeconds * WORDS_PER_SECOND);
  return {
    system: `You are a YouTube Shorts strategist with a 99th-percentile track record on the vertical algorithm. You take a long-form YouTube script and produce a ${targetSeconds}-second vertical Short capturing its sharpest, most viral slice.

The Shorts algorithm in 2026 ranks on retention + swipe-through ratio. Apply every rule:

1. **HOOK (first 1-3 seconds)** — must work WITHOUT sound. Bold contrarian claim, shocking stat, or visceral question. NO "Have you ever wondered". NO "In today's video". Open mid-conflict / mid-claim. Make swiping away feel like missing something.

2. **ONE TAKEAWAY** — pick the SHARPEST single insight from the long script. Don't summarise the whole thing. The Short is a teaser-with-payoff, not a recap.

3. **PUNCHY DELIVERY** — average 8-12 words per sentence. Deliberate fragments. One beat per line. The script reads like spoken thought, not written prose.

4. **VISUAL CADENCE** — include [VISUAL: brief description] markers every 4-7 seconds. Vertical viewers' eyes need movement.

5. **PAYOFF** — close with a line that either reframes the hook OR a specific CTA ("comment 'X' for the full breakdown", "subscribe for part 2"). Generic "subscribe" CTAs get ignored.

6. **TARGET LENGTH** — ~${targetWords} words for ${targetSeconds}s at ~${WORDS_PER_SECOND} words/second. Hard cap at +20% over target.

7. **NEVER USE**: "navigate", "landscape", "realm", "buckle up", "let's dive in", "without further ado", "in today's fast-paced world", "at the end of the day", "game-changer".

Output STRICTLY this JSON shape with no prose before or after:

{
  "title": "<8-word punchy title for the Short, optimised for vertical thumbnail / search>",
  "hook": "<the literal first 1-3 second line>",
  "short_script": "<the complete script body with [VISUAL: ...] markers — speakable verbatim>",
  "payoff": "<the literal closing line>",
  "word_count": <integer count of spoken words in short_script, excluding [VISUAL: ...] blocks>
}`,
    user: `Niche: ${niche}
${tone ? `Tone: ${tone}\n` : ''}
Long-form source script:
"""
${longScript}
"""

Extract the ${targetSeconds}-second Short now. Output JSON only.`,
  };
}

/** Parse the LLM's structured-output response. Tolerates fenced JSON,
 *  extra prose, and minor schema drift. Throws if the response is
 *  unrecoverable. parseLlmJson itself throws on no-JSON-found; we
 *  re-throw with a uniform message so callers see one shape of error. */
export function parseExtractedShort(raw: string): ExtractedShort {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse JSON from LLM response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Could not parse JSON from LLM response: not an object.');
  }
  const obj = parsed as Record<string, unknown>;
  const short_script = typeof obj.short_script === 'string' ? obj.short_script.trim() : '';
  if (!short_script || short_script.length < 30) {
    throw new Error('Extracted short_script is empty or too short.');
  }
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const hook = typeof obj.hook === 'string' ? obj.hook.trim() : '';
  const payoff = typeof obj.payoff === 'string' ? obj.payoff.trim() : '';
  const claimedCount =
    typeof obj.word_count === 'number' && Number.isFinite(obj.word_count)
      ? Math.round(obj.word_count)
      : null;
  // Always recompute word_count locally — LLMs misreport their own counts.
  const word_count = claimedCount ?? countSpokenWords(short_script);
  return { title, hook, short_script, payoff, word_count };
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

export interface ExtractShortArgs {
  workspaceId: string;
  projectId: string | null;
  sourceScriptId: string;
  longScript: string;
  niche: string;
  tone?: string;
  /** Defaults to 45s — sweet-spot retention for the 2026 Shorts algorithm. */
  targetSeconds?: number;
  modelId?: string;
}

/**
 * Run the extractor and persist a `shorts` row. Returns the row id.
 */
export async function extractAndSaveShort(args: ExtractShortArgs): Promise<{ id: string; short: ExtractedShort }> {
  const targetSeconds = Math.max(10, Math.min(90, args.targetSeconds ?? TARGET_DURATION_SECONDS_DEFAULT));
  const modelId = args.modelId || DEFAULT_EXTRACTION_MODEL;
  const { system, user } = buildShortExtractionPrompt({
    longScript: args.longScript,
    niche: args.niche,
    tone: args.tone,
    targetSeconds,
  });

  const raw = await generateText({
    modelId,
    systemPrompt: system,
    prompt: user,
    maxTokens: 4000,
    temperature: 0.7,
    spend: {
      workspaceId: args.workspaceId,
      projectId: args.projectId ?? null,
      featureArea: 'shorts_extract',
      metadata: { target_seconds: targetSeconds },
    },
  });

  let short: ExtractedShort;
  try {
    short = parseExtractedShort(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('short extraction failed', {
      sourceScriptId: args.sourceScriptId,
      detail,
      raw_preview: raw.slice(0, 400),
    });
    throw new Error(`Extractor returned a malformed response: ${detail}`);
  }

  const estimatedDuration = estimateShortDurationSeconds(short.word_count);

  const { rows } = await sql<{ id: string }>`
    INSERT INTO shorts (
      workspace_id, project_id, source_script_id,
      title, short_script, hook, payoff,
      word_count, estimated_duration_seconds,
      ai_model, generation_params
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.projectId}::uuid,
      ${args.sourceScriptId}::uuid,
      ${short.title || null},
      ${short.short_script},
      ${short.hook || null},
      ${short.payoff || null},
      ${short.word_count},
      ${estimatedDuration},
      ${modelId},
      ${JSON.stringify({ targetSeconds, niche: args.niche, tone: args.tone })}::jsonb
    )
    RETURNING id
  `;
  return { id: rows[0]!.id, short };
}

export interface GenerateShortVoiceoverArgs {
  shortId: string;
  workspaceId: string;
  voiceId: string;
  elevenLabsApiKey: string;
}

export async function generateShortVoiceover(args: GenerateShortVoiceoverArgs): Promise<{
  audio_url: string;
  blob_pathname: string;
  duration_seconds: number;
}> {
  // Fetch the short, scoped to workspace.
  const { rows } = await sql<{ short_script: string; word_count: number | null }>`
    SELECT short_script, word_count
      FROM shorts
     WHERE id = ${args.shortId}::uuid AND workspace_id = ${args.workspaceId}::uuid
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error('Short not found in this workspace.');

  // Strip [VISUAL: ...] markers before TTS — those are direction cues, not
  // speakable lines. Keep [PAUSE] (some TTS engines render pauses).
  const speakable = row.short_script.replace(/\[VISUAL[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();

  const audioBuffer = await generateVoiceover(args.elevenLabsApiKey, {
    text: speakable,
    voiceId: args.voiceId,
    modelId: ELEVENLABS_MULTILINGUAL_MODEL,
  });

  const blobPathname = `shorts/${args.shortId}.mp3`;
  const result = await put(blobPathname, audioBuffer, {
    access: 'public',
    contentType: 'audio/mpeg',
    allowOverwrite: true,
  });

  const durationSeconds = estimateShortDurationSeconds(
    row.word_count ?? countSpokenWords(speakable),
  );

  await sql`
    UPDATE shorts
       SET voiceover_audio_url = ${result.url},
           voiceover_blob_pathname = ${blobPathname},
           voiceover_voice_id = ${args.voiceId},
           voiceover_duration_seconds = ${durationSeconds},
           updated_at = NOW()
     WHERE id = ${args.shortId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  return { audio_url: result.url, blob_pathname: blobPathname, duration_seconds: durationSeconds };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export async function listShortsForWorkspace(
  workspaceId: string,
  opts: { projectId?: string; limit?: number } = {},
): Promise<ShortRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.projectId) {
    const { rows } = await sql<ShortRow>`
      SELECT
        id, workspace_id, project_id, source_script_id,
        title, short_script, hook, payoff,
        word_count, estimated_duration_seconds,
        voiceover_audio_url, voiceover_blob_pathname,
        voiceover_voice_id, voiceover_duration_seconds,
        rendered_video_url, ai_model, notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM shorts
      WHERE workspace_id = ${workspaceId}::uuid
        AND project_id = ${opts.projectId}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<ShortRow>`
    SELECT
      id, workspace_id, project_id, source_script_id,
      title, short_script, hook, payoff,
      word_count, estimated_duration_seconds,
      voiceover_audio_url, voiceover_blob_pathname,
      voiceover_voice_id, voiceover_duration_seconds,
      rendered_video_url, ai_model, notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM shorts
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function getShort(id: string, workspaceId: string): Promise<ShortRow | null> {
  const { rows } = await sql<ShortRow>`
    SELECT
      id, workspace_id, project_id, source_script_id,
      title, short_script, hook, payoff,
      word_count, estimated_duration_seconds,
      voiceover_audio_url, voiceover_blob_pathname,
      voiceover_voice_id, voiceover_duration_seconds,
      rendered_video_url, ai_model, notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM shorts
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function deleteShort(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM shorts
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}
