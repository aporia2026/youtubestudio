import { NextRequest, NextResponse } from 'next/server';
import { listCachedReferences } from '@/lib/reference-cache-db';
import { logger } from '@/lib/logger';

/**
 * Browse the user's saved reference videos. Returns the cached metadata
 * + analysis for everything that's been deep-analyzed at least once.
 *
 * Query params:
 *   - q: optional search string (matches title / channel / notes)
 *   - limit: default 50, max 200
 *   - offset: pagination
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const search = sp.get('q') || undefined;
    const limit = Math.min(Math.max(parseInt(sp.get('limit') || '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(sp.get('offset') || '0', 10) || 0, 0);

    const rows = await listCachedReferences({ search, limit, offset });
    // Trim payload — return what the picker UI needs, drop bulky raw analysis JSON.
    const items = rows.map(r => ({
      id: r.id,
      youtube_id: r.youtube_id,
      url: r.url,
      title: r.title,
      channel_title: r.channel_title,
      view_count: r.view_count,
      duration_seconds: r.duration_seconds,
      thumbnail_url: r.thumbnail_url,
      has_analysis: !!r.style_analysis,
      use_count: r.use_count,
      last_used_at: r.last_used_at,
      created_at: r.created_at,
      notes: r.notes,
      user_tags: r.user_tags,
    }));

    return NextResponse.json({ items });
  } catch (err) {
    logger.error('GET reference-library error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to list references' }, { status: 500 });
  }
}
