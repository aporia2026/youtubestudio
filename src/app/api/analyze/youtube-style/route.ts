import { NextRequest, NextResponse } from 'next/server';
import { analyzeYouTubeVideo } from '@/lib/ai';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

// Gemini natively ingests the YouTube video (not just the thumbnail), which takes
// noticeably longer than a single image call — give it headroom.
export const maxDuration = 60;

// Fast + cheap Gemini model with native video input. Changing this is safe as long
// as the new ID is a Google-provider Gemini model (see modelSupportsVideo).
const STYLE_ANALYSIS_MODEL = 'gemini-2.5-flash';

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

export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`yt-style:${getClientIP(req)}`, 15, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    let body: { youtubeUrl?: string };
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { youtubeUrl } = body;
    if (!youtubeUrl) return NextResponse.json({ error: 'youtubeUrl is required' }, { status: 400 });

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400 });
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Optional enrichment — title/channel via YouTube Data API. Best-effort: a missing
    // key or a failed lookup does not block analysis.
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
      } catch { /* enrichment is optional */ }
    }

    const prompt = [
      videoTitle && `Video: "${videoTitle}"${channelTitle ? ` by ${channelTitle}` : ''}`,
      `Analyze the visual style of this YouTube video and describe it in 2–3 sentences to use as a production style brief.`,
      `Cover: color palette, mood and lighting, visual aesthetic (e.g. 2D animation, 3D CGI, cinematic live-action, motion graphics, documentary, stock photo), composition style, pacing/editing rhythm, and any distinctive visual treatment or post-processing.`,
      `Be specific and actionable — a video editor reading this should know exactly what look to recreate.`,
      `Return ONLY the style description, no preamble.`,
    ].filter(Boolean).join('\n');

    const styleDescription = (await analyzeYouTubeVideo({
      modelId: STYLE_ANALYSIS_MODEL,
      youtubeUrl: canonicalUrl,
      prompt,
      maxTokens: 400,
      temperature: 0.3,
    })).trim();

    if (!styleDescription) {
      return NextResponse.json({ error: 'Gemini returned an empty style description — the video may be private or restricted.' }, { status: 502 });
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
