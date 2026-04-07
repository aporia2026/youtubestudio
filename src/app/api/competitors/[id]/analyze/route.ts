import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { generateText, getModelById } from '@/lib/ai';
import { competitorOutlierPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';

export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { limited } = checkRateLimit(`comp-analyze:${getClientIP(req)}`, 5, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  try {
    const { modelId, niche } = await req.json();
    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const channel = await sql`SELECT * FROM competitor_channels WHERE id = ${id}`;
    if (channel.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const videos = await sql`
      SELECT title, view_count, like_count, comment_count, published_at, outlier_score, engagement_rate
      FROM competitor_videos
      WHERE competitor_id = ${id}
      ORDER BY published_at DESC
      LIMIT 50
    `;

    if (videos.rows.length === 0) {
      return NextResponse.json({ error: 'No videos synced yet — sync the channel first' }, { status: 400 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = videos.rows;
    const viewCounts = rows.map(v => Number(v.view_count) || 0).sort((a, b) => a - b);
    const mid = Math.floor(viewCounts.length / 2);
    const medianViews = viewCounts.length % 2 ? viewCounts[mid] : Math.round((viewCounts[mid - 1] + viewCounts[mid]) / 2);
    const avgEngagement = rows.reduce((sum, v) => sum + (Number(v.engagement_rate) || 0), 0) / rows.length;

    const { system, user } = competitorOutlierPrompt({
      channelName: channel.rows[0].title as string,
      niche: niche || 'General',
      videos: rows.map(v => ({
        title: String(v.title),
        views: Number(v.view_count) || 0,
        likes: Number(v.like_count) || 0,
        comments: Number(v.comment_count) || 0,
        date: new Date(v.published_at).toLocaleDateString(),
        outlierScore: Number(v.outlier_score) || 0,
      })),
      medianViews,
      avgEngagement,
    });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 6000,
      temperature: 0.5,
    });

    let analysis;
    try {
      analysis = parseLlmJson(raw);
    } catch {
      return NextResponse.json({ error: 'Failed to parse analysis — try again' }, { status: 500 });
    }

    return NextResponse.json({ analysis });
  } catch (err) {
    console.error('Competitor analysis error:', err);
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
  }
}
