import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  createGpt4oImageTask,
  createKieTask,
  pollGpt4oImageResult,
  pollKieResult,
} from '@/lib/kie-poll';
import { checkSafePublicUrl } from '@/lib/url-safety';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';
import { removeBackground } from '@/lib/overlay-rmbg';
import { gateRmbgOutput } from '@/lib/overlay-rmbg-gate';

export const maxDuration = 300;

/**
 * Edit an overlay image (transparent PNG that gets composited on top of a
 * scene). Phase 5 of `_plans/2026-05-18-overlay-system-overhaul.md`.
 *
 * Two tiers, matching the row-image edit route's shape:
 *
 *   1. Smart edit  (`mode: 'smart'`)  — Nano Banana (Gemini 2.5 Flash
 *      Image) via Kie's `google/nano-banana-edit`. Prompt + source
 *      only; the model segments the region the prompt describes.
 *      Cost (2026-05-19, verified): Kie marketing says ~$0.02/edit
 *      for this route; Google's direct rate is $0.039. The exact
 *      Kie credit-debit is not first-party verifiable from public
 *      pages — eyeball one real call in the Kie dashboard. Default
 *      mode. (To upgrade to Nano Banana 2 / Gemini 3.1 Flash Image
 *      Preview, swap the Kie slug — pricing then becomes tiered at
 *      0.5K $0.045 → 4K $0.151 per Google direct.)
 *
 *   2. Brush mask  (`mode: 'brush'`)  — GPT-4o image via Kie's
 *      `gpt4o-image/generate`. Mask + prompt + quality tier. Mask is
 *      a black/white PNG matching source dimensions: black = regenerate,
 *      white = preserve. ~$0.034 medium / ~$0.133 high.
 *
 * Differs from the row-image edit route in three ways:
 *
 *   - R2 prefix is `overlays/edit-` (the source's `overlays/<ws>/...`
 *     cache key is content-addressed, so an edit MUST land at a
 *     different key or the next normal-mode fetch would overwrite the
 *     edit on a cache rebuild).
 *   - Output aspect ratio is probed from the source via sharp (logos
 *     range from 1:8 portrait stamps to 5:1 wordmarks; a fixed 16:9
 *     would distort most of them).
 *   - No saliency computation — overlays are placed ON scenes, not the
 *     reverse, so the overlay's own saliency doesn't matter.
 *
 * Auto-RMBG after edit is intentionally NOT wired in v1: Nano Banana
 * preserves transparency when prompted, and GPT-4o's brush mask leaves
 * unmasked transparent pixels alone. If quality regresses in practice,
 * Phase 5.1 can wire the Phase 4 gate on the edited output.
 *
 * Authed. Rate-limited at 20/min/IP — matches the row-image edit cap.
 */

const ALLOWED_MODES = ['smart', 'brush'] as const;
type EditMode = (typeof ALLOWED_MODES)[number];

interface EditRequestBody {
  overlayUrl?: string;
  prompt?: string;
  mode?: string;
  mask?: { url?: string; quality?: 'low' | 'medium' | 'high' };
  /** When true (default), re-run Bria RMBG on the edit output so any
   *  background the model accidentally introduced is removed before
   *  the result lands in R2. Costs ~$0.018 (fal.ai) / ~$0.058
   *  (Replicate) extra per edit. Set false to skip if the user
   *  explicitly wants the model's exact output preserved. */
  rerunRmbg?: boolean;
}

/** Map an aspect ratio number → the Kie `image_size` literal that's
 *  closest. Logos run the full gamut (1:8 portraits to 5:1 wordmarks),
 *  so we pick the nearest of the supported buckets rather than forcing
 *  16:9 like the row-image route. Hot-path is cheap enough to inline. */
function aspectToKieSize(
  aspect: number,
): '16:9' | '4:3' | '1:1' | '3:4' | '9:16' {
  if (aspect >= 1.7) return '16:9';
  if (aspect >= 1.2) return '4:3';
  if (aspect >= 0.85) return '1:1';
  if (aspect >= 0.6) return '3:4';
  return '9:16';
}

/** Probe the source image's dimensions via sharp — needed for two
 *  reasons: (1) picking the Kie aspect bucket, (2) GPT-4o requires the
 *  mask to be EXACT pixel-match with the source, which the brush editor
 *  already enforces but the route validates anyway. Returns null on
 *  any failure (network, decode) — callers default to 1:1. */
