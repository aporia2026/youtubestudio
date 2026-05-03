import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { generateText, getModelById } from '@/lib/ai';
import { competitorInspiredIdeasPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { computeAnalytics, VideoRow } from '@/lib/competitor-analytics';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Generate video ideas for the user based on competitor analytics.
 * Body: { modelId, niche, userAngle?, contentGaps? }
 * Returns: { ideas: [...] }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { limited } = checkRateLimit(`comp-ideas:${getClientIP(req)}`, 5, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  try {
    await ensureCompetitorSchema();
    let body: { modelId?: string; niche?: string; userAngle?: string; contentGaps?: string[] };
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { modelId, niche, userAngle, contentGaps } = body;
    if (!modelId) return NextResponse.json({ error: 'modelId required' }, { status: 400 });
    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const channel = await sql`SELECT * FROM competitor_channels WHERE id = ${id}`;
    if (channel.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const ch = channel.rows[0];

    const videosRes = await sql`
      SELECT video_id, title, description, published_at, view_count, like_count, comment_count,
             duration, duration_seconds, category_id, tags, top_comments
      FROM competitor_videos
      WHERE competitor_id = ${id}
      ORDER BY published_at DESC
      LIMIT 200
    `;
    if (videosRes.rows.length === 0) return NextResponse.json({ error: 'Sync the channel first' }, { status: 400 });

    const videos: VideoRow[] = videosRes.rows.map(r => ({
      video_id: String(r.video_id),
      title: String(r.title),
      description: r.description ? String(r.description) : '',
      published_at: new Date(r.published_at).toISOString(),
      view_count: Number(r.view_count) || 0,
      like_count: Number(r.like_count) || 0,
      comment_count: Number(r.comment_count) || 0,
      duration: String(r.duration || 'PT0S'),
      duration_seconds: Number(r.duration_seconds) || 0,
      category_id: r.category_id ? String(r.category_id) : null,
      tags: Array.isArray(r.tags) ? r.tags : (typeof r.tags === 'string' ? JSON.parse(r.tags || '[]') : []),
    }));

    const analytics = computeAnalytics(videos);

    const analyticsSummary = `Median ${analytics.performance.medianViews.toLocaleString()} views, ${analytics.cadence.uploadsPerWeek}/week, momentum ${analytics.trend.momentum} (${analytics.trend.momentumPct}%), best bucket: ${analytics.duration.bestBucket}, best day: ${analytics.cadence.bestDayByAvgViews || 'N/A'}`;

    const { system, user } = competitorInspiredIdeasPrompt({
      channelName: String(ch.title),
      niche: niche || 'General',
      analyticsSummary,
      topPerformers: analytics.topPerformers.slice(0, 8).map(v => ({ title: v.title, views: v.view_count, videoId: v.video_id })),
      contentGaps: Array.isArray(contentGaps) ? contentGaps : [],
      userAngle,
    });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 4500,
      temperature: 0.6,
      spend: await makeSpendContext('competitor_inspired_ideas', { metadata: { competitor_id: id } }),
    });

    let parsed: unknown;
    try { parsed = parseLlmJson(raw); } catch {
      return NextResponse.json({ error: 'Failed to parse ideas', raw: raw.slice(0, 500) }, { status: 500 });
    }

    const ideas = (parsed as { ideas?: unknown[] }).ideas || [];
    return NextResponse.json({ ideas });
  } catch (err) {
    logger.error('Competitor ideas error', { detail: err instanceof Error ? err.message : String(err) });
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: `Ideas generation failed: ${detail}` }, { status: 500 });
  }
}
