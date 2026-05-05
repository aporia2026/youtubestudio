/**
 * Phase 9.4 — auto-tagged format + topic per video.
 *
 * Drives the dashboard's per-format attribution panel ("your tutorials
 * average 22% higher AVP than your story videos") and unlocks future
 * per-format predictions in the retention predictor.
 *
 * One AI call per video, cached by the byte-stable system prompt.
 * Cost is ~free at the workspace's typical volume (Haiku, 200 input
 * tokens, 50 output tokens — well under a cent per video). The
 * tagger is a separate cron rather than part of syncVideoAnalytics
 * because tags don't change with stat drift; we only re-tag when
 * the title is edited (out of scope for v1) or every 30 days when
 * the model upgrades.
 */
import { sql } from '@vercel/postgres';
import { generateText } from './ai';
import { logger } from './logger';
import { getEffectiveModelId } from './model-defaults';
import { parseLlmJson } from './parse-llm-json';
import {
  VIDEO_FORMATS,
  isVideoFormat,
  type FormatStats,
  type VideoFormat,
} from './format-tags-types';

// Re-export for back-compat with existing callers (tests, server libs)
// that import from this module directly.
export { VIDEO_FORMATS, isVideoFormat };
export type { FormatStats, VideoFormat };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoFormatTag {
  workspace_id: string;
  youtube_video_id: string;
  channel_id: string | null;
  format: VideoFormat;
  topics: string[];
  confidence: number;
  ai_model: string;
  tagged_at: string;
}

// FormatStats moved to format-tags-types.ts so the dashboard card
// can import without dragging server deps into the browser bundle.

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface RawTaggerOutput {
  format?: unknown;
  topics?: unknown;
  confidence?: unknown;
}

/**
 * Parse the AI tagger's JSON output. Pure: no DB, no I/O. Returns
 * null when the JSON is malformed or the format isn't in our enum
 * (the caller falls back to 'other' rather than discarding the row).
 *
 * Topics are lowercased + de-duped + capped at 5 entries; each entry
 * is bounded at 40 chars. Defensive against the model returning
 * comma-separated strings instead of arrays.
 */
export function parseFormatTagOutput(raw: string): {
  format: VideoFormat;
  topics: string[];
  confidence: number;
} | null {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as RawTaggerOutput;

  const formatRaw = typeof o.format === 'string' ? o.format.toLowerCase().trim() : '';
  const format: VideoFormat = isVideoFormat(formatRaw) ? formatRaw : 'other';

  let topicsArr: string[] = [];
  if (Array.isArray(o.topics)) {
    topicsArr = o.topics.filter((t): t is string => typeof t === 'string');
  } else if (typeof o.topics === 'string') {
    // Defensive: model sometimes returns "ai, agents, claude".
    topicsArr = o.topics.split(',');
  }
  const topics = Array.from(
    new Set(
      topicsArr
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 40),
    ),
  ).slice(0, 5);

  const confidence =
    typeof o.confidence === 'number' && Number.isFinite(o.confidence)
      ? Math.max(0, Math.min(1, o.confidence))
      : 0.5;

  return { format, topics, confidence };
}

/**
 * Aggregate per-format stats from a list of tagged videos joined to
 * their `video_analytics` row. Pure: caller pre-fetches the join.
 */
export function aggregateFormatStats(
  rows: Array<{
    format: VideoFormat;
    average_view_percentage: number | null;
    ctr_percentage: number | null;
    views: number | null;
  }>,
): FormatStats[] {
  const groups = new Map<
    VideoFormat,
    { count: number; avpSum: number; avpN: number; ctrSum: number; ctrN: number; viewsSum: number; viewsN: number }
  >();
  for (const r of rows) {
    if (!groups.has(r.format)) {
      groups.set(r.format, {
        count: 0,
        avpSum: 0, avpN: 0,
        ctrSum: 0, ctrN: 0,
        viewsSum: 0, viewsN: 0,
      });
    }
    const g = groups.get(r.format)!;
    g.count += 1;
    if (typeof r.average_view_percentage === 'number') {
      g.avpSum += r.average_view_percentage;
      g.avpN += 1;
    }
    if (typeof r.ctr_percentage === 'number') {
      g.ctrSum += r.ctr_percentage;
      g.ctrN += 1;
    }
    if (typeof r.views === 'number') {
      g.viewsSum += r.views;
      g.viewsN += 1;
    }
  }
  return [...groups.entries()]
    .map(([format, g]) => ({
      format,
      video_count: g.count,
      mean_avp: g.avpN > 0 ? g.avpSum / g.avpN : null,
      mean_ctr: g.ctrN > 0 ? g.ctrSum / g.ctrN : null,
      mean_views: g.viewsN > 0 ? g.viewsSum / g.viewsN : null,
    }))
    .sort((a, b) => b.video_count - a.video_count);
}

