import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { generateText, getDefaultModel } from '@/lib/ai';
import { channelAnalysisPrompt } from '@/lib/prompts';
import { fetchChannelVideos } from '@/lib/youtube';
import { makeSpendContext } from '@/lib/ai-spend';
import { domainErrorResponse } from '@/lib/route-helpers';

export const maxDuration = 300;

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

    // Fetch recent videos (use per-channel API key if available)
    const creds = typeof channel.api_credentials === 'string' ? JSON.parse(channel.api_credentials) : channel.api_credentials;
    const channelApiKey = creds?.youtube_api_key;
    const videos = await fetchChannelVideos(channel.channel_id, 30, channelApiKey || undefined);
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
      modelId: modelId || getDefaultModel().id,
      prompt: user,
      systemPrompt: system,
      maxTokens: 3000,
      spend: await makeSpendContext('channel_analysis', { channelDbId: id }),
    });

    return NextResponse.json({ analysis });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'channels: analyze',
      fallbackMessage: 'Could not analyze channel — please try again.',
    });
  }
}
