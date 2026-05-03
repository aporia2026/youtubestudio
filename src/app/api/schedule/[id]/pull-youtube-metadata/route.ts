import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extracts a canonical video id from a user-supplied URL. Strict:
 *  1. Must parse as a URL with https/http scheme.
 *  2. Host must be a youtube.com variant or youtu.be.
 *  3. Video id must match the canonical 11-character alphabet.
 *
 *  Returning null rejects everything else — previous regex-substring match
 *  accepted `https://attacker.example/youtube.com/watch?v=…`. */
function extractVideoId(rawUrl: string): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let candidate: string | null = null;
  if (host === 'youtu.be') {
    candidate = u.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (u.pathname === '/watch') {
    candidate = u.searchParams.get('v');
  } else if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/shorts/')) {
    candidate = u.pathname.split('/')[2] ?? null;
  }
  return candidate && VIDEO_ID_RE.test(candidate) ? candidate : null;
}

/** POST /api/schedule/[id]/pull-youtube-metadata
 *  Pulls title + description + tags from YouTube Data API and writes them
 *  onto the schedule item. Non-destructive: only writes fields that aren't
 *  already filled out by the user, so a hand-curated title isn't lost.
 *  Requires YOUTUBE_API_KEY. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { limited } = checkRateLimit(`pull-yt:${getClientIP(req)}`, 20, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    await ensureScheduleSchema();
    if (!process.env.YOUTUBE_API_KEY) {
      return NextResponse.json({ error: 'YOUTUBE_API_KEY is not configured on the server' }, { status: 500 });
    }
    const row = await sql`SELECT youtube_url, title, yt_description, yt_tags FROM schedule_items WHERE id = ${id}`;
    if (!row.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const url: string | null = row.rows[0].youtube_url;
    if (!url) return NextResponse.json({ error: 'No YouTube URL set on this item' }, { status: 400 });

    const videoId = extractVideoId(url);
    if (!videoId) return NextResponse.json({ error: 'Could not extract a valid video ID from the URL' }, { status: 400 });

    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${process.env.YOUTUBE_API_KEY}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const data = await res.json();
    const snippet = data.items?.[0]?.snippet;
    if (!snippet) return NextResponse.json({ error: 'Video not found on YouTube (may be private or removed)' }, { status: 404 });

    const ytTitle: string = typeof snippet.title === 'string' ? snippet.title : '';
    const ytDescription: string = typeof snippet.description === 'string' ? snippet.description : '';
    const ytTags: string[] = Array.isArray(snippet.tags) ? snippet.tags.filter((t: unknown) => typeof t === 'string') : [];

    // Only overwrite fields the user hasn't curated. Preserves hand-tuned
    // titles and descriptions when YouTube's snippet is poorer.
    const existingTitle: string = row.rows[0].title ?? '';
    const existingDesc: string = row.rows[0].yt_description ?? '';
    const existingTags: unknown = row.rows[0].yt_tags;
    const existingTagsLen = Array.isArray(existingTags) ? existingTags.length : 0;

    const newTitle = !existingTitle.trim() && ytTitle ? ytTitle : existingTitle;
    const newDesc = !existingDesc.trim() && ytDescription ? ytDescription : existingDesc;
    const newTags = existingTagsLen === 0 && ytTags.length ? ytTags : (existingTags ?? []);

    await sql`
      UPDATE schedule_items SET
        title          = ${newTitle || 'Untitled'},
        yt_description = ${newDesc},
        yt_tags        = ${JSON.stringify(newTags)}::jsonb,
        updated_at     = NOW()
      WHERE id = ${id}
    `;

    const wrote = {
      title: newTitle !== existingTitle,
      description: newDesc !== existingDesc,
      tags: JSON.stringify(newTags) !== JSON.stringify(existingTags ?? []),
    };
    return NextResponse.json({
      // Return both the pulled values and what actually got written so the
      // client can toast honestly ("Pulled title; description preserved").
      pulled: { title: ytTitle, description: ytDescription, tags: ytTags },
      applied: { title: newTitle, description: newDesc, tags: newTags },
      wrote,
    });
  } catch (err) {
    logger.error('POST /api/schedule/[id]/pull-youtube-metadata', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
