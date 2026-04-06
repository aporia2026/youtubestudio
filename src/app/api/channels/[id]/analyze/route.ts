import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { generateText } from '@/lib/ai';
import { channelAnalysisPrompt } from '@/lib/prompts';
import { fetchChannelVideos } from '@/lib/youtube';

export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { modelId } = await req.json().catch(() => ({}));

  try {
    const ch = await sql`SELECT * FROM channels WHERE id = ${id}`;
    if (!ch.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const channel = ch.rows[0];

    if (!channel.channel_id) {
      return NextResponse.json({
        analysis: 'YouTube API key required to analyze channel videos. Add YOUTUBE_API_KEY to your environment variables.',
      });
    }

    // Fetch recent videos
    const videos = await fetchChannelVideos(channel.channel_id, 30);
    if (!videos.length) {
      return NextResponse.json({ analysis: 'No videos found for analysis.' });
    }

    const { system, user } = channelAnalysisPrompt({
      name: channel.name,
      niche: channel.niche || 'General',
      videos: videos.map(v => ({
        title: v.title,
        views: v.viewCount,
        likes: v.likeCount,
        date: new Date(v.publishedAt).toLocaleDateString(),
      })),
    });

    const analysis = await generateText({
      modelId: modelId || 'claude-opus-4-6',
      prompt: user,
      systemPrompt: system,
      maxTokens: 3000,
    });

    return NextResponse.json({ analysis });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Analysis failed' }, { status: 500 });
  }
}
