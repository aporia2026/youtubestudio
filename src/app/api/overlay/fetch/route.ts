import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';

/**
 * POST /api/overlay/fetch
 *
 * Source a real-world image overlay for a production-doc row whose
 * `overlay_stock_terms` field is populated. Pipeline:
 *
 *   1. Smart query rewriting — append "transparent png" / "high resolution" /
 *      "clean background" based on what the term implies, so the search hits
 *      cleaner sources than the raw terms would.
 *   2. Brave Image Search for the rewritten query.
 *   3. Pick top result with width ≥ 400 px, prefer PNG over JPG.
 *   4. Download with a hard 5 MB cap, 5 s timeout, image/* content-type check.
 *   5. Background removal via Replicate `briaai/rmbg-2.0` — produces a clean
 *      transparent PNG even when the source was a logo on a white box.
 *   6. Upload to R2 at `overlays/<workspaceId>/<sha256-of-terms>.png` so the
 *      next call with the same terms in the same workspace short-circuits.
 *   7. Return the R2 URL.
 *
 * Failures degrade gracefully — Brave-no-results, download-too-big, RMBG-down
 * each return `{ overlayUrl: null, reason: "..." }` with HTTP 200 so the
 * caller can render the still on its own without breaking the row.
 *
 * Required env vars:
 *   - BRAVE_SEARCH_API_KEY  — Brave Search API (image endpoint)
 *   - REPLICATE_API_TOKEN   — Replicate API token
 *   - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY — already present
 *
 * Per-overlay cost: ~$0.003 Brave + ~$0.005 Replicate = ~$0.008.
 */

export const maxDuration = 60;

const BRAVE_IMAGE_SEARCH = 'https://api.search.brave.com/res/v1/images/search';
const REPLICATE_RMBG_URL =
  'https://api.replicate.com/v1/models/briaai/rmbg-2.0/predictions';
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5_000;
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

type GracefulResult =
  | { overlayUrl: string; cached: boolean; sourceUrl?: string }
  | { overlayUrl: null; reason: string };

function rewriteQuery(rawTerms: string): string {
  const lc = rawTerms.toLowerCase();
  const modifiers: string[] = [];
  if (/\blogo\b/.test(lc)) modifiers.push('transparent png');
  else if (/\bscreenshot\b/.test(lc)) modifiers.push('high resolution');
  else if (/\bphoto(graph)?\b/.test(lc)) modifiers.push('clean background');
  // Use only the first comma-separated term as the primary search noun —
  // additional terms in the field are noise / variants ("Apple logo,
  // company branding") that hurt search precision when concatenated.
  const primary = rawTerms.split(',')[0]?.trim() || rawTerms.trim();
  return modifiers.length > 0 ? `${primary} ${modifiers.join(' ')}` : primary;
}

function cacheKey(workspaceId: string, rawTerms: string): string {
  const hash = createHash('sha256')
    .update(`${workspaceId}:${rawTerms.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
  return `overlays/${workspaceId}/${hash}.png`;
}

async function braveImageSearch(query: string, apiKey: string): Promise<{
  url: string;
  width: number;
  height: number;
  title: string;
} | null> {
  const url = `${BRAVE_IMAGE_SEARCH}?q=${encodeURIComponent(query)}&safesearch=strict&count=15&country=us`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`Brave Search failed (${res.status})`);
  }
  const data = (await res.json()) as {
    results?: Array<{
      properties?: { url?: string };
      thumbnail?: { src?: string };
      title?: string;
      width?: number;
      height?: number;
    }>;
  };
  const results = data.results ?? [];
  // Pick the first result with width ≥ 400 AND a usable URL. Prefer PNG.
  const candidates = results
    .map((r) => ({
      url: r.properties?.url || r.thumbnail?.src || '',
      width: r.width ?? 0,
      height: r.height ?? 0,
      title: r.title ?? '',
    }))
    .filter((r) => r.url && r.width >= 400);
  const png = candidates.find((c) => /\.png(\?|$)/i.test(c.url));
  return png ?? candidates[0] ?? null;
}

async function downloadImage(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
    const contentType = (res.headers.get('content-type') || '').toLowerCase().split(';')[0]!.trim();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new Error(`Unsupported content-type: ${contentType || 'unknown'}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(`Image too large (> ${MAX_DOWNLOAD_BYTES} bytes)`);
      }
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks), contentType };
  } finally {
    clearTimeout(timer);
  }
}

