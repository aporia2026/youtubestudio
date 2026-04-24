import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';

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

/** POST /api/schedule/[id]/pull-youtube-metadata
 *  Reads the item's youtube_url, pulls title + description + tags from the
 *  YouTube Data API, and writes them onto the schedule item so the creator
 *  doesn't have to copy them back manually. Requires YOUTUBE_API_KEY. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    if (!process.env.YOUTUBE_API_KEY) {
      return NextResponse.json({ error: 'YOUTUBE_API_KEY is not configured on the server' }, { status: 500 });
    }
    const row = await sql`SELECT youtube_url FROM schedule_items WHERE id = ${id}`;
    if (!row.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const url: string | null = row.rows[0].youtube_url;
    if (!url) return NextResponse.json({ error: 'No YouTube URL set on this item' }, { status: 400 });
    const videoId = extractVideoId(url);
    if (!videoId) return NextResponse.json({ error: 'Could not extract a video ID from the URL' }, { status: 400 });

    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const data = await res.json();
    const snippet = data.items?.[0]?.snippet;
    if (!snippet) return NextResponse.json({ error: 'Video not found on YouTube (may be private or removed)' }, { status: 404 });

    const title: string = snippet.title ?? '';
    const description: string = snippet.description ?? '';
    const tags: string[] = Array.isArray(snippet.tags) ? snippet.tags : [];

    await sql`
      UPDATE schedule_items SET
        title          = ${title || 'Untitled'},
        yt_description = ${description},
        yt_tags        = ${JSON.stringify(tags)}::jsonb,
        updated_at     = NOW()
      WHERE id = ${id}
    `;

    return NextResponse.json({ title, description, tags });
  } catch (err) {
    console.error('POST /api/schedule/[id]/pull-youtube-metadata', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