async function probeAspect(url: string): Promise<{ aspect: number; width: number; height: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w <= 0 || h <= 0) return null;
    return { aspect: w / h, width: w, height: h };
  } catch (err) {
    logger.warn('[overlay edit] aspect probe failed', {
      url,
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Two rate-limit dimensions: per-IP catches single misbehaving
  // clients; per-workspace catches distributed abuse (botnet / NAT)
  // that would otherwise sidestep the IP cap. Both must pass.
  // Edit calls hit $0.034–$0.133 each on GPT-image-1.5 high, so the
  // ws cap is tighter than fetch (which only hits $0.018–$0.058).
  const ipLimit = checkRateLimit(`overlay-edit:${getClientIP(req)}`, 20, 60_000);
  if (ipLimit.limited) {
    return NextResponse.json({ error: 'Rate limited (per-IP)' }, { status: 429 });
  }
  const wsLimit = checkRateLimit(`overlay-edit:ws:${session.ws}`, 30, 60_000);
  if (wsLimit.limited) {
    return NextResponse.json({ error: 'Rate limited (per-workspace)' }, { status: 429 });
  }

  let body: EditRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { overlayUrl, prompt } = body;
  const mode = (body.mode || 'smart') as EditMode;
  if (!ALLOWED_MODES.includes(mode)) {
    return NextResponse.json(
      { error: `Unknown mode: ${mode}. Valid: ${ALLOWED_MODES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!overlayUrl?.trim() || !prompt?.trim()) {
    return NextResponse.json({ error: 'overlayUrl + prompt required' }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json({ error: 'Prompt too long (max 2000 chars)' }, { status: 400 });
  }

  // R2 public host derived from R2_IMAGES_PUBLIC_URL — used to pin
  // BOTH `overlayUrl` and `mask.url` to assets we actually host.
  // Without this pin a caller could pass any public HTTPS URL: we'd
  // ship it to Kie, pay for the edit, and mirror the result into the
  // caller's workspace bucket — a free GPT-4o-image call paid for by
  // us ($0.034–$0.133/edit). For mask URLs specifically, an attacker-
  // controlled mask doesn't match the overlay's dimensions and the
  // edit fails — but only AFTER we've billed for it.
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

  // SSRF + host-pin guard on overlayUrl. When R2_IMAGES_PUBLIC_URL is
  // set (always in prod), only overlays we serve can be edited. Falls
  // back to the bare SSRF check in local dev where the env var may
  // be unset — that's acceptable since dev infra isn't a target.
  const overlayCheck = checkSafePublicUrl(overlayUrl, {
    allowedProtocols: ['https:'],
    allowedHosts: r2AllowedHosts,
  });
  if (!overlayCheck.ok) {
    return NextResponse.json({ error: `overlayUrl: ${overlayCheck.error}` }, { status: 400 });
  }

  let maskUrl: string | undefined;
  let maskQuality: 'low' | 'medium' | 'high' = 'medium';
  if (mode === 'brush') {
    if (!body.mask?.url) {
      return NextResponse.json({ error: 'mask.url required for brush mode' }, { status: 400 });
    }
    const maskCheck = checkSafePublicUrl(body.mask.url, {
      allowedProtocols: ['https:'],
      allowedHosts: r2AllowedHosts,
    });
    if (!maskCheck.ok) {
      return NextResponse.json({ error: `mask URL: ${maskCheck.error}` }, { status: 400 });
    }
    maskUrl = body.mask.url;
    if (body.mask.quality === 'low' || body.mask.quality === 'medium' || body.mask.quality === 'high') {
      maskQuality = body.mask.quality;
    }
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
  }

  // Aspect probe — used for the Kie size param. Failure falls back
  // to 1:1, which is the safest neutral default.
  const aspectInfo = await probeAspect(overlayUrl);
  const kieSize = aspectInfo ? aspectToKieSize(aspectInfo.aspect) : '1:1';
  logger.info('[overlay edit] start', {
    workspace: session.ws,
    mode,
    kieSize,
    aspect: aspectInfo?.aspect ?? null,
    promptLength: prompt.length,
  });

  try {
    let resultUrl: string;
    if (mode === 'smart') {
      const taskId = await createKieTask(apiKey, 'google/nano-banana-edit', {
        prompt: prompt.trim(),
        image_urls: [overlayUrl],
        image_size: kieSize,
        output_format: 'png',
      });
      resultUrl = await pollKieResult(taskId, apiKey);
    } else {
      // GPT-4o image edit only accepts 1:1 / 3:2 / 2:3 per Kie docs.
      // Map the overlay's native aspect to the closest of those — a
      // wide wordmark falls back to 3:2 (not 16:9 like the row-image
      // route, which is closer for a 5:1 wordmark than a square).
      const gptSize: '1:1' | '3:2' | '2:3' = aspectInfo
        ? aspectInfo.aspect >= 1.2
          ? '3:2'
          : aspectInfo.aspect <= 0.8
            ? '2:3'
            : '1:1'
        : '1:1';
      const taskId = await createGpt4oImageTask(apiKey, {
        prompt: prompt.trim(),
        filesUrl: [overlayUrl],
        maskUrl,
        size: gptSize,
        quality: maskQuality,
      });
      resultUrl = await pollGpt4oImageResult(taskId, apiKey);
    }

    // Mirror the result to R2 under `overlays/edit-…` so the source
    // cache key (`overlays/<ws>/<hash>.png`) is preserved — a future
    // re-fetch of the same stock_terms still hits its own cache.
    // Step order:
    //   1. Fetch the Kie-hosted result bytes.
    //   2. (optional) Auto-RMBG: re-run Bria on the bytes so any
    //      background the model accidentally introduced is removed.
    //      Gate the cutout via the Phase 4 heuristic — if RMBG ate
    //      everything we keep the model's output rather than ship a
    //      blank PNG.
    //   3. Upload to R2.
    let finalUrl = resultUrl;
    let rmbgKept: boolean | undefined;
    // SSRF guard — Kie's response is trusted but if their CDN ever
    // emits an internal hostname (compromised gateway, misconfigured
    // proxy), we'd otherwise fetch it server-side. Defense in depth.
    // When the URL fails the check we skip the R2 mirror entirely and
    // return the unmodified Kie URL — the client still gets a result,
    // we just don't bounce bytes through our infra. This shouldn't
    // happen in practice; the warn log surfaces it if it does.
    const resultUrlSafe = checkSafePublicUrl(resultUrl, { allowedProtocols: ['https:'] });
    if (!resultUrlSafe.ok) {
      logger.warn('[overlay edit] Kie returned unsafe URL — skipping R2 mirror', {
        url: resultUrl,
        error: resultUrlSafe.error,
      });
    }
    try {
      // Skip the fetch entirely when the URL failed our SSRF check —
      // the client receives the unmodified Kie URL above. `imgRes`
      // being null below short-circuits the mirror + RMBG block.
      const imgRes = resultUrlSafe.ok ? await fetch(resultUrl) : null;
      if (!imgRes) {
        // Already logged the unsafe-URL warn above — nothing more to do.
      } else if (!imgRes.ok) {
        logger.warn('[overlay edit] result fetch non-OK — falling back to Kie URL', {
          status: imgRes.status,
        });
      } else {
        const contentType = imgRes.headers.get('content-type') || 'image/png';
        // Annotate as `Buffer` rather than the inferred `Buffer<ArrayBuffer>`
        // — the cutout assignment below comes from `removeBackground`'s
        // `Buffer<ArrayBufferLike>` return type, which is only assignable
        // to the wider `Buffer` alias.
        let buffer: Buffer = Buffer.from(await imgRes.arrayBuffer());
        let outputContentType = contentType;

        // Auto-RMBG is on by default — overlays are transparent PNGs by
        // contract, and Nano Banana / GPT-image sometimes return an
        // opaque background even when the prompt asks otherwise.
        const shouldRerunRmbg = body.rerunRmbg !== false;
        const replicateToken = process.env.REPLICATE_API_TOKEN;
        if (shouldRerunRmbg && replicateToken) {
          try {
            const cutoutBytes = await removeBackground({
              imageBytes: buffer,
              imageMimeType: contentType,
              replicateToken,
            });
            // Phase 4 gate the cutout — if RMBG ate the subject (alpha
            // coverage < 5%) we keep the model's output instead of
            // shipping a blank PNG. Halo / shattered components are
            // accepted here because we're already downstream of an
            // AI edit that the user is going to preview & accept.
            const gate = await gateRmbgOutput(cutoutBytes);
            logger.info('[overlay edit] auto-rmbg gate', {
              workspace: session.ws,
              decision: gate.decision,
              alphaCoverage: gate.alphaCoverage,
              edgeHaloBleed: gate.edgeHaloBleed,
              reason: gate.reason,
            });
            if (gate.decision === 'revert-original') {
              rmbgKept = false;
            } else {
              buffer = cutoutBytes;
              outputContentType = 'image/png';
              rmbgKept = true;
            }
          } catch (rmbgErr) {
            // RMBG hiccup never blocks the edit accept — log + fall
            // through to the unprocessed model output.
            logger.warn('[overlay edit] auto-rmbg failed — keeping model output', {
              detail: rmbgErr instanceof Error ? rmbgErr.message : String(rmbgErr),
            });
            rmbgKept = false;
          }
        }

        const ext = outputContentType.includes('png') ? 'png' : 'jpg';
        // Use crypto.randomBytes for the cache-bust suffix — matches
        // the SHA-256 pattern used by the rest of the codebase's R2
        // key generation, and gives a much larger collision-free
        // namespace than Math.random's predictable 36^8.
        const randomSuffix = randomBytes(8).toString('hex');
        const bucket = getImagesBucket();
        const r2Key = `overlays/edit-${session.ws}-${Date.now()}-${randomSuffix}.${ext}`;
        await uploadToBucket(bucket, r2Key, buffer, outputContentType);
        finalUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      }
    } catch (mirrorErr) {
      logger.warn('[overlay edit] R2 mirror failed — falling back to Kie URL', {
        detail: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
      });
    }

    logger.info('[overlay edit] done', {
      workspace: session.ws,
      mode,
      finalUrl,
      rmbgKept: rmbgKept ?? null,
    });
    return NextResponse.json({ overlayUrl: finalUrl, mode, rmbgKept });
  } catch (err) {
    logger.error('Overlay edit failed', {
      detail: err instanceof Error ? err.message : String(err),
      mode,
      promptLength: prompt.length,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Edit failed' },
      { status: 500 },
    );
  }
});
