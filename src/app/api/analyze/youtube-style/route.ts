import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export const maxDuration = 30;

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchThumbnailBase64(videoId: string): Promise<{ base64: string; mimeType: string } | null> {
  // Try quality levels from highest to lowest — mqdefault is almost always available
  // and is the same thumbnail the UI renders in the ref chip.
  const urls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/default.jpg`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      // Skip YouTube's grey "no thumbnail" placeholder — it's always exactly 1133 or
      // 1146 bytes. Using 1500 as a safe floor; real thumbnails are always larger.
      if (buf.byteLength < 1500) continue;
      return { base64: Buffer.from(buf).toString('base64'), mimeType: 'image/jpeg' };
    } catch {
      continue;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`yt-style:${getClientIP(req)}`, 15, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

    let body: { youtubeUrl?: string };
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { youtubeUrl } = body;
    if (!youtubeUrl) return NextResponse.json({ error: 'youtubeUrl is required' }, { status: 400 });

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400 });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 500 });

    // Fetch thumbnail (no YouTube API key needed — uses public CDN)
    const thumbnail = await fetchThumbnailBase64(videoId);
    if (!thumbnail) {
      return NextResponse.json({ error: 'Could not fetch video thumbnail. The video may be private or unavailable.' }, { status: 400 });
    }

    // Optionally enrich with title/channel via YouTube Data API
    let videoTitle = '';
    let channelTitle = '';
    if (process.env.YOUTUBE_API_KEY) {
      try {
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`,
          { signal: AbortSignal.timeout(5000) },
        );
        const data = await res.json();
        videoTitle = data.items?.[0]?.snippet?.title || '';
        channelTitle = data.items?.[0]?.snippet?.channelTitle || '';
      } catch { /* title enrichment is optional */ }
    }

    const client = new Anthropic({ apiKey });

    const textPrompt = [
      videoTitle && `Video: "${videoTitle}"${channelTitle ? ` by ${channelTitle}` : ''}`,
      `Analyze the visual style of this YouTube video thumbnail and describe it in 2–3 sentences to use as a production style brief.`,
      `Cover: color palette, mood and lighting, visual aesthetic (e.g. 2D animation, 3D CGI, cinematic live-action, motion graphics, documentary, stock photo), composition style, and any distinctive visual treatment or post-processing.`,
      `Be specific and actionable — a video editor reading this should know exactly what look to recreate.`,
      `Return ONLY the style description, no preamble.`,
    ].filter(Boolean).join('\n');

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumbnail.base64 } },
          { type: 'text', text: textPrompt },
        ],
      }],
    });

    const textBlock = message.content.find(b => b.type === 'text');
    const styleDescription = textBlock?.type === 'text' ? textBlock.text.trim() : '';
    if (!styleDescription) {
      return NextResponse.json({ error: 'Could not extract a style description from the thumbnail' }, { status: 500 });
    }

    return NextResponse.json({
      videoId,
      title: videoTitle,
      channelTitle,
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      styleDescription,
    });
  } catch (err: unknown) {
    console.error('YouTube style analysis error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Analysis failed' },
      { status: 500 },
    );
  }
}
