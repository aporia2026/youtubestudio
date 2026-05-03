import { NextRequest } from 'next/server';
import { sql } from '@vercel/postgres';
import { getAssignmentByToken } from '@/lib/narrator-db';
import { streamFromNarrationBucket } from '@/lib/r2';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
// Audio responses are streamed from R2; we don't buffer them in serverless
// memory. A long maxDuration is still useful in case the client downloads
// a large file slowly (mobile networks, etc.).
export const maxDuration = 300;
// Caching is driven by the Cache-Control header we emit on each response
// (see below) — segment-level `revalidate` doesn't apply cleanly to a
// streaming Route Handler.

/**
 * Stream a take's audio through our origin so the browser doesn't need
 * R2-bucket CORS configured to play / waveform-analyse it. Wavesurfer
 * fetches the whole file to compute peaks; the native <audio> element
 * doesn't need CORS, but wavesurfer's fetch does. Proxying makes the
 * URL same-origin, sidestepping the dance entirely — and it doesn't
 * expire the way a presigned R2 URL does.
 *
 * Range requests are forwarded verbatim so seek stays responsive.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; takeId: string }> }) {
  try {
    const { token, takeId } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return new Response(JSON.stringify({ error: 'Invalid link' }), { status: 404 });

    // Verify the take belongs to this assignment + grab the r2_key.
    const { rows } = await sql`
      SELECT t.r2_key
      FROM narrator_takes t
      JOIN narrator_sections s ON s.id = t.section_id
      WHERE t.id = ${takeId} AND s.assignment_id = ${assignment.id}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return new Response(JSON.stringify({ error: 'Take not found in this assignment' }), { status: 403 });
    if (!row.r2_key) {
      // Legacy Vercel Blob takes don't have an r2_key — those URLs were
      // already public and shouldn't hit this proxy. Tell the caller to
      // fall back to the direct audio_url.
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
    // Long-lived cache keyed by takeId — audio bytes for a take never change
    // in place (Replace creates a new take row with a new id).
    headers.set('Cache-Control', 'private, max-age=86400, immutable');

    return new Response(r2.body, { status: r2.status, headers });
  } catch (err) {
    logger.error('GET narrate take audio proxy error', { detail: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ error: 'Failed to stream audio' }), { status: 500 });
  }
}
