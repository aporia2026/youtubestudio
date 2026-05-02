import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { generateText, getModelById } from '@/lib/ai';
import { competitorDeepAnalysisPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { computeAnalytics, VideoRow } from '@/lib/competitor-analytics';

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { limited } = checkRateLimit(`comp-analyze:${getClientIP(req)}`, 5, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  try {
    await ensureCompetitorSchema();

    let body: { modelId?: string; niche?: string };
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { modelId, niche } = body;
    if (!modelId) return NextResponse.json({ error: 'modelId required' }, { status: 400 });
    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const channel = await sql`SELECT * FROM competitor_channels WHERE id = ${id}`;
    if (channel.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const ch = channel.rows[0];

    const videosRes = await sql`
      SELECT video_id, title, description, published_at, view_count, like_count, comment_count,
             duration, duration_seconds, category_id, tags, top_comments, outlier_score
      FROM competitor_videos
      WHERE competitor_id = ${id}
      ORDER BY published_at DESC
      LIMIT 200
    `;

    if (videosRes.rows.length === 0) {
      return NextResponse.json({ error: 'No videos synced yet — sync the channel first' }, { status: 400 });
    }

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
      top_comments: Array.isArray(r.top_comments) ? r.top_comments : (typeof r.top_comments === 'string' ? JSON.parse(r.top_comments || '[]') : []),
    }));

    const analytics = computeAnalytics(videos);

    const formatVideo = (v: VideoRow) => ({
      title: v.title,
      views: v.view_count,
      likes: v.like_count,
      comments: v.comment_count,
      durationSec: v.duration_seconds,
      tags: v.tags,
      publishedAt: v.published_at,
      videoId: v.video_id,
    });

    const sampleComments = analytics.topPerformers
      .filter(v => v.top_comments && v.top_comments.length > 0)
      .slice(0, 3)
      .map(v => ({
        videoTitle: v.title,
        videoId: v.video_id,
        comments: (v.top_comments || []).slice(0, 10).map(c => ({ text: c.text, likes: c.likeCount })),
      }));

    // Trim analytics bundle (some arrays are large) — keep essential data
    const slimAnalytics = {
      dataset: analytics.dataset,
      performance: analytics.performance,
      cadence: analytics.cadence,
      duration: analytics.duration,
      titles: {
        ...analytics.titles,
        topWordsOverall: analytics.titles.topWordsOverall.slice(0, 10),
      },
      tags: {
        avgTagsPerVideo: analytics.tags.avgTagsPerVideo,
        topTags: analytics.tags.topTags.slice(0, 10),
        tagsInTopPerformers: analytics.tags.tagsInTopPerformers,
        tagsInBottomPerformers: analytics.tags.tagsInBottomPerformers,
      },
      descriptions: analytics.descriptions,
      categories: analytics.categories,
      trend: analytics.trend,
    };

    const { system, user } = competitorDeepAnalysisPrompt({
      channelName: String(ch.title),
      subscriberCount: Number(ch.subscriber_count) || 0,
      niche: niche || 'General',
      analyticsJson: JSON.stringify(slimAnalytics, null, 2),
      topVideos: analytics.topPerformers.map(formatVideo),
      bottomVideos: analytics.bottomPerformers.map(formatVideo),
      outlierVideos: analytics.outliers.slice(0, 10).map(v => ({
        title: v.title,
        views: v.view_count,
        outlierScore: analytics.performance.medianViews > 0 ? v.view_count / analytics.performance.medianViews : 0,
        videoId: v.video_id,
      })),
      sampleComments,
    });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 8000,
      temperature: 0.3,
    });

    let analysis;
    try {
      analysis = parseLlmJson(raw);
    } catch {
      return NextResponse.json({ error: 'Failed to parse analysis', raw: raw.slice(0, 500) }, { status: 500 });
    }

    return NextResponse.json({ analysis, analytics });
  } catch (err) {
    console.error('Competitor analysis error:', err);
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: `Analysis failed: ${detail}` }, { status: 500 });
  }
}
