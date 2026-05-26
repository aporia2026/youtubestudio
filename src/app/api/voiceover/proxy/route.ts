import { NextRequest, NextResponse } from 'next/server';
import { streamFromNarrationBucket } from '@/lib/r2';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Same-origin proxy for raw R2 narration URLs.
 *
 * The voiceover page hands `audioUrl` to a browser-side time-stretcher
 * (`src/lib/voiceover/time-stretch.ts`) which calls `fetch()` to pull the
 * audio into an AudioBuffer before SoundTouch can stretch it. R2 presigned
 * URLs don't carry an `Access-Control-Allow-Origin` header for this app's
 * origin, so the fetch is blocked by CORS and the download silently fails.
 *
 * Routes that already issue same-origin URLs (`/api/voiceovers/[id]/audio`,
 * used on the projectId path) don't hit this code; only the ad-hoc no-
 * project voiceover URLs do.
 *
 * Auth posture: unauthenticated, matching the sibling
 * `/api/voiceovers/[id]/audio` proxy. The presigned URL itself is the
 * access token — anyone with it can already download the audio. The proxy
 * only opens up *same-origin* access to bytes the caller can already reach
 * cross-origin via the signed URL; no new authority is granted.
 *
 * Hard constraints (defense in depth):
 *   - URL must parse and resolve to `<narrationBucket>.<account>.r2.cloudflarestorage.com`
 *   - The derived R2 key must be non-empty and must not contain path traversal
 *   - Bucket name comes from `R2_NARRATION_BUCKET_NAME` env (defaults to `narration`)
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: '`url` query param required' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  // SSRF-style guard: only narration-bucket R2 hosts are valid targets.
  // Anything else (internal network, GitHub raw, etc.) is rejected — the
  // proxy is not a generic fetch gateway.
  const narrationBucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
  const expectedHostPrefix = `${narrationBucket}.`;
  if (
    !parsed.hostname.startsWith(expectedHostPrefix) ||
    !parsed.hostname.endsWith('.r2.cloudflarestorage.com')
  ) {
    return NextResponse.json(
      { error: 'URL is not an R2 narration URL' },
      { status: 400 },
    );
  }

  const r2Key = parsed.pathname.replace(/^\/+/, '');
  if (!r2Key || r2Key.includes('..')) {
    return NextResponse.json({ error: 'Invalid R2 key' }, { status: 400 });
  }

  try {
    const range = req.headers.get('range');
    const r2 = await streamFromNarrationBucket(r2Key, range);
    if (!r2.body) {
      return NextResponse.json({ error: 'Audio not found in storage' }, { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', r2.contentType || 'audio/mpeg');
    if (typeof r2.contentLength === 'number') headers.set('Content-Length', String(r2.contentLength));
    if (r2.acceptRanges) headers.set('Accept-Ranges', r2.acceptRanges);
    if (r2.contentRange) headers.set('Content-Range', r2.contentRange);
    // Same caching posture as /api/voiceovers/[id]/audio — narration
    // objects are content-addressed by timestamp + voiceId, so once a
    // proxy URL resolves to bytes, those bytes don't change.
    headers.set('Cache-Control', 'private, max-age=86400, immutable');

    return new Response(r2.body, { status: r2.status, headers });
  } catch (err) {
    logger.error('GET voiceover/proxy error', {
      detail: err instanceof Error ? err.message : String(err),
      key_prefix: r2Key.split('/')[0],
    });
    return NextResponse.json({ error: 'Failed to stream audio' }, { status: 500 });
  }
}
