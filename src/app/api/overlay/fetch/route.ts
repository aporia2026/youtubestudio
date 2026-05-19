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
import sharp from 'sharp';
import {
  decideOverlayPlacement,
  type SaliencyCell,
  type OverlayPlacementDecision,
} from '@/lib/overlay-placement-ai';
import { gateRmbgOutput } from '@/lib/overlay-rmbg-gate';
import { tiebreakRmbg } from '@/lib/overlay-rmbg-tiebreaker';
import { removeBackground } from '@/lib/overlay-rmbg';
import { checkSafePublicUrl } from '@/lib/url-safety';

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
// The Replicate RMBG call lives in src/lib/overlay-rmbg.ts so the
// Phase 5 edit route can also re-run RMBG on AI-edited overlays.
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
  | {
      overlayUrl: string;
      cached: boolean;
      sourceUrl?: string;
      /** Phase 2 smart-placement decision when sceneImageUrl was
       *  provided and the vision LLM produced a usable answer. Absent
       *  when the caller didn't request smart placement OR the vision
       *  call failed — in either case the caller keeps the doc-gen-
       *  blind zone/size already on the row. */
      placement?: OverlayPlacementDecision;
      /** Phase 4 RMBG-gate outcome. `true` = the heuristic gate (and,
       *  if invoked, the vision tiebreaker) approved the cutout; we
       *  uploaded the RMBG output to R2. `false` = we reverted to a
       *  PNG-re-encoded copy of the original Brave-source image
       *  because the cutout was unusable. `undefined` = the route
       *  didn't run the gate (cache hit, or gate errored — caller
       *  shouldn't assume anything). */
      rmbgKept?: boolean;
    }
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

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited } = checkRateLimit(`overlay-fetch:${getClientIP(req)}`, 30, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  let body: {
    overlayStockTerms?: string;
    /** When provided, Phase 2 smart placement runs after the overlay is
     *  ready and the decision is returned in `result.placement`. Absent
     *  ⇒ placement skipped (the caller keeps the doc-gen blind pick).
     *  Must be a public URL the vision LLM can fetch — the scene's R2
     *  URL from `row.imageUrl` is the typical value. */
    sceneImageUrl?: string;
    /** Optional saliency cells from `row.image_saliency` — embedded in
     *  the placement prompt so the model can avoid high-attention areas
     *  without re-deriving them. */
    saliencyCells?: SaliencyCell[];
    /** Phase 3 — when 'placement-only', the route skips Brave + RMBG
     *  and only re-runs the vision call against `existingOverlayUrl`.
     *  Used by the Rethink button to ask for a fresh placement on an
     *  overlay we already have in R2. */
    mode?: 'placement-only';
    /** Required when mode is 'placement-only' — the R2 URL of the
     *  overlay we want a new placement for. Validated HTTPS-only. */
    existingOverlayUrl?: string;
    /** Phase 3 anti-repeat hint — when present, the prompt asks for a
     *  meaningfully different placement than this. Supplied by the
     *  client from the row's current placement state. */
    previousDecision?: {
      sizePct: number;
      mode: 'zone' | 'custom';
      zone?: string;
      customXPct?: number;
      customYPct?: number;
      reason?: string;
    };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Helpers shared by both modes (placement-only and normal). Centralising
  // the SSRF check here means a malicious caller can't bypass it by
  // switching modes. `checkSafePublicUrl` blocks private IPs, link-local
  // addresses, AWS/GCP metadata hosts, and `.internal` / `.local`
  // suffixes — strictly tighter than the old protocol-only check.
  function validateOverlayUrl(
    raw: unknown,
    fieldName: string,
    opts?: { allowedHosts?: ReadonlySet<string> },
  ): string | NextResponse | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') {
      return NextResponse.json({ error: `${fieldName} must be a string` }, { status: 400 });
    }
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const r = checkSafePublicUrl(trimmed, {
      allowedProtocols: ['https:'],
      allowedHosts: opts?.allowedHosts,
    });
    if (!r.ok) {
      return NextResponse.json({ error: `${fieldName}: ${r.error}` }, { status: 400 });
    }
    return r.url.toString();
  }

  /** R2 public host derived from R2_IMAGES_PUBLIC_URL. Used to pin
   *  `existingOverlayUrl` to overlays we actually produced — without
   *  this, a caller could pass any HTTPS URL and the route would echo
   *  it back as the row's overlay state (confused-deputy attack: poisons
   *  the row with content the server never validated or hosted). */
  const r2PublicHost = (() => {
    const raw = process.env.R2_IMAGES_PUBLIC_URL;
    if (!raw) return null;
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      return null;
    }
  })();
  const r2AllowedHosts = r2PublicHost ? new Set([r2PublicHost]) : undefined;

  // Validate scene URL — must be HTTPS AND not point at any private /
  // metadata host (SSRF). The vision LLM fetches this URL server-side,
  // so a malicious caller could otherwise probe internal infra via
  // the Kie gateway.
  const sceneCheck = validateOverlayUrl(body.sceneImageUrl, 'sceneImageUrl');
  if (sceneCheck instanceof NextResponse) return sceneCheck;
  const sceneImageUrl: string | undefined = sceneCheck;

  // Saliency cells — accept the same shape the row carries; cap the
  // count to keep the prompt bounded.
  const saliencyCells: SaliencyCell[] | undefined = Array.isArray(body.saliencyCells)
    ? body.saliencyCells
        .filter(
          (c): c is SaliencyCell =>
            !!c &&
            typeof c === 'object' &&
            typeof (c as SaliencyCell).row === 'number' &&
            typeof (c as SaliencyCell).col === 'number' &&
            typeof (c as SaliencyCell).score === 'number',
        )
        .slice(0, 32)
    : undefined;

  // ── Phase 3: placement-only short-circuit ───────────────────────────
  //
  // No Brave search, no RMBG, no R2 upload — just re-run the vision
  // placement against an overlay we already have. Used by the Rethink
  // button. The route returns the SAME overlay URL the caller passed in
  // (so the client doesn't need to track two URL state machines) plus
  // the fresh placement decision. previousDecision is forwarded into
  // the prompt as an anti-repeat hint.
  if (body.mode === 'placement-only') {
    if (!sceneImageUrl) {
      return NextResponse.json(
        { error: 'sceneImageUrl is required for placement-only mode' },
        { status: 400 },
      );
    }
    // `existingOverlayUrl` MUST be on our R2 host (when configured).
    // This blocks a confused-deputy attack where a caller passes any
    // public HTTPS URL, gets it echoed back as `overlayUrl`, and
    // poisons their own row's overlay state with content we don't
    // own. If R2_IMAGES_PUBLIC_URL is unset (local dev), we fall
    // back to the SSRF check without host allow-list — production
    // deploys should always have this env var set.
    const existingCheck = validateOverlayUrl(body.existingOverlayUrl, 'existingOverlayUrl', {
      allowedHosts: r2AllowedHosts,
    });
    if (existingCheck instanceof NextResponse) return existingCheck;
    if (!existingCheck) {
      return NextResponse.json(
        { error: 'existingOverlayUrl is required for placement-only mode' },
        { status: 400 },
      );
    }
    const existingOverlayUrl = existingCheck;

    // Pass the previous decision through verbatim — the placement
    // module is responsible for validating its own shape.
    const prev = body.previousDecision;
    const previousDecision =
      prev && typeof prev.sizePct === 'number' && (prev.mode === 'zone' || prev.mode === 'custom')
        ? {
            sizePct: prev.sizePct,
            mode: prev.mode,
            zone: prev.zone as OverlayPlacementDecision['zone'],
            customXPct: typeof prev.customXPct === 'number' ? prev.customXPct : undefined,
            customYPct: typeof prev.customYPct === 'number' ? prev.customYPct : undefined,
            reason: typeof prev.reason === 'string' ? prev.reason : '',
          }
        : undefined;

    logger.info('[overlay rethink] requested', {
      workspace: session.ws,
      hasPrevious: Boolean(previousDecision),
      previousZone: previousDecision?.zone,
      previousMode: previousDecision?.mode,
    });

    const placement = await decideOverlayPlacement({
      sceneImageUrl,
      overlayImageUrl: existingOverlayUrl,
      saliencyCells,
      previousDecision,
    });
    const result: GracefulResult = {
      overlayUrl: existingOverlayUrl,
      cached: true,
      placement: placement ?? undefined,
    };
    return NextResponse.json(result);
  }

  // ── Normal mode: source + RMBG + (optional) smart placement ─────────

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

  /** Run smart placement after the overlay is known-good. Always tolerant:
   *  any failure → `undefined` so the caller falls back to doc-gen-blind.
   *  Runs on both cache-hit and cache-miss paths so a scene change picks
   *  up a fresh decision even when the overlay URL is unchanged. */
  async function maybeDecidePlacement(overlayUrl: string): Promise<OverlayPlacementDecision | undefined> {
    if (!sceneImageUrl) return undefined;
    const decision = await decideOverlayPlacement({
      sceneImageUrl,
      overlayImageUrl: overlayUrl,
      saliencyCells,
    });
    return decision ?? undefined;
  }

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
        const placement = await maybeDecidePlacement(cachedUrl);
        const result: GracefulResult = { overlayUrl: cachedUrl, cached: true, placement };
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
    // The bytes are kept so the Phase 4 gate can reuse them without a
    // second network fetch when reverting to original.
    const originalDownload = await downloadImage(hit.url);

    const cutoutBytes = await removeBackground({
      imageUrl: hit.url,
      replicateToken,
    });

    // ── Phase 4: smart-RMBG gate ───────────────────────────────────
    //
    // The gate is wrapped in try/catch so a decoder bug or memory
    // hiccup never breaks the calling flow — on any failure we ship
    // the RMBG cutout as-is, which is the same behaviour as before
    // Phase 4 landed. The `rmbgKept` field on the response tells the
    // client which path we took so the UI can surface it.
    let finalBytes = cutoutBytes;
    let rmbgKept = true;
    try {
      const gate = await gateRmbgOutput(cutoutBytes);
      logger.info('[overlay rmbg] gate', {
        workspace: session.ws,
        decision: gate.decision,
        alphaCoverage: gate.alphaCoverage,
        edgeHaloBleed: gate.edgeHaloBleed,
        componentCount: gate.componentCount,
        reason: gate.reason,
      });

      if (gate.decision === 'revert-original') {
        // Re-encode the original as PNG so the storage MIME type stays
        // consistent across the pipeline (downstream code assumes PNG
        // for overlays). For an opaque JPG source, the result is an
        // opaque PNG — RMBG was useless on it and we have nothing
        // better to offer; the renderer's elliptical mask still gives
        // a soft edge, just not a fully transparent one.
        finalBytes = await sharp(originalDownload.bytes).png().toBuffer();
        rmbgKept = false;
      } else if (gate.decision === 'ambiguous') {
        const tiebreaker = await tiebreakRmbg({
          originalBytes: originalDownload.bytes,
          originalMimeType: originalDownload.contentType,
          cutoutBytes,
        });
        logger.info('[overlay rmbg] tiebreaker', {
          workspace: session.ws,
          vote: tiebreaker?.vote ?? null,
          reason: tiebreaker?.reason ?? null,
          model: tiebreaker?.model ?? null,
        });
        if (tiebreaker?.vote === 'a') {
          finalBytes = await sharp(originalDownload.bytes).png().toBuffer();
          rmbgKept = false;
        }
        // tiebreaker?.vote === 'b' OR 'either' OR null → keep RMBG.
      }
      // gate.decision === 'keep-rmbg' → no-op (finalBytes already = cutoutBytes).
    } catch (gateErr) {
      logger.warn('[overlay rmbg] gate threw — keeping RMBG output', {
        workspace: session.ws,
        detail: gateErr instanceof Error ? gateErr.message : String(gateErr),
      });
    }

    await uploadToBucket(bucket, key, finalBytes, 'image/png');
    const overlayUrl = await getDownloadUrlForBucket(bucket, key, process.env.R2_IMAGES_PUBLIC_URL);

    const placement = await maybeDecidePlacement(overlayUrl);
    const result: GracefulResult = {
      overlayUrl,
      cached: false,
      sourceUrl: hit.url,
      placement,
      rmbgKept,
    };
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
