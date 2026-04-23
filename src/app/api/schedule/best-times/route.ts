import { NextRequest, NextResponse } from 'next/server';
import { getValidAccessToken } from '@/lib/google-oauth';
import { listMyVideosOAuth } from '@/lib/youtube';

export const maxDuration = 30;

/** GET /api/schedule/best-times?channel_id=<uuid>
 *  Fetches the channel's recent uploads (OAuth) and returns a 7x24 grid of
 *  median view counts bucketed by day-of-week × local hour of upload.
 *  Missing cells are null so the UI renders them neutral. */
export async function GET(req: NextRequest) {
  const channelDbId = req.nextUrl.searchParams.get('channel_id');
  if (!channelDbId) return NextResponse.json({ error: 'channel_id required' }, { status: 400 });

  const accessToken = await getValidAccessToken(channelDbId);
  if (!accessToken) {
    return NextResponse.json({ error: 'YouTube not connected on this channel.' }, { status: 401 });
  }

  try {
    const videos = await listMyVideosOAuth(accessToken, 50);
    // Bucket in UTC so Vercel-server TZ (UTC) and an eventual user TZ don't
    // disagree. Returned grid is { dow: UTC day-of-week, hr: UTC hour }; the
    // UI re-localizes for display.
    const buckets: number[][][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => [] as number[]));
    for (const v of videos) {
      if (!v.publishedAt) continue;
      const d = new Date(v.publishedAt);
      const dow = d.getUTCDay();
      const hr = d.getUTCHours();
      buckets[dow][hr].push(v.viewCount);
    }
    const grid: (number | null)[][] = buckets.map(row =>
      row.map(cell => {
        if (cell.length === 0) return null;
        const sorted = [...cell].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      }),
    );
    // Summary: top 3 (dow, hr) cells by median views.
    const flat: Array<{ dow: number; hr: number; value: number }> = [];
    grid.forEach((row, dow) => row.forEach((v, hr) => { if (v != null) flat.push({ dow, hr, value: v }); }));
    flat.sort((a, b) => b.value - a.value);
    const top = flat.slice(0, 3);

    return NextResponse.json({
      sample_size: videos.length,
      tz: 'UTC',
      grid,
      top,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
