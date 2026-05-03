import { NextRequest } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { analyzeYouTubeVideo, modelSupportsVideo, getModelById } from '@/lib/ai';
import { competitorVideoForensicsPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';

// Vercel: Hobby plan caps at 300s. Long batches may be truncated — the SSE stream
// surfaces partial progress and the user can resume by re-clicking (cached videos
// are skipped on retry). Bump this to 800 if you upgrade to Pro/Enterprise.
export const maxDuration = 300;

/**
 * Batch video forensics — analyzes the top-N videos by views (or by outlier score).
 * Streams progress as SSE.
 *
 * Body: { modelId, niche?, count? (default 10), strategy? ('top-views'|'outliers'), force? }
 * Stream events:
 *   data: {"type":"start","total":N}
 *   data: {"type":"progress","videoRowId":"...","videoTitle":"...","status":"analyzing"}
 *   data: {"type":"progress","videoRowId":"...","videoTitle":"...","status":"done","cached":false}
 *   data: {"type":"progress","videoRowId":"...","status":"error","error":"..."}
 *   data: {"type":"complete","analyzed":N,"failed":M}
 */
// Audit C2: previously unauthenticated. Now wrapped + workspace-scoped.
export const POST = apiRoute.authed(async (session, req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;

  const { limited } = checkRateLimit(`video-batch:${getClientIP(req)}`, 2, 60_000);
  if (limited) return new Response(JSON.stringify({ error: 'Rate limited' }), { status: 429 });

  // Robust body parse — empty body or invalid JSON should not crash with 500
  let body: { modelId?: string; niche?: string; count?: number; strategy?: string; force?: boolean };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }
  const { modelId, niche, count = 10, strategy = 'top-views', force = false } = body;
  if (!modelId) return new Response(JSON.stringify({ error: 'modelId required' }), { status: 400 });

  const model = getModelById(modelId);
  if (!model) return new Response(JSON.stringify({ error: 'Invalid model' }), { status: 400 });
  if (!modelSupportsVideo(modelId)) {
    return new Response(JSON.stringify({
      error: 'Selected model does not support native video analysis. Use a direct Google Gemini model (Kie.ai Gemini variants do not work for video — see error message in /api/competitors/[id]/video-analyze for details).',
    }), { status: 400 });
  }

  await ensureCompetitorSchema();

  const channelRes = await sql`
    SELECT title FROM competitor_channels
     WHERE id = ${id}
       AND workspace_id = ${session.ws}::uuid
  `;
  if (channelRes.rows.length === 0) return new Response(JSON.stringify({ error: 'Competitor not found' }), { status: 404 });
  const channelName = String(channelRes.rows[0].title);

  // Strict allowlist for the dynamic ORDER BY — never interpolate user-controlled values.
  const safeStrategy: 'top-views' | 'outliers' = strategy === 'outliers' ? 'outliers' : 'top-views';
  const safeCount = Math.min(50, Math.max(1, Number(count) || 10));
  const videos = safeStrategy === 'outliers'
    ? await sql`
        SELECT id, video_id, title, view_count, like_count, comment_count, duration_seconds, outlier_score, published_at, video_analysis
        FROM competitor_videos
        WHERE competitor_id = ${id}
        ORDER BY outlier_score DESC
        LIMIT ${safeCount}`
    : await sql`
        SELECT id, video_id, title, view_count, like_count, comment_count, duration_seconds, outlier_score, published_at, video_analysis
        FROM competitor_videos
        WHERE competitor_id = ${id}
        ORDER BY view_count DESC
        LIMIT ${safeCount}`;

  if (videos.rows.length === 0) return new Response(JSON.stringify({ error: 'No videos to analyze' }), { status: 400 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      send({ type: 'start', total: videos.rows.length });

      let analyzed = 0;
      let failed = 0;

      for (const row of videos.rows) {
        const videoRowId = String(row.id);
        const videoTitle = String(row.title);

        if (!force && row.video_analysis) {
          send({ type: 'progress', videoRowId, videoTitle, status: 'done', cached: true });
          analyzed++;
          continue;
        }

        send({ type: 'progress', videoRowId, videoTitle, status: 'analyzing' });

        try {
          const youtubeUrl = `https://www.youtube.com/watch?v=${row.video_id}`;
          const { system, user } = competitorVideoForensicsPrompt({
            videoTitle,
            channelName,
            views: Number(row.view_count) || 0,
            likes: Number(row.like_count) || 0,
            comments: Number(row.comment_count) || 0,
            outlierScore: Number(row.outlier_score) || 0,
            durationSeconds: Number(row.duration_seconds) || 0,
            publishedAt: new Date(row.published_at).toISOString(),
            niche: niche || 'General',
          });

          const raw = await analyzeYouTubeVideo({
            modelId,
            youtubeUrl,
            prompt: user,
            systemPrompt: system,
            maxTokens: 8000,
            temperature: 0.2,
          });

          let analysis: unknown;
          try { analysis = parseLlmJson(raw); } catch (err) {
            throw new Error(`JSON parse failed: ${err instanceof Error ? err.message : 'unknown'}`);
          }

          await sql`
            UPDATE competitor_videos
            SET video_analysis = ${JSON.stringify(analysis)}::jsonb,
                video_analyzed_at = NOW(),
                video_analysis_model = ${modelId}
            WHERE id = ${videoRowId}
          `;

          send({ type: 'progress', videoRowId, videoTitle, status: 'done', cached: false });
          analyzed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown';
          send({ type: 'progress', videoRowId, videoTitle, status: 'error', error: msg });
          failed++;
        }
      }

      send({ type: 'complete', analyzed, failed });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
});
