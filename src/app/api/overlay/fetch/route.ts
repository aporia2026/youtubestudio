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
// Replicate slug: `bria/remove-background` runs Bria's RMBG-2.0 model.
// The earlier `briaai/rmbg-2.0` slug doesn't exist on Replicate (it's
// the HuggingFace slug, not the Replicate one) and returned 404.
const REPLICATE_RMBG_URL =
  'https://api.replicate.com/v1/models/bria/remove-background/predictions';
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5_000;
const MIN_RESULT_WIDTH = 200;
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

type GracefulResult =
  | { overlayUrl: string; cached: boolean; sourceUrl?: string }
  | { overlayUrl: null; reason: string };

/**
 * Rewrite the LLM's overlay terms into a search query that Brave actually
 * finds results for. The LLM tends to emit editorial phrases like
 * "Kaseya logo official PNG" — concatenating those verbatim with our
 * "transparent png" modifier produces zero-result queries (literally:
 * "Kaseya logo official PNG transparent png"). The fix:
 *
 *   1. Take only the first comma-separated term (the rest are variants).
 *   2. Strip editorial noise words the LLM adds for the editor's benefit
 *      ("official", "original", "company", "product", "hi-res", and any
 *      bare "png" — we'll re-add that as a modifier where it actually
 *      helps).
 *   3. Add a single, well-chosen modifier based on what the term implies:
 *      logo → "transparent png" (cleanest cutout sources)
 *      screenshot → leave as-is (already specific enough)
 *      photo → leave as-is
 *   4. Collapse internal whitespace so the final query is clean.
 *
 * Example: "Kaseya logo official PNG, leak-site reference" →
 *          "Kaseya logo transparent png"
 */
function rewriteQuery(rawTerms: string): string {
  const primary = (rawTerms.split(',')[0] || rawTerms).trim();
  const stripped = primary
    .replace(/\b(official|original|company|product)\b/gi, '')
    .replace(/\bhi[-\s]?res\b/gi, '')
    .replace(/\bpng\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lc = stripped.toLowerCase();
  if (/\blogo\b/.test(lc)) return `${stripped} transparent png`;
  return stripped;
}

function cacheKey(workspaceId: string, rawTerms: string): string {
  const hash = createHash('sha256')
    .update(`${workspaceId}:${rawTerms.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
  return `overlays/${workspaceId}/${hash}.png`;
}

/**
 * Cap the query to Brave's hard limits: max 400 chars AND max 50 words.
 * Exceeding either triggers a 422 with no useful body. We also strip
 * non-printable characters (the OverlayCell renders a leading `✦` for
 * decoration — if that ever leaked into the raw terms, Brave's
 * tokenizer might reject it).
 */
function clampQueryForBrave(raw: string): string {
  const ascii = raw.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = ascii.split(' ').filter(Boolean).slice(0, 50);
  const joined = words.join(' ');
  return joined.length > 400 ? joined.slice(0, 400).trim() : joined;
}

async function braveImageSearch(query: string, apiKey: string): Promise<{
  url: string;
  width: number;
  height: number;
  title: string;
} | null> {
  // Parameter notes (from Brave's API reference):
  //   - `safesearch`: only `strict` (default) or `off` are valid;
  //     `moderate` triggers 422.
  //   - `count`: 1-200, default 50. We ask for 20 — enough for a
  //     PNG-preference re-rank without paying for results we'll discard.
  //   - `country`: optional, defaults to `US`. The spec uses UPPERCASE
  //     codes (`US`, `AR`, etc.); lowercase `us` trips the validator
  //     and returns 422. Easiest fix is to omit the param entirely
  //     and let the default kick in.
  //   - `q`: max 400 chars, max 50 words — enforced via clampQueryForBrave.
  const cleanQuery = clampQueryForBrave(query);
  if (!cleanQuery) {
    throw new Error('Brave Search: empty query after sanitization');
  }
  const url = `${BRAVE_IMAGE_SEARCH}?q=${encodeURIComponent(cleanQuery)}&safesearch=strict&count=20`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });
  if (!res.ok) {
    // Capture the response body so a 422's actual reason ("query too
    // long", "invalid safesearch value", "rate limited", etc.) reaches
    // the caller instead of being thrown away. Log it server-side too
    // for offline debugging.
    const body = await res.text().catch(() => '');
    const snippet = body.slice(0, 400);
    logger.warn('Brave Search non-OK', {
      status: res.status,
      query: cleanQuery,
      body: snippet,
    });
    throw new Error(`Brave Search failed (${res.status}): ${snippet || 'no body'}`);
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
  // Width gate is intentionally loose (200 px) — Brave's reported width
  // is the source's intrinsic width, and logos are often distributed at
  // 240-320 px even on legit brand pages. Falling back to the thumbnail
  // URL when properties.url is missing salvages additional candidates.
  const candidates = results
    .map((r) => ({
      url: r.properties?.url || r.thumbnail?.src || '',
      width: r.width ?? 0,
      height: r.height ?? 0,
      title: r.title ?? '',
    }))
    .filter((r) => r.url && (r.width === 0 || r.width >= MIN_RESULT_WIDTH));
  // Prefer .png when available (RMBG handles JPG too, but PNG sources are
  // closer to clean cutouts to begin with).
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
  // 60 s) so we don't have to poll. RMBG typically completes in 1-2 s.
  // The Bria input schema accepts a public URL or a base64 data URL in
  // the `image` field; we pass the Brave-sourced URL directly.
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
    // Capture Replicate's actual error body — same reasoning as the
    // Brave call above. A 404 used to surface as "Replicate RMBG
    // failed (404)" with no detail; now the slug-doesn't-exist /
    // model-private / auth-failed cases each propagate distinguishable
    // text the caller can act on.
    const body = await create.text().catch(() => '');
    const snippet = body.slice(0, 400);
    logger.warn('Replicate RMBG non-OK', { status: create.status, body: snippet });
    throw new Error(`Replicate RMBG failed (${create.status}): ${snippet || 'no body'}`);
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