// ---------------------------------------------------------------------------
// AI tagger
// ---------------------------------------------------------------------------

const TAGGER_SYSTEM_PROMPT = `You classify YouTube videos by their narrative format + extract topical tags. You read a title (and optionally a script excerpt or description) and emit a single primary format + up to 5 lowercase topic tokens.

Format must be ONE of: explainer, list, story, tutorial, commentary, interview, vlog, showcase, other.

Definitions:
- explainer: teaches a concept ("How does X work?", "What is Y?")
- list: ranked or unranked enumeration ("Top 5...", "10 things...")
- tutorial: step-by-step how-to ("How to build X")
- story: personal or narrative arc ("I tried X for 30 days")
- commentary: opinion / reaction / news take
- interview: conversation with a guest
- vlog: day-in-the-life or behind-the-scenes
- showcase: product / portfolio demo
- other: doesn't fit above; use sparingly

Topics are lowercase nouns/short phrases describing what the video is ABOUT (e.g. ["ai agents", "claude", "tutorial"]). Cap at 5; prefer specific over generic ("ai" alone is too generic).

Output STRICTLY this JSON shape with no prose:
{
  "format": "<one of the enum>",
  "topics": ["<topic 1>", "<topic 2>"],
  "confidence": <0-1 float; 0.5 if you're unsure>
}`;

export interface TagVideoOptions {
  workspaceId: string;
  channelDbId: string | null;
  youtubeVideoId: string;
  title: string;
  description?: string | null;
  /** Optional: if a script for this video is available, the first
   *  ~1500 chars are appended to the user prompt for sharper
   *  classification. */
  scriptExcerpt?: string | null;
}

/**
 * Tag one video. UPSERTs into video_format_tags. Returns the parsed
 * tag (or null on AI parse failure — the caller can retry later).
 */
