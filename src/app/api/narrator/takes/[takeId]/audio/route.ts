import { NextRequest } from 'next/server';
import { sql } from '@vercel/postgres';
import { streamFromNarrationBucket } from '@/lib/r2';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;
// Caching is driven by the response Cache-Control header below.

/**
 * Owner-side audio proxy. Same purpose as the token-side proxy: stream the
 * R2 object same-origin so wavesurfer's fetch doesn't need a configured
 * R2 CORS policy, and so the playback URL doesn't carry a presign expiry.
 *
 * Auth posture matches the rest of the owner-side narrator routes —
 * unauthenticated callers get through. The Phase 1 `withWorkspace`/auth
 * retrofit will gate this and its peers in one pass.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ takeId: string }> }) {
  try {
    const { takeId } = await params;

    const { rows } = await sql`SELECT r2_key FROM narrator_takes WHERE id = ${takeId} LIMIT 1`;
    const row = rows[0];
    if (!row) return new Response(JSON.stringify({ error: 'Take not found' }), { status: 404 });
    if (!row.r2_key) {
      return new Response(JSON.stringify({ error: 'Take is not stored in R2 (legacy upload)' }), { status: 409 });
    }

    const range = req.headers.get('range');
    const r2 = await streamFromNarrationBucket(row.r2_key as string, range);
    if (!r2.body) {
      return new Response(JSON.stringify({ error: 'Audio not found in storage' }), { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', r2.contentType || 'audio/mpeg');
    if (typeof r2.contentLength === 'number') headers.set('Content-Length', String(r2.contentLength));
    if (r2.acceptRanges) headers.set('Accept-Ranges', r2.acceptRanges);
    if (r2.contentRange) headers.set('Content-Range', r2.contentRange);
    headers.set('Cache-Control', 'private, max-age=86400, immutable');

    return new Response(r2.body, { status: r2.status, headers });
  } catch (err) {
    logger.error('GET narrator take audio proxy error', { detail: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ error: 'Failed to stream audio' }), { status: 500 });
  }
}