async function removeBackground(imageUrl: string, replicateToken: string): Promise<Buffer> {
  // `Prefer: wait` blocks the response until the prediction finishes (up to
  // 60 s) so we don't have to poll. RMBG-2.0 typically completes in 1-2 s.
  const create = await fetch(REPLICATE_RMBG_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${replicateToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=30',
    },
    body: JSON.stringify({ input: { image: imageUrl } }),
  });
  if (!create.ok) {
    throw new Error(`Replicate RMBG failed (${create.status})`);
  }
  const data = (await create.json()) as {
    status?: string;
    output?: string | string[];
    error?: string;
  };
  if (data.error) throw new Error(`Replicate RMBG: ${data.error}`);
  if (data.status && data.status !== 'succeeded') {
    throw new Error(`Replicate RMBG did not complete (status: ${data.status})`);
  }
  const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!outputUrl) throw new Error('Replicate RMBG returned no output URL');
  const fetched = await fetch(outputUrl);
  if (!fetched.ok) throw new Error(`Failed to fetch RMBG output (${fetched.status})`);
  return Buffer.from(await fetched.arrayBuffer());
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited } = checkRateLimit(`overlay-fetch:${getClientIP(req)}`, 30, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  let body: { overlayStockTerms?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const terms = body.overlayStockTerms?.trim();
  if (!terms) {
    return NextResponse.json({ error: 'overlayStockTerms is required' }, { status: 400 });
  }
  if (terms.length > 300) {
    return NextResponse.json({ error: 'overlayStockTerms too long' }, { status: 400 });
  }

  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (!braveKey || !replicateToken) {
    return NextResponse.json(
      { error: 'Overlay fetch is not configured (BRAVE_SEARCH_API_KEY / REPLICATE_API_TOKEN missing)' },
      { status: 503 },
    );
  }

  const bucket = getImagesBucket();
  const key = cacheKey(session.ws, terms);

  // Cache hit — the public URL is content-addressed, so we can just return
  // it without re-fetching. Brave + Replicate cost zero on cache hits.
  try {
    const cachedUrl = await getDownloadUrlForBucket(bucket, key, process.env.R2_IMAGES_PUBLIC_URL);
    // Probe the URL with a HEAD to confirm the object exists. We rely on the
    // public-URL pattern; if the bucket isn't public, a HEAD might be blocked
    // — in that case we fall through to the live fetch path.
    if (process.env.R2_IMAGES_PUBLIC_URL) {
      const head = await fetch(cachedUrl, { method: 'HEAD' }).catch(() => null);
      if (head && head.ok) {
        const result: GracefulResult = { overlayUrl: cachedUrl, cached: true };
        return NextResponse.json(result);
      }
    }
  } catch {
    /* fall through to live fetch */
  }

  try {
    const query = rewriteQuery(terms);
    const hit = await braveImageSearch(query, braveKey);
    if (!hit) {
      const result: GracefulResult = {
        overlayUrl: null,
        reason: `No image results for "${query}"`,
      };
      return NextResponse.json(result);
    }

    // Pre-flight the download — we only RMBG something we could fetch
    // ourselves. (Replicate fetches the source URL directly anyway, but
    // pre-flighting gives us a clearer error if the source is dead.)
    await downloadImage(hit.url);

    const cutoutBytes = await removeBackground(hit.url, replicateToken);

    await uploadToBucket(bucket, key, cutoutBytes, 'image/png');
    const overlayUrl = await getDownloadUrlForBucket(bucket, key, process.env.R2_IMAGES_PUBLIC_URL);

    const result: GracefulResult = { overlayUrl, cached: false, sourceUrl: hit.url };
    return NextResponse.json(result);
  } catch (err) {
    logger.warn('Overlay fetch failed', {
      detail: err instanceof Error ? err.message : String(err),
      terms,
      workspace: session.ws,
    });
    const result: GracefulResult = {
      overlayUrl: null,
      reason: err instanceof Error ? err.message : 'Overlay fetch failed',
    };
    return NextResponse.json(result);
  }
});
