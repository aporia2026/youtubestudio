import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { analyzeYouTubeVideo, modelSupportsVideo, getModelById } from '@/lib/ai';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { logger } from '@/lib/logger';
import { buildAnalyzerPrompt } from '@/lib/analyzer/prompt';
import { validateAnalyzedVideo, type AnalyzedVideo } from '@/lib/analyzer/types';
import { extractYoutubeVideoId, canonicalYoutubeUrl } from '@/lib/analyzer/url';
import {
  findCachedAnalysis,
  insertAnalysisRow,
  completeAnalysis,
  failAnalysis,
  dailyAnalysisCountForUser,
  listRecentAnalyses,
  getWorkspaceAnalysisCap,
} from '@/lib/analyzer/db';

/**
 * Deep YouTube video analyzer — POST entry point
 * (Phase 1 of `_plans/2026-05-18-youtube-deep-analyzer.md`).
 *
 * Inline-with-cache pattern, matching the existing competitor
 * video-analyze route. Gemini ingests the YouTube URL natively (no
 * video download, no blob storage). On success the result is cached
 * in `youtube_analyses` keyed by `(workspace_id, video_id,
 * analyzer_version, prompt_version)` — same URL re-POSTed returns
 * the cached row instantly.
 *
 * Body:
 *   { youtubeUrl: string, force?: boolean }
 *
 * Returns:
 *   200 — { analysisId, cached: boolean, result: AnalyzedVideo }
 *   400 — invalid URL / body
 *   429 — rate-limit (per-IP) OR daily-cap (per-user) exceeded
 *   502 — Gemini failure or invalid structured output
 */

// Up to 5 min — Gemini full-video analysis can take 2-4 min on long videos
// on Pro models. Matches the existing competitor video-analyze route.
export const maxDuration = 300;

// Default analyzer model. Gemini 2.5 Pro because the operator chose
// "premium multimodal" in the planning round. To override per-workspace
// later, plumb this through the per-feature model resolver and add a
// new AppFeature id (see src/lib/ai-models.ts).
const DEFAULT_ANALYZER_MODEL = 'gemini-2.5-pro';

// Soft per-user daily cap, default value. Per-workspace override
// lives in `workspaces.analyses_per_user_per_day_override` (migration
// 0075); admins set it via /api/admin/workspaces/[id]/analyzer-cap.
// Read at request time via getWorkspaceAnalysisCap.
const DEFAULT_DAILY_ANALYSIS_CAP_PER_USER = 20;

