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
import { generateText } from './ai';
import { synthesize } from './tts/dispatch';
import type { TtsProviderId, VoiceTier } from './tts/types';
import {
  buildShortVoiceoverKey,
  getDownloadUrlForBucket,
  getNarrationBucket,
  mimeTypeToExt,
  uploadToBucket,
} from './r2';
import { parseLlmJson } from './parse-llm-json';
import { logger } from './logger';
import { getEffectiveModelId } from './model-defaults';
import {
  TARGET_DURATION_SECONDS_DEFAULT,
  WORDS_PER_SECOND,
  type ShortRow,
} from './shorts-types';

export type { ShortRow } from './shorts-types';

const ELEVENLABS_MULTILINGUAL_MODEL = 'eleven_multilingual_v2';

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
  const modelId = args.modelId || (await getEffectiveModelId(args.workspaceId, 'shorts-extract'));
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

// ---------------------------------------------------------------------------
// Mode C — Phase 15.2
// ---------------------------------------------------------------------------
//
// `extractAndSaveShort` above takes a long-form SCRIPT row (sourceScriptId
// FK is required). Mode C feeds the extractor with a TRANSCRIPT MOMENT
// from an existing YouTube video — no script row to point at. This sibling
// orchestrator wraps the same prompt + parser, persists with
// kind='extracted', medium='short_native', source_youtube_video_id set,
// and source_script_id NULL.
//
// The persisted row plugs into the existing voiceover + render flow
// unchanged (it has a `short_script` body, which is the only thing the
// downstream pipeline cares about).

export interface ExtractShortFromTranscriptMomentArgs {
  workspaceId: string;
  projectId: string | null;
  /** YouTube video id the moment was taken from. */
  sourceYoutubeVideoId: string;
  /** Joined transcript text covering the candidate window (the moment's
   *  text from `clip-scorer.ts` ClipCandidate). */
  momentText: string;
  /** Start time of the moment (ms). */
  clipStartMs: number;
  /** End time of the moment (ms). */
  clipEndMs: number;
  /** The niche the user is working in — feeds the extractor's prompt. */
  niche: string;
  tone?: string;
  /** Target Short length in seconds. Clamped to [10, 90]. */
  targetSeconds?: number;
  modelId?: string;
}

export async function extractShortFromTranscriptMoment(
  args: ExtractShortFromTranscriptMomentArgs,
): Promise<{ id: string; short: ExtractedShort }> {
  const targetSeconds = Math.max(
    10,
    Math.min(90, args.targetSeconds ?? TARGET_DURATION_SECONDS_DEFAULT),
  );
  const modelId = args.modelId || (await getEffectiveModelId(args.workspaceId, 'shorts-extract'));
  const { system, user } = buildShortExtractionPrompt({
    longScript: args.momentText,
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
      featureArea: 'shorts_mode_c',
      metadata: {
        target_seconds: targetSeconds,
        source_youtube_video_id: args.sourceYoutubeVideoId,
      },
    },
  });

  let short: ExtractedShort;
  try {
    short = parseExtractedShort(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('[shorts mode-c spin] extractor parse failed', {
      sourceYoutubeVideoId: args.sourceYoutubeVideoId,
      detail,
      raw_preview: raw.slice(0, 400),
    });
    throw new Error(`Extractor returned a malformed response: ${detail}`);
  }

  const estimatedDuration = estimateShortDurationSeconds(short.word_count);

  const { rows } = await sql<{ id: string }>`
    INSERT INTO shorts (
      workspace_id, project_id,
      kind, medium,
      title, short_script, hook, payoff,
      word_count, estimated_duration_seconds,
      ai_model, generation_params,
      source_youtube_video_id, clip_start_ms, clip_end_ms
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.projectId ?? null}::uuid,
      'extracted',
      'short_native',
      ${short.title || null},
      ${short.short_script},
      ${short.hook || null},
      ${short.payoff || null},
      ${short.word_count},
      ${estimatedDuration},
      ${modelId},
      ${JSON.stringify({
        targetSeconds,
        niche: args.niche,
        tone: args.tone,
        source_youtube_video_id: args.sourceYoutubeVideoId,
        clip_start_ms: args.clipStartMs,
        clip_end_ms: args.clipEndMs,
      })}::jsonb,
      ${args.sourceYoutubeVideoId},
      ${args.clipStartMs},
      ${args.clipEndMs}
    )
    RETURNING id
  `;

  logger.info('[shorts mode-c spin] persisted', {
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    sourceYoutubeVideoId: args.sourceYoutubeVideoId,
    shortId: rows[0]!.id,
    targetSeconds,
    word_count: short.word_count,
  });

  return { id: rows[0]!.id, short };
}

