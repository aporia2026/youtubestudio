import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  isR2Configured,
  getImagesUploadUrl,
  getImagesDownloadUrl,
  buildThumbnailReferenceKey,
  uploadToBucket,
  getImagesBucket,
} from '@/lib/r2';
import {
  parseConfig,
  validateConfig,
  computeRegions,
  type FlexIconGridConfig,
} from '@/lib/thumbnail-formats/flex-icon-grid';
import {
  composeFlexIconGrid,
  type UploadFetcher,
} from '@/lib/thumbnail-formats/flex-icon-grid-composer';
import { getFontCacheStats } from '@/lib/thumbnail-formats/flex-icon-grid-font-cache';

/**
 * Render a Flex Icon Grid thumbnail.
 *
 * Body: `{ config: FlexIconGridConfig }`. The server validates, runs
 * the deterministic composer, uploads the resulting PNG to R2, and
 * returns the hosted URL plus per-cell regions.
 *
 * No image-gen models in the loop — composition is pure SVG + Sharp,
 * so renders are fast (typically under 2s for a 5×3 grid) and free.
 *
 * Authed: only signed-in users may render. The upload fetcher inside
 * the composer is SSRF-guarded — only URLs pointing at our own R2
 * buckets are followed.
 */
export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const start = Date.now();
  let body: { config?: unknown };
  try {
    body = (await req.json()) as { config?: unknown };
  } catch (err) {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  let config: FlexIconGridConfig;
  try {
    config = parseConfig(body.config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `config parse failed: ${msg}`, code: 'BAD_CONFIG' }, { status: 400 });
  }

  const validation = validateConfig(config);
  if (!validation.ok) {
    console.warn('[flex-icon-grid api] validate failed', {
      reason: validation.reason,
      cell_index: validation.offending_cell_index,
    });
    return NextResponse.json(
      {
        error: validation.reason,
        code: 'INVALID_CONFIG',
        offending_cell_index: validation.offending_cell_index,
      },
      { status: 400 },
    );
  }

  console.info('[flex-icon-grid api] render start', {
    rows: config.rows, cols: config.cols, cell_count: config.cells.length,
    width: config.width, height: config.height,
  });

  // Compose
  let pngBuffer: Buffer;
  let fontWarnings: string[] = [];
  try {
    const result = await composeFlexIconGrid({
      config,
      fetchUpload: makeSSRFGuardedFetcher(),
    });
    pngBuffer = result.buffer;
    fontWarnings = result.fontWarnings;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[flex-icon-grid api] compose failed', { reason: msg });
    return NextResponse.json({ error: `compose failed: ${msg}`, code: 'COMPOSE_FAILED' }, { status: 500 });
  }

  // Upload to R2
  let imageUrl: string;
  try {
    const r2Key = buildThumbnailReferenceKey(`flex-icon-grid-${Date.now()}.png`);
    await uploadToBucket(getImagesBucket(), r2Key, pngBuffer, 'image/png');
    imageUrl = await getImagesDownloadUrl(r2Key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[flex-icon-grid api] r2 upload failed', { reason: msg });
    return NextResponse.json({ error: `R2 upload failed: ${msg}`, code: 'R2_UPLOAD_FAILED' }, { status: 502 });
  }

  // Region rectangles for the production-doc consumer.
  const regions = computeRegions(config, () => crypto.randomUUID());

  // Lifetime font-cache stats (Phase 4.9 caveat fix). Surfacing here
  // so ops can grep render logs to see hit/miss ratios trending — a
  // sustained low hit rate means workspaces have more unique fonts
  // than MAX_ENTRIES and we should bump the cap.
  const fontCacheStats = getFontCacheStats();
  // Phase 4.10 caveat fix: structured aggregate cache-stats line with
  // its own stable tag. Lambda instances are per-process so each
  // emits its own slice; a downstream log aggregator can sum the
  // hits/misses across the fleet by filtering on the tag. Hit ratio
  // pre-computed at emit time so the aggregator doesn't have to.
  const totalAccesses = fontCacheStats.hits + fontCacheStats.misses;
  const hitRatio = totalAccesses > 0 ? fontCacheStats.hits / totalAccesses : null;
  console.info('[flex-icon-grid font-cache] stats', {
    entries: fontCacheStats.entries,
    inflight: fontCacheStats.inflight,
    max: fontCacheStats.max,
    hits: fontCacheStats.hits,
    misses: fontCacheStats.misses,
    hit_ratio: hitRatio,
    saturation: fontCacheStats.entries / fontCacheStats.max,
  });
  console.info('[flex-icon-grid api] render ok', {
    bytes: pngBuffer.length,
    total_ms: Date.now() - start,
    font_warnings_count: fontWarnings.length,
    font_cache: fontCacheStats,
  });

  return NextResponse.json(
    {
      imageUrl,
      regions,
      config,
      outputWidth: config.width,
      outputHeight: config.height,
      // Phase 4.7 caveat fix: surface URLs that failed to fetch this
      // render so the panel can show "font no longer available" badges
      // instead of silently falling back to Anton.
      fontWarnings,
    },
    { status: 201 },
  );
});

// ─── SSRF-guarded upload fetcher ────────────────────────────────────────────

/**
 * Build an `UploadFetcher` that ONLY follows URLs pointing at our own
 * R2 buckets. Any other URL — including same-host non-R2 endpoints,
 * link-local addresses, file://, data: — is rejected with a clear
 * error. Belt and braces against SSRF: even though the URLs come
 * from our own presign route, a stale or doctored client could send
 * anything in the config blob.
 */
function makeSSRFGuardedFetcher(): UploadFetcher {
  const allowedPrefixes = collectAllowedR2Prefixes();
  return async (url: string): Promise<Buffer> => {
    if (typeof url !== 'string' || !url) {
      throw new Error('upload url is empty');
    }
    if (!isAllowedUrl(url, allowedPrefixes)) {
      throw new Error(`upload url is not on the R2 allowlist: ${url.slice(0, 80)}`);
    }
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`upload fetch failed (${res.status})`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  };
}

function collectAllowedR2Prefixes(): string[] {
  const out: string[] = [];
  const acc = process.env.R2_ACCOUNT_ID;
  if (acc) out.push(`https://${acc}.r2.cloudflarestorage.com/`);
  // Public CDN custom domains, when configured.
  if (process.env.R2_PUBLIC_URL) out.push(ensureTrailingSlash(process.env.R2_PUBLIC_URL));
  if (process.env.R2_NARRATION_PUBLIC_URL) out.push(ensureTrailingSlash(process.env.R2_NARRATION_PUBLIC_URL));
  if (process.env.R2_IMAGES_PUBLIC_URL) out.push(ensureTrailingSlash(process.env.R2_IMAGES_PUBLIC_URL));
  return out;
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : s + '/';
}

function isAllowedUrl(url: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (url.startsWith(p)) return true;
  }
  return false;
}
