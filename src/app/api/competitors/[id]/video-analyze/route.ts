import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { analyzeYouTubeVideo, modelSupportsVideo, getModelById } from '@/lib/ai';
import { competitorVideoForensicsPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';

export const maxDuration = 300; // up to 5 min — Gemini may take a while on long videos

/**
 * Forensic video analysis — Gemini watches the full YouTube video.
 * Body: { modelId, videoRowId, niche?, force? }
 * Returns: { analysis }
 *
 * Caches result in competitor_videos.video_analysis. Pass force=true to re-run.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { limited } = checkRateLimit(`video-analyze:${getClientIP(req)}`, 10, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  try {
    await ensureCompetitorSchema();
    let body: { modelId?: string; videoRowId?: string; niche?: string; force?: boolean };
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { modelId, videoRowId, niche, force } = body;
    if (!modelId || !videoRowId) return NextResponse.json({ error: 'modelId and videoRowId required' }, { status: 400 });
    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    if (!modelSupportsVideo(modelId)) {
      return NextResponse.json({
        error: 'Selected model does not support native video analysis. Please select a Gemini model (Google or Kie.ai Gemini variant).',
      }, { status: 400 });
    }

    // Fetch competitor + video
    const channelRes = await sql`SELECT title FROM competitor_channels WHERE id = ${id}`;
    if (channelRes.rows.length === 0) return NextResponse.json({ error: 'Competitor not found' }, { status: 404 });
    const channelName = String(channelRes.rows[0].title);

    const videoRes = await sql`
      SELECT id, video_id, title, view_count, like_count, comment_count, duration_seconds, outlier_score, published_at, video_analysis
      FROM competitor_videos
      WHERE id = ${videoRowId} AND competitor_id = ${id}
    `;
    if (videoRes.rows.length === 0) return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    const v = videoRes.rows[0];

    // Cache hit
    if (!force && v.video_analysis) {
      return NextResponse.json({ analysis: v.video_analysis, cached: true });
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${v.video_id}`;

    const { system, user } = competitorVideoForensicsPrompt({
      videoTitle: String(v.title),
      channelName,
      views: Number(v.view_count) || 0,
      likes: Number(v.like_count) || 0,
      comments: Number(v.comment_count) || 0,
      outlierScore: Number(v.outlier_score) || 0,
      durationSeconds: Number(v.duration_seconds) || 0,
      publishedAt: new Date(v.published_at).toISOString(),
      niche: niche || 'General',
    });

    let raw: string;
    try {
      raw = await analyzeYouTubeVideo({
        modelId,
        youtubeUrl,
        prompt: user,
        systemPrompt: system,
        maxTokens: 8000,
        temperature: 0.2,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Video analysis failed';
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    let analysis: unknown;
    try { analysis = parseLlmJson(raw); } catch {
      return NextResponse.json({ error: 'Failed to parse analysis JSON', raw: raw.slice(0, 500) }, { status: 500 });
    }

    // Cache to DB
    await sql`
      UPDATE competitor_videos
      SET video_analysis = ${JSON.stringify(analysis)}::jsonb,
          video_analyzed_at = NOW(),
          video_analysis_model = ${modelId}
      WHERE id = ${videoRowId}
    `;

    return NextResponse.json({ analysis, cached: false, model: modelId });
  } catch (err) {
    console.error('Video forensics error:', err);
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: `Video analysis failed: ${detail}` }, { status: 500 });
  }
}