export async function tagVideoFormat(opts: TagVideoOptions): Promise<VideoFormatTag | null> {
  const modelId = await getEffectiveModelId(opts.workspaceId, 'video-format-tagger');

  const titlePart = `Title: "${opts.title.slice(0, 200)}"`;
  const descPart = opts.description
    ? `\nDescription excerpt: "${opts.description.slice(0, 500)}"`
    : '';
  const scriptPart = opts.scriptExcerpt
    ? `\nScript excerpt: """\n${opts.scriptExcerpt.slice(0, 1500)}\n"""`
    : '';

  const user = `${titlePart}${descPart}${scriptPart}\n\nOutput JSON only.`;

  const raw = await generateText({
    modelId,
    systemPrompt: TAGGER_SYSTEM_PROMPT,
    prompt: user,
    maxTokens: 200,
    temperature: 0.2,
    cache: true,
    spend: {
      workspaceId: opts.workspaceId,
      projectId: null,
      channelDbId: opts.channelDbId,
      featureArea: 'video_format_tagger',
      metadata: { youtube_video_id: opts.youtubeVideoId },
    },
  });

  const parsed = parseFormatTagOutput(raw);
  if (!parsed) {
    logger.warn('format-tagger parse failed', {
      youtube_video_id: opts.youtubeVideoId,
      raw_preview: raw.slice(0, 200),
    });
    return null;
  }

  // PG TEXT[] literal: '{a,b,c}'. Topics are user-supplied in the
  // weakest sense (model output) so strip any control / quote chars
  // defensively before formatting.
  const topicsLiteral = `{${parsed.topics
    .map((t) => `"${t.replace(/[\\"]/g, '').replace(/[\x00-\x1f]/g, '')}"`)
    .join(',')}}`;

  await sql`
    INSERT INTO video_format_tags (
      workspace_id, youtube_video_id, channel_id,
      format, topics, confidence, ai_model
    ) VALUES (
      ${opts.workspaceId}::uuid,
      ${opts.youtubeVideoId},
      ${opts.channelDbId}::uuid,
      ${parsed.format},
      ${topicsLiteral}::text[],
      ${parsed.confidence},
      ${modelId}
    )
    ON CONFLICT (workspace_id, youtube_video_id) DO UPDATE SET
      channel_id = EXCLUDED.channel_id,
      format     = EXCLUDED.format,
      topics     = EXCLUDED.topics,
      confidence = EXCLUDED.confidence,
      ai_model   = EXCLUDED.ai_model,
      tagged_at  = NOW()
  `;

  return {
    workspace_id: opts.workspaceId,
    youtube_video_id: opts.youtubeVideoId,
    channel_id: opts.channelDbId,
    format: parsed.format,
    topics: parsed.topics,
    confidence: parsed.confidence,
    ai_model: modelId,
    tagged_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cron orchestrator
// ---------------------------------------------------------------------------

export interface TagSweepResult {
  scanned: number;
  tagged: number;
  skipped: number;
  errors: number;
}

/**
 * Tag every workspace's published videos that don't yet have a
 * video_format_tags row. Joins video_analytics for the title.
 *
 * Runs daily; bounded at 100 videos per invocation so a backlog
 * unwinds gradually rather than blowing through model spend in one
 * hit.
 */
export async function tagUntaggedVideos(opts: { limit?: number } = {}): Promise<TagSweepResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const { rows: candidates } = await sql<{
    workspace_id: string;
    youtube_video_id: string;
    channel_id: string | null;
    title: string | null;
  }>`
    SELECT
      va.workspace_id,
      va.youtube_video_id,
      va.channel_id,
      va.title
    FROM video_analytics va
    LEFT JOIN video_format_tags vft
      ON vft.workspace_id     = va.workspace_id
     AND vft.youtube_video_id = va.youtube_video_id
    WHERE vft.youtube_video_id IS NULL
      AND va.title IS NOT NULL
      AND va.title <> ''
      AND va.published_at IS NOT NULL
    ORDER BY va.published_at DESC
    LIMIT ${limit}
  `;

  let tagged = 0;
  let skipped = 0;
  let errors = 0;

  for (const c of candidates) {
    if (!c.title) {
      skipped += 1;
      continue;
    }
    try {
      const result = await tagVideoFormat({
        workspaceId: c.workspace_id,
        channelDbId: c.channel_id,
        youtubeVideoId: c.youtube_video_id,
        title: c.title,
      });
      if (result) tagged += 1;
      else skipped += 1;
    } catch (err) {
      errors += 1;
      logger.warn('format-tag sweep failed for one video', {
        workspace_id: c.workspace_id,
        youtube_video_id: c.youtube_video_id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: candidates.length, tagged, skipped, errors };
}

// ---------------------------------------------------------------------------
// Dashboard read API
// ---------------------------------------------------------------------------

/**
 * Workspace-level (or channel-scoped) format attribution. Joins the
 * format-tags table to the live video_analytics row and aggregates
 * per format. Returns the set sorted by video_count desc — biggest
 * buckets first.
 */
export async function getFormatAttribution(opts: {
  workspaceId: string;
  channelDbId?: string | null;
}): Promise<FormatStats[]> {
  const channelDbId = opts.channelDbId ?? null;
  const { rows } = await sql<{
    format: VideoFormat;
    average_view_percentage: number | null;
    ctr_percentage: number | null;
    views: number | null;
  }>`
    SELECT
      vft.format,
      va.average_view_percentage,
      va.ctr_percentage,
      va.views
    FROM video_format_tags vft
    JOIN video_analytics va
      ON va.workspace_id     = vft.workspace_id
     AND va.youtube_video_id = vft.youtube_video_id
    WHERE vft.workspace_id = ${opts.workspaceId}::uuid
      AND (${channelDbId}::uuid IS NULL OR vft.channel_id = ${channelDbId}::uuid)
  `;
  return aggregateFormatStats(rows);
}
