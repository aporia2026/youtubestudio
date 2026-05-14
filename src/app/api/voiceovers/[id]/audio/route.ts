import { NextRequest, NextResponse } from 'next/server';
import { get as blobGet } from '@vercel/blob';
import { sql } from '@/lib/db';
import { streamFromNarrationBucket } from '@/lib/r2';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Same-origin audio proxy for voiceover media_assets. Mirrors the existing
 * `/api/narrator/takes/[takeId]/audio` pattern that the narrator portal
 * uses for take review — Remotion's `<Audio>` component (and any browser
 * fetch that hits the file for decoding rather than just streaming) trips
 * on R2's CORS and on presigned-URL expiry during a long preview session.
 * Proxying the byte stream same-origin sidesteps both.
 *
 * For Vercel Blob-backed rows (stitched narrator output, ElevenLabs takes
 * republished through media_assets) the proxy fetches the Blob bytes
 * server-side via the @vercel/blob SDK so the request is authenticated
 * — a 302 redirect to `row.url` works when the Blob store is configured
 * for public access but returns 401 on a private-access store, and
 * private is now Vercel's default for newly provisioned stores.
 *
 * Range requests are forwarded verbatim on the R2 path so audio seek
 * stays cheap. On the Blob path Range isn't yet plumbed through the SDK,
 * so browser <audio> elements download the whole file once and seek
 * client-side. Acceptable for typical voiceover sizes (~10 MB for
 * 14-minute audio); revisit if we start storing longer files in Blob.
 *
 * Auth posture: unauthenticated, matching the narrator-side audio proxies.
 * The media_asset UUID is the access token — random enough that brute force
 * is infeasible, and unguarded access is what lets server-side renders
 * (which run without the user's session cookie) fetch the same URL.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Guard against the UUID cast throwing on a non-UUID path segment.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const { rows } = await sql<{
      url: string | null;
      r2_bucket: string | null;
      r2_key: string | null;
      type: string;
    }>`
      SELECT url, r2_bucket, r2_key, type
      FROM media_assets
      WHERE id = ${id}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (row.type !== 'voiceover') return NextResponse.json({ error: 'Not a voiceover' }, { status: 400 });

    // No R2 backing — fetch from Blob via the SDK so it works whether
    // the store is configured for public or private access. The
    // `access: 'private'` parameter doesn't restrict to private blobs;
    // it tells the SDK to attach the BLOB_READ_WRITE_TOKEN, which the
    // CDN accepts for both modes.
    const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
    if (!row.r2_key || row.r2_bucket !== narrationBucket) {
      if (!row.url) return NextResponse.json({ error: 'No audio url' }, { status: 404 });
      let blobRes: Awaited<ReturnType<typeof blobGet>>;
      try {
        blobRes = await blobGet(row.url, { access: 'private' });
      } catch (err) {
        logger.error('voiceovers/[id]/audio: Blob get threw', {
          id, detail: err instanceof Error ? err.message : String(err),
        });
        return NextResponse.json({ error: 'Audio fetch failed' }, { status: 502 });
      }
      if (!blobRes || !blobRes.stream) {
        return NextResponse.json({ error: 'Audio not found in Blob store' }, { status: 404 });
      }
      const headers = new Headers();
      headers.set('Content-Type', blobRes.blob?.contentType || 'audio/mpeg');
      if (typeof blobRes.blob?.size === 'number') {
        headers.set('Content-Length', String(blobRes.blob.size));
      }
      headers.set('Cache-Control', 'private, max-age=86400, immutable');
      return new Response(blobRes.stream as unknown as ReadableStream<Uint8Array>, {
        status: 200,
        headers,
      });
    }

    // R2-backed — stream the bytes through, echoing the range headers so
    // the audio element can seek without re-fetching the whole file.
    const range = req.headers.get('range');
    const r2 = await streamFromNarrationBucket(row.r2_key, range);
    if (!r2.body) return NextResponse.json({ error: 'Audio not found in storage' }, { status: 404 });

    const headers = new Headers();
    headers.set('Content-Type', r2.contentType || 'audio/mpeg');
    if (typeof r2.contentLength === 'number') headers.set('Content-Length', String(r2.contentLength));
    if (r2.acceptRanges) headers.set('Accept-Ranges', r2.acceptRanges);
    if (r2.contentRange) headers.set('Content-Range', r2.contentRange);
    headers.set('Cache-Control', 'private, max-age=86400, immutable');

    return new Response(r2.body, { status: r2.status, headers });
  } catch (err) {
    logger.error('GET voiceovers/[id]/audio error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to stream audio' }, { status: 500 });
  }
}
