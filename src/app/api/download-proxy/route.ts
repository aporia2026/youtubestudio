import { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';

// Same-origin download proxy. Streams bytes from an allowlisted upstream
// host (R2 buckets we own, plus the few AI providers we render assets
// from) and forces `Content-Disposition: attachment` so the browser saves
// instead of navigating. The client uses this whenever a download target
// is cross-origin — direct `fetch()` would trip CORS and `<a download>`
// is silently ignored cross-origin, both of which surface to users as a
// "Failed to fetch" toast.
//
// Tight host allowlist (not a generic open proxy): only hosts whose URLs
// we mint ourselves and serve to the same user. The presigned URL still
// authenticates the underlying request to the storage provider, so this
// route does not bypass any access control — it only re-frames the
// response so the browser handles it as a download.

const STATIC_HOST_SUFFIXES = [
  'r2.cloudflarestorage.com',
  'public.blob.vercel-storage.com',
  'replicate.delivery',
  'oaidalleapiprodscus.blob.core.windows.net',
];

const ENV_PUBLIC_HOST_KEYS = ['R2_PUBLIC_URL', 'R2_NARRATION_PUBLIC_URL', 'R2_IMAGES_PUBLIC_URL'];

/**
 * Remotion Lambda creates a serving S3 bucket per region with a name shape
 * `remotionlambda-<region-no-dashes>-<random>` and serves outputs at
 * `<bucket>.s3.<region>.amazonaws.com`. We allowlist only that exact
 * bucket-name prefix so the proxy stays tight — no random S3 bucket sneaks
 * through this check, only buckets Remotion provisioned for our renders.
 */
const REMOTION_LAMBDA_BUCKET_RE =
  /^remotionlambda-[a-z0-9]+-[a-z0-9]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/;

function isAllowedHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (STATIC_HOST_SUFFIXES.some(s => lower === s || lower.endsWith('.' + s))) return true;
  if (REMOTION_LAMBDA_BUCKET_RE.test(lower)) return true;
  for (const key of ENV_PUBLIC_HOST_KEYS) {
    const v = process.env[key];
    if (!v) continue;
    try {
      if (new URL(v).host.toLowerCase() === lower) return true;
    } catch {
      // Malformed env var — skip.
    }
  }
  return false;
}

function buildAttachmentHeader(name: string): string {
  // RFC 5987: filename* carries the real UTF-8 value, filename= is the
  // ASCII fallback. Strip CR/LF/quote/backslash to keep the header valid.
  const safeAscii = name.replace(/[\r\n"\\]/g, '_').replace(/[^\x20-\x7e]/g, '_').slice(0, 200) || 'download';
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const rawUrl = sp.get('u');
  const name = sp.get('name') || 'download';
  if (!rawUrl) return new Response('Missing "u" query parameter', { status: 400 });

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }
  if (target.protocol !== 'https:') {
    return new Response('Only https URLs are allowed', { status: 400 });
  }
  if (!isAllowedHost(target.host)) {
    return new Response('Host not in allowlist', { status: 403 });
  }

  // Forward Range so the browser can resume interrupted downloads end-to-end.
  const range = req.headers.get('range');
  const init: RequestInit = range ? { headers: { range } } : {};

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (e) {
    logger.warn('download-proxy upstream fetch failed', {
      host: target.host,
      detail: e instanceof Error ? e.message : String(e),
    });
    return new Response('Upstream fetch failed', { status: 502 });
  }

  if (upstream.status >= 400) {
    return new Response(`Upstream returned ${upstream.status}`, { status: upstream.status });
  }

  const headers = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Content-Disposition', buildAttachmentHeader(name));
  headers.set('Cache-Control', 'private, max-age=60');

  return new Response(upstream.body, { status: upstream.status, headers });
}