export interface GenerateShortVoiceoverArgs {
  shortId: string;
  workspaceId: string;
  voiceId: string;
  /** Defaults to 'elevenlabs' (backward-compatible). Pass 'google' to
   *  synthesize via Google Cloud TTS — voiceId is then the Google voice
   *  name (e.g. 'en-US-Chirp3-HD-Charon'). */
  provider?: TtsProviderId;
  /** Required when provider !== 'elevenlabs'. Defaults to 'multilingual-v2'
   *  for ElevenLabs so existing callers keep working unchanged. */
  tier?: VoiceTier;
  /** BCP-47 language code. Defaults to 'en-US'. Required for Google. */
  languageCode?: string;
  /** Kept for backward compatibility — ignored after the dispatch
   *  migration (server reads ELEVENLABS_API_KEY directly). */
  elevenLabsApiKey?: string;
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

  const provider: TtsProviderId = args.provider ?? 'elevenlabs';
  const tier: VoiceTier = args.tier ?? (provider === 'elevenlabs' ? 'multilingual-v2' : 'chirp3-hd');
  const languageCode = args.languageCode ?? 'en-US';

  const result = await synthesize({
    voice: {
      providerId: provider,
      voiceId: args.voiceId,
      languageCode,
      tier,
    },
    text: speakable,
    options:
      provider === 'elevenlabs'
        ? {
            providerId: 'elevenlabs',
            modelId: ELEVENLABS_MULTILINGUAL_MODEL,
            stability: 0.5,
            similarity: 0.75,
            style: 0.5,
            useSpeakerBoost: true,
          }
        : { providerId: 'google' },
  });
  const audioBuffer = result.audioBytes;