interface PostBody {
  youtubeUrl?: unknown;
  force?: unknown;
  modelId?: unknown;
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Per-IP rate limit — a thin defence on top of the per-user daily
  // cap. 5 analyses / minute is generous for hand-picked workflows
  // and below what a script could use to drain the daily cap quickly.
  const { limited } = checkRateLimit(`yt-deep-analyze:${getClientIP(req)}`, 5, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Too many requests — slow down for a minute.' }, { status: 429 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const youtubeUrl = typeof body.youtubeUrl === 'string' ? body.youtubeUrl : '';
  const force = body.force === true;
  const modelId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : DEFAULT_ANALYZER_MODEL;

  if (!youtubeUrl) {
    return NextResponse.json({ error: 'youtubeUrl is required' }, { status: 400 });
  }

  const videoId = extractYoutubeVideoId(youtubeUrl);
  if (!videoId) {
    return NextResponse.json({ error: 'Could not parse a YouTube video id from that URL.' }, { status: 400 });
  }
  const canonicalUrl = canonicalYoutubeUrl(videoId);

  const model = getModelById(modelId);
  if (!model) {
    return NextResponse.json({ error: `Unknown model: ${modelId}` }, { status: 400 });
  }
  if (!modelSupportsVideo(modelId)) {
    return NextResponse.json(
      { error: 'Selected model does not support native video analysis. Pick a Gemini model (Google or Kie.ai Gemini variant).' },
      { status: 400 },
    );
  }

  // ─── Cache-and-retry branching ───────────────────────────────────
  // When `force=true`, the operator clicked "Re-analyze" — skip the
  // cached-result short-circuit but still respect an in-flight row.
  // Otherwise branch on the existing row's stage:
  //   done      → return the cached result (free)
  //   analyzing → 202; client should poll the GET endpoint
  //   failed    → fall through to retry (insertAnalysisRow's DELETE
  //               clears the prior failed row so the UNIQUE doesn't
  //               trip)
  let retryAfterFailure = false;
  const cached = await findCachedAnalysis({ workspaceId: session.ws, videoId });
  if (cached?.stage === 'analyzing') {
    return NextResponse.json(
      { analysisId: cached.id, cached: false, status: 'analyzing' },
      { status: 202 },
    );
  }
  if (!force && cached?.stage === 'done' && cached.result_jsonb) {
    return NextResponse.json({
      analysisId: cached.id,
      cached: true,
      result: cached.result_jsonb,
    });
  }
  if (cached?.stage === 'failed') {
    retryAfterFailure = true;
  }

  // ─── Daily cap ───────────────────────────────────────────────────
  // Read the cap (admin override if set, else default) and the
  // user's last-24-hour count in parallel — they're independent.
  const [cap, dailyCount] = await Promise.all([
    getWorkspaceAnalysisCap({
      workspaceId: session.ws,
      defaultCap: DEFAULT_DAILY_ANALYSIS_CAP_PER_USER,
    }),
    dailyAnalysisCountForUser({
      workspaceId: session.ws,
      requestedBy: session.uid,
    }),
  ]);
  if (dailyCount >= cap) {
    return NextResponse.json(
      {
        error:
          cap === 0
            ? 'The deep video analyzer is disabled for this workspace. Ask an admin to enable it.'
            : `Daily analysis cap reached (${cap}/day). Try again tomorrow or ask an admin to raise your limit.`,
        reason: 'daily_analysis_cap',
      },
      { status: 429 },
    );
  }

  // ─── Optional title/channel enrichment ───────────────────────────
  // Best-effort — a missing key or a failed lookup must not block
  // analysis (matches the pattern in /api/analyze/youtube-style).
  let videoTitle: string | null = null;
  let channelTitle: string | null = null;
  if (process.env.YOUTUBE_API_KEY) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) {
        const data = await res.json();
        videoTitle = data.items?.[0]?.snippet?.title || null;
        channelTitle = data.items?.[0]?.snippet?.channelTitle || null;
      }
    } catch {
      /* enrichment is optional — fall through */
    }
  }

  // ─── Insert the in-flight row ────────────────────────────────────
  // Pass `force=true` when the operator explicitly asked OR when the
  // prior row was `failed` — both need the prior row DELETEd first
  // so the UNIQUE on (workspace, video, versions) doesn't trip.
  const analysisId = await insertAnalysisRow({
    workspaceId: session.ws,
    requestedBy: session.uid,
    videoId,
    videoUrl: canonicalUrl,
    videoTitle,
    channelTitle,
    modelId,
    force: force || retryAfterFailure,
  });

  // ─── Call Gemini (the long-running step) ─────────────────────────
  const { system, user } = buildAnalyzerPrompt({
    videoTitle: videoTitle ?? '',
    channelTitle: channelTitle ?? '',
    videoUrl: canonicalUrl,
  });

  let raw: string;
  try {
    raw = await analyzeYouTubeVideo({
      modelId,
      youtubeUrl: canonicalUrl,
      prompt: user,
      systemPrompt: system,
      // The schema is rich — give Gemini enough headroom. Real outputs
      // are typically 8-30K tokens depending on video length.
      maxTokens: 32_000,
      temperature: 0.3,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Gemini call failed';
    await failAnalysis({ workspaceId: session.ws, analysisId, reason: detail, costUsd: 0 });
    logger.warn('youtube-deep-analyze: gemini call failed', { analysisId, video_id: videoId, detail });
    return NextResponse.json({ error: detail, analysisId }, { status: 502 });
  }

  if (!raw || !raw.trim()) {
    const reason = 'Gemini returned an empty response — the video may be private, restricted, or removed.';
    await failAnalysis({ workspaceId: session.ws, analysisId, reason, costUsd: 0 });
    return NextResponse.json({ error: reason, analysisId }, { status: 502 });
  }

  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    const reason = err instanceof Error ? `Failed to parse Gemini JSON: ${err.message}` : 'Failed to parse Gemini JSON';
    await failAnalysis({ workspaceId: session.ws, analysisId, reason, costUsd: 0 });
    logger.warn('youtube-deep-analyze: parse failure', { analysisId, video_id: videoId, raw_head: raw.slice(0, 300) });
    return NextResponse.json({ error: reason, analysisId, rawHead: raw.slice(0, 500) }, { status: 502 });
  }

  const validation = validateAnalyzedVideo(parsed);
  if (!validation.ok) {
    const reason = `Gemini output did not match the expected schema (${validation.reason}). Try Re-analyze.`;
    await failAnalysis({ workspaceId: session.ws, analysisId, reason, costUsd: 0 });
    logger.warn('youtube-deep-analyze: schema mismatch', {
      analysisId,
      video_id: videoId,
      schema_reason: validation.reason,
      raw_head: raw.slice(0, 600),
    });
    return NextResponse.json(
      {
        error: reason,
        analysisId,
        schemaReason: validation.reason,
        rawHead: raw.slice(0, 2000),
      },
      { status: 502 },
    );
  }

  // Gemini hallucinates two meta fields with measurable frequency
  // (see `_plans/2026-05-18-youtube-deep-analyzer-eval.md`):
  //   - meta.analyzed_at: wrong year on 3/3 eval references
  //   - meta.video_id: wrong id on 1/3 eval references
  // Both have ground-truth values already in scope here (the URL we
  // canonicalized + the current clock). Overwrite before persisting
  // so downstream consumers never see fabricated values. Log the
  // overwrite at info level so we can track how often Gemini gets it
  // right going forward.
  const serverAnalyzedAt = new Date().toISOString();
  const geminiAnalyzedAt = validation.value.meta.analyzed_at;
  const geminiVideoId = validation.value.meta.video_id;
  const videoIdMismatch = geminiVideoId !== videoId;
  const result: AnalyzedVideo = {
    ...validation.value,
    meta: {
      ...validation.value.meta,
      video_id: videoId,
      analyzed_at: serverAnalyzedAt,
    },
  };
  logger.info('youtube-deep-analyze: meta overwrites applied', {
    analysisId,
    video_id: videoId,
    gemini_analyzed_at: geminiAnalyzedAt,
    server_analyzed_at: serverAnalyzedAt,
    gemini_video_id: geminiVideoId,
    video_id_mismatch: videoIdMismatch,
  });

  // Cost accounting deferred — `analyzeYouTubeVideo` returns a plain
  // string, so we don't have token-usage at hand. The daily cap is
  // count-based, not cost-based, so this is fine for v1. A follow-up
  // can extend the wrapper to surface usage and we'll backfill here.
  await completeAnalysis({
    workspaceId: session.ws,
    analysisId,
    result,
    costUsd: 0,
  });

  logger.info('youtube-deep-analyze: done', {
    analysisId,
    video_id: videoId,
    model_id: modelId,
    style_pack_count: result.style_packs.length,
  });

  return NextResponse.json({ analysisId, cached: false, result });
});

/**
 * GET /api/analyze/youtube-video — workspace's recent analyses, reverse
 * chronological, capped at 25 by default. Used by the /analyze entry
 * page's "Recent analyses" list. Workspace-scoped via apiRoute.authed.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : 25;
  const rows = await listRecentAnalyses({
    workspaceId: session.ws,
    limit: Number.isFinite(limit) ? limit : 25,
  });
  return NextResponse.json({
    analyses: rows.map((r) => ({
      id: r.id,
      videoId: r.video_id,
      videoUrl: r.video_url,
      videoTitle: r.video_title,
      channelTitle: r.channel_title,
      stage: r.stage,
      failureReason: r.failure_reason,
      modelId: r.model_id,
      stylePackCount: r.result_jsonb?.style_packs?.length ?? null,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    })),
  });
});
