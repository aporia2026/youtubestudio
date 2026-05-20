import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { streamFromReviewBucket } from '@/lib/r2';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Same-origin video proxy for broll clips. Mirrors the existing
 * voiceover audio proxy at `/api/voiceovers/[id]/audio`.
 *
 * Why this exists: Remotion's `<OffthreadVideo>` chokes on R2 presigned
 * URLs that carry many query parameters (X-Amz-Algorithm, X-Amz-Date,
 * X-Amz-Signature, etc.). The HTTP GET works (we verified with a probe
 * — status 206, video/mp4) but OffthreadVideo's URL cache key handling
 * silently produces empty frames downstream. By proxying the bytes
 * through a clean same-origin URL `/api/broll/<id>/video` with NO query
 * params, Remotion's cache key is stable and the frames render.
 *
 * Auth posture: unauthenticated, matching the narrator-side audio
 * proxies. The clip UUID is the access token — random enough that
 * brute force is infeasible, and unguarded access is what lets
 * server-side renders (which run without the user's session cookie)
 * fetch the same URL.
 *
 * Range requests are forwarded verbatim so the renderer's chunked
 * fetch behaviour stays cheap.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Guard against the UUID cast throwing on a non-UUID path segment.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    // Look up the clip's R2 key — only published rows with a blob_pathname
    // are eligible. Status check (`status = 'ready'`) prevents serving
    // in-flight or failed clips. No workspace scope: the random UUID is
    // the access token, matching the voiceover proxy's posture so
    // server-side renders without a session cookie can still fetch.
    const { rows } = await sql<{
      blob_pathname: string | null;
      video_url: string | null;
      status: string;
    }>`
      SELECT blob_pathname, video_url, status
      FROM broll_clips
      WHERE id = ${id}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (row.status !== 'ready') {
      return NextResponse.json({ error: `Clip not ready (status=${row.status})` }, { status: 409 });
    }
    if (!row.blob_pathname) {
      // R2 upload didn't complete for this clip — fall back to redirecting
      // to the stored video_url (the Kie-hosted original) so the renderer
      // at least has something to fetch. Less durable but not broken.
      if (row.video_url) {
        return NextResponse.redirect(row.video_url, { status: 307 });
      }
      return NextResponse.json({ error: 'No source bytes for this clip' }, { status: 404 });
    }

    // R2-backed — stream the bytes through, echoing the range headers so
    // the renderer's chunked reads don't re-fetch the whole file. Range
    // forwarding is what makes `<OffthreadVideo>` cheap.
    const range = req.headers.get('range');
    const r2 = await streamFromReviewBucket(row.blob_pathname, range);
    if (!r2.body) return NextResponse.json({ error: 'Bytes not in storage' }, { status: 404 });

    const headers = new Headers();
    headers.set('Content-Type', r2.contentType || 'video/mp4');
    if (typeof r2.contentLength === 'number') {
      headers.set('Content-Length', String(r2.contentLength));
    }
    if (r2.acceptRanges) headers.set('Accept-Ranges', r2.acceptRanges);
    if (r2.contentRange) headers.set('Content-Range', r2.contentRange);
    // Cache aggressively. broll clip bytes are immutable once published —
    // the clip id changes when content does — so a long max-age is safe.
    headers.set('Cache-Control', 'private, max-age=86400, immutable');

    return new Response(r2.body, { status: r2.status, headers });
  } catch (err) {
    logger.error('GET broll/[id]/video error', {
      id,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Failed to stream video' }, { status: 500 });
  }
}