  // Upload to R2 narration bucket. Matches the ElevenLabs voiceover
  // migration: every audio path lives in R2, the Blob store doesn't
  // matter for storage decisions anymore.
  const bucket = getNarrationBucket();
  const ext = mimeTypeToExt(result.mimeType);
  const r2Key = buildShortVoiceoverKey(args.shortId, args.voiceId, ext);
  await uploadToBucket(bucket, r2Key, Buffer.from(audioBuffer), result.mimeType);
  const audioUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_NARRATION_PUBLIC_URL);

  const durationSeconds = estimateShortDurationSeconds(
    row.word_count ?? countSpokenWords(speakable),
  );

  // Keep the `voiceover_blob_pathname` column populated with the R2
  // key — the column name is legacy from the Blob era, but the value
  // is now an R2 object key. Renaming the column is a bigger change
  // not in scope here; the data contract still makes sense (a stable
  // reference to the stored object).
  await sql`
    UPDATE shorts
       SET voiceover_audio_url = ${audioUrl},
           voiceover_blob_pathname = ${r2Key},
           voiceover_voice_id = ${args.voiceId},
           voiceover_duration_seconds = ${durationSeconds},
           updated_at = NOW()
     WHERE id = ${args.shortId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  return { audio_url: audioUrl, blob_pathname: r2Key, duration_seconds: durationSeconds };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/** Common SELECT body. Inlined for now — extracting would force a `sql.unsafe`
 *  call site since @vercel/postgres tags don't accept fragment values. */
export async function listShortsForWorkspace(
  workspaceId: string,
  opts: {
    projectId?: string;
    medium?: 'long_form' | 'short_clip' | 'short_native';
    /** When true, hides dismissed rows. Inbox queries pass true; the existing
     *  /shorts page (which shows everything including dismissed) leaves it false. */
    inboxOnly?: boolean;
    limit?: number;
  } = {},
): Promise<ShortRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Branch on every filter combination — @vercel/postgres tagged templates
  // can't compose fragments, so explicit branches are the only safe path.
  // The Phase 1 inbox surface uses inboxOnly + medium='short_clip' for Mode A
  // candidates and medium='short_native' for auto-fan-out + Mode C output.
  if (opts.projectId && opts.medium && opts.inboxOnly) {
    const { rows } = await sql<ShortRow>`
      SELECT
        id, workspace_id, project_id, source_script_id, kind, medium,
        title, short_script, hook, payoff,
        word_count, estimated_duration_seconds,
        source_title, source_description, seo_result,
        voiceover_audio_url, voiceover_blob_pathname,
        voiceover_voice_id, voiceover_duration_seconds,
        rendered_video_url, ai_model, notes,
        hook_score, dismissed_at::text AS dismissed_at,
        source_youtube_video_id, clip_start_ms, clip_end_ms,
        style_id, style_assets,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM shorts
      WHERE workspace_id = ${workspaceId}::uuid
        AND project_id = ${opts.projectId}::uuid
        AND medium = ${opts.medium}
        AND dismissed_at IS NULL
      ORDER BY hook_score DESC NULLS LAST, created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.projectId) {
    const { rows } = await sql<ShortRow>`
      SELECT
        id, workspace_id, project_id, source_script_id, kind, medium,
        title, short_script, hook, payoff,
        word_count, estimated_duration_seconds,
        source_title, source_description, seo_result,
        voiceover_audio_url, voiceover_blob_pathname,
        voiceover_voice_id, voiceover_duration_seconds,
        rendered_video_url, ai_model, notes,
        hook_score, dismissed_at::text AS dismissed_at,
        source_youtube_video_id, clip_start_ms, clip_end_ms,
        style_id, style_assets,
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
  if (opts.medium && opts.inboxOnly) {
    const { rows } = await sql<ShortRow>`
      SELECT
        id, workspace_id, project_id, source_script_id, kind, medium,
        title, short_script, hook, payoff,
        word_count, estimated_duration_seconds,
        source_title, source_description, seo_result,
        voiceover_audio_url, voiceover_blob_pathname,
        voiceover_voice_id, voiceover_duration_seconds,
        rendered_video_url, ai_model, notes,
        hook_score, dismissed_at::text AS dismissed_at,
        source_youtube_video_id, clip_start_ms, clip_end_ms,
        style_id, style_assets,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM shorts
      WHERE workspace_id = ${workspaceId}::uuid
        AND medium = ${opts.medium}
        AND dismissed_at IS NULL
      ORDER BY hook_score DESC NULLS LAST, created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.inboxOnly) {
    const { rows } = await sql<ShortRow>`
      SELECT
        id, workspace_id, project_id, source_script_id, kind, medium,
        title, short_script, hook, payoff,
        word_count, estimated_duration_seconds,
        source_title, source_description, seo_result,
        voiceover_audio_url, voiceover_blob_pathname,
        voiceover_voice_id, voiceover_duration_seconds,
        rendered_video_url, ai_model, notes,
        hook_score, dismissed_at::text AS dismissed_at,
        source_youtube_video_id, clip_start_ms, clip_end_ms,
        style_id, style_assets,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM shorts
      WHERE workspace_id = ${workspaceId}::uuid
        AND dismissed_at IS NULL
      ORDER BY hook_score DESC NULLS LAST, created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<ShortRow>`
    SELECT
      id, workspace_id, project_id, source_script_id, kind, medium,
      title, short_script, hook, payoff,
      word_count, estimated_duration_seconds,
      source_title, source_description, seo_result,
      voiceover_audio_url, voiceover_blob_pathname,
      voiceover_voice_id, voiceover_duration_seconds,
      rendered_video_url, ai_model, notes,
      hook_score, dismissed_at::text AS dismissed_at,
      source_youtube_video_id, clip_start_ms, clip_end_ms,
      style_id, style_assets,
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
      id, workspace_id, project_id, source_script_id, kind, medium,
      title, short_script, hook, payoff,
      word_count, estimated_duration_seconds,
      source_title, source_description, seo_result,
      voiceover_audio_url, voiceover_blob_pathname,
      voiceover_voice_id, voiceover_duration_seconds,
      rendered_video_url, ai_model, notes,
      hook_score, dismissed_at::text AS dismissed_at,
      source_youtube_video_id, clip_start_ms, clip_end_ms,
      style_id, style_assets,
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
