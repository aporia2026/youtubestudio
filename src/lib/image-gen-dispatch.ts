/**
 * Cloud image-generation dispatcher.
 *
 * The single chokepoint every cloud (kie + atlas) t2i surface calls so the
 * provider branch, the system-wide auto-upscale pass, the 16:9 crop step
 * (Atlas only), and the R2 mirror all live in one place. Replaces the
 * 30-line `createKieTask + pollKieResultThenUpscale + R2-mirror` block
 * that each of the 7 generation routes previously inlined.
 *
 * Scope (Phase 1.A of `_plans/2026-05-25-atlas-cloud-gpt-image-2.md`):
 *   - Kie cloud t2i (existing behaviour, lifted from the routes verbatim).
 *   - Atlas Cloud GPT Image 2 t2i with 16:9 center-crop.
 *   - ComfyUI Local is OUT OF SCOPE — that path has its own LOCAL_STUDIO
 *     gate and ComfyUI client setup, so routes keep dispatching to it
 *     directly and fall through to this helper only for cloud specs.
 *
 * Atlas pipeline
 *   Atlas's GPT Image 2 family doesn't accept 16:9, so generation comes
 *   back at 1536×1024 (3:2). We center-crop to 1536×864 (16:9), upload
 *   the cropped bytes to R2 (intermediate key prefix), pass that R2 URL
 *   to Recraft for upscale, then mirror the upscaled result to R2 under
 *   the caller's chosen final key prefix. Two R2 writes total — Recraft
 *   takes URLs only, so the crop step needs to live somewhere Recraft
 *   can fetch from.
 *
 * Failure posture
 *   - Vendor generation failure: throws. Caller surfaces a clean error to
 *     the user (no auto-fallback between vendors — locked product
 *     decision, see plan).
 *   - Crop failure (Atlas only): throws. The 3:2 image would mis-fit the
 *     16:9 pipeline downstream, so failing visible is safer than passing
 *     it on.
 *   - Upscale failure: never throws. `upscaleViaRecraft` already returns
 *     the original URL on failure with a logged warning (see
 *     `src/lib/upscale.ts`). We propagate whatever URL it returns.
 *   - R2 mirror failure: logged warning, returns the vendor (or
 *     Recraft) URL as a fallback. Image still usable until the upstream
 *     CDN URL expires.
 */
import sharp from 'sharp';
import type { ImageModelSpec } from './image-models';
import { buildKieImageInput } from './image-models';
import { createKieTask, pollKieResultThenUpscale } from './kie-poll';
import { generateAtlasT2I, type AtlasSize, type AtlasQuality } from './atlas-cloud-images';
import { upscaleViaRecraft } from './upscale';
import { getDownloadUrlForBucket, getImagesBucket, uploadToBucket } from './r2';
import { logger } from './logger';

/** Default size we ask Atlas for. `'2560x1440'` is the native 16:9 (2K)
 *  option exposed by the Atlas playground (verified via user screenshot
 *  2026-05-25). Picking it lets us skip the post-generation 16:9 crop
 *  step entirely — see ATLAS_NATIVE_16X9_SIZES below. */
const DEFAULT_ATLAS_SIZE: AtlasSize = '2560x1440';
/** Default quality tier. `'low'` because every cloud image flows through
 *  Recraft Crisp Upscale (Phase 2 of the 2026-05-24 upscale plan), so
 *  paying for medium/high at the source wastes money the upscaler would
 *  have spent for free. The user locked this directive 2026-05-25 when
 *  the 16:9 size was discovered. */
const DEFAULT_ATLAS_QUALITY: AtlasQuality = 'low';

/** Atlas sizes that already match the pipeline's 16:9 aspect. When the
 *  spec asks for one of these, the dispatcher skips `cropTo16x9AndUpload`
 *  and hands the vendor URL straight to Recraft — saves one R2 round-
 *  trip + sharp processing per generation. Used by the t2i dispatcher,
 *  the i2i helper, and the collage route's Atlas branch. */
export const ATLAS_NATIVE_16X9_SIZES: ReadonlySet<AtlasSize> = new Set(['2560x1440']);

/** R2 prefix for the intermediate Atlas-cropped image. Only used when
 *  the spec requests a non-16:9 size and the crop step actually fires.
 *  Distinct from the final image prefix so R2 metrics can show how
 *  often the crop fallback path runs vs. the native 16:9 path. */
const ATLAS_CROP_KEY_PREFIX = 'prodoc-images-atlas-crop';
/** Default R2 prefix for the final mirrored image. Matches the prefix the
 *  production-doc image route used previously so historical telemetry +
 *  per-prefix lifecycle rules continue to apply. */
const DEFAULT_FINAL_KEY_PREFIX = 'prodoc-images';

export interface DispatchedImageResult {
  /** Final URL to use downstream. R2-hosted when the mirror step succeeded;
   *  the vendor (Recraft or Kie/Atlas) URL when R2 upload failed. */
  url: string;
  /** Bytes of the final image, populated when the dispatcher fetched them
   *  as part of the R2 mirror step. Undefined when the mirror failed.
   *  Routes that want saliency or downstream byte-level work should use
   *  these instead of re-fetching `url`. */
  bytes?: Buffer;
  /** Which provider ran the generation. */
  providerUsed: 'kie' | 'atlas';
  /** Total time spent inside this dispatcher call, milliseconds. */
  durationMs: number;
}

export interface DispatchedImageOpts {
  /** R2 key prefix for the final mirrored image. Defaults to
   *  `'prodoc-images'`. Thumbnails and other namespaces pass their own. */
  r2KeyPrefix?: string;
}

/**
 * Generate a single image from a t2i model spec, upscale it, mirror to R2.
 * Branches on `spec.provider` — Kie via the existing kie-poll chokepoint,
 * Atlas via the new atlas-cloud-images module.
 *
 * Throws if `spec.provider === 'comfyui-local'` — the local path lives in
 * the per-route LOCAL_STUDIO branch and shouldn't reach this function.
 */
export async function generateImageWithUpscale(
  spec: ImageModelSpec,
  prompt: string,
  opts?: DispatchedImageOpts,
): Promise<DispatchedImageResult> {
  const t0 = Date.now();
  const finalPrefix = opts?.r2KeyPrefix ?? DEFAULT_FINAL_KEY_PREFIX;

  logger.info('[image-dispatch] route', {
    provider: spec.provider,
    model: spec.value,
    prompt_chars: prompt.length,
    final_prefix: finalPrefix,
  });

  let postUpscaleUrl: string;
  let providerUsed: 'kie' | 'atlas';

  if (spec.provider === 'atlas') {
    providerUsed = 'atlas';
    const size: AtlasSize = spec.atlasSize ?? DEFAULT_ATLAS_SIZE;
    const quality: AtlasQuality = spec.atlasQuality ?? DEFAULT_ATLAS_QUALITY;
    const atlasResult = await generateAtlasT2I({ prompt, size, quality });
    if (ATLAS_NATIVE_16X9_SIZES.has(size)) {
      // Native 16:9 path (the user-locked default at 2560×1440, 2026-05-25):
      // skip BOTH the crop step AND the Recraft upscale. The crop is a
      // no-op because the source is already 16:9; the upscale is
      // deliberately skipped because:
      //   1. Recraft's >2000px guard in upscale.ts would skip anyway
      //      (2560 > 2000), so making the skip explicit + provider-
      //      specific keeps the behaviour pinned even if the global
      //      threshold ever moves.
      //   2. 4× upscale of 2560×1440 lands at ~10K, which is overkill
      //      for the 1080p/2K render targets and wastes the $0.0025
      //      Recraft call. The user paid for "low quality at 2K, no
      //      upscale" knowing the source is already pipeline-sized.
      //   3. Removes a Recraft round-trip + sharp probe per generation.
      // For smaller Atlas sizes (square / 3:2), the crop+upscale path
      // below runs as designed.
      logger.info('[image-dispatch] atlas native-16x9 skip-upscale', {
        size,
        model: spec.value,
      });
      postUpscaleUrl = atlasResult.url;
    } else {
      const croppedUrl = await cropTo16x9AndUpload(atlasResult.url, ATLAS_CROP_KEY_PREFIX);
      const upscale = await upscaleViaRecraft(croppedUrl);
      postUpscaleUrl = upscale.url;
    }
  } else if (spec.provider === 'kie' || spec.provider === undefined) {
    // `provider === undefined` is the back-compat path — older registry
    // entries that pre-date the explicit discriminator default to kie.
    providerUsed = 'kie';
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) {
      throw new Error('KIE_API_KEY is not configured');
    }
    if (!spec.kieModel) {
      throw new Error(`[image-dispatch] kie spec '${spec.value}' missing kieModel`);
    }
    const taskId = await createKieTask(apiKey, spec.kieModel, buildKieImageInput(spec.value, prompt));
    postUpscaleUrl = await pollKieResultThenUpscale(taskId, apiKey);
  } else {
    // 'comfyui-local' or any future provider — caller error.
    throw new Error(
      `[image-dispatch] unsupported provider '${spec.provider}' for model '${spec.value}' — local generation has its own per-route LOCAL_STUDIO path`,
    );
  }

  // ─── Final R2 mirror ───────────────────────────────────────────────────
  // Fetch the post-upscale bytes once and reuse them for both the R2 upload
  // and the return value (so the caller can compute saliency without a
  // second fetch). Mirror failure falls back to returning the upstream
  // URL — the image is still usable until the CDN expires.
  let url = postUpscaleUrl;
  let bytes: Buffer | undefined;
  try {
    const res = await fetch(postUpscaleUrl);
    if (res.ok) {
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      bytes = Buffer.from(await res.arrayBuffer());
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      const bucket = getImagesBucket();
      const r2Key = `${finalPrefix}/${Date.now()}-${randomSuffix()}.${ext}`;
      await uploadToBucket(bucket, r2Key, bytes, contentType);
      url = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
    } else {
      logger.warn('[image-dispatch] final mirror fetch failed', {
        status: res.status,
        url_preview: postUpscaleUrl.slice(0, 80),
      });
    }
  } catch (err) {
    logger.warn('[image-dispatch] final mirror errored', {
      detail: err instanceof Error ? err.message : String(err),
      url_preview: postUpscaleUrl.slice(0, 80),
    });
  }

  return {
    url,
    bytes,
    providerUsed,
    durationMs: Date.now() - t0,
  };
}

/**
 * Center-crop a 3:2 (or wider-than-16:9, or any aspect) image to a strict
 * 16:9, upload the cropped bytes to R2, return the R2 URL. Caller-visible
 * for the Atlas path; exposed for tests + the (future) collage route's
 * Atlas branch.
 *
 * Throws on fetch / sharp / upload failures — the Atlas branch can't pass
 * a 3:2 image downstream, so failing visible is the safer posture.
 */
export async function cropTo16x9AndUpload(srcUrl: string, r2KeyPrefix: string): Promise<string> {
  const t0 = Date.now();
  const res = await fetch(srcUrl);
  if (!res.ok) {
    throw new Error(`[image-dispatch crop] fetch failed: HTTP ${res.status}`);
  }
  const srcBuf = Buffer.from(await res.arrayBuffer());

  const meta = await sharp(srcBuf).metadata();
  if (typeof meta.width !== 'number' || typeof meta.height !== 'number') {
    throw new Error('[image-dispatch crop] sharp metadata missing width/height');
  }
  const srcW = meta.width;
  const srcH = meta.height;

  // Target geometry: keep full width, compute the 16:9 height. If the
  // source is already taller than 16:9 (any landscape ratio < 1.778), we
  // shrink height; if the source is wider than 16:9 (won't happen for
  // Atlas's 1536×1024 but defensive for callers), we shrink width instead.
  const srcAspect = srcW / srcH;
  const targetAspect = 16 / 9;

  let cropW: number;
  let cropH: number;
  if (srcAspect < targetAspect) {
    // Source is taller than 16:9 — trim top + bottom equally.
    cropW = srcW;
    cropH = Math.round(srcW / targetAspect);
  } else {
    // Source is wider than (or exactly) 16:9 — trim left + right equally.
    cropW = Math.round(srcH * targetAspect);
    cropH = srcH;
  }
  const left = Math.round((srcW - cropW) / 2);
  const top = Math.round((srcH - cropH) / 2);

  const croppedJpeg = await sharp(srcBuf)
    .extract({ left, top, width: cropW, height: cropH })
    .jpeg({ quality: 92 })
    .toBuffer();

  const bucket = getImagesBucket();
  const r2Key = `${r2KeyPrefix}/${Date.now()}-${randomSuffix()}.jpg`;
  await uploadToBucket(bucket, r2Key, croppedJpeg, 'image/jpeg');
  const croppedUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);

  logger.info('[image-dispatch] atlas crop', {
    source_w: srcW,
    source_h: srcH,
    target_w: cropW,
    target_h: cropH,
    trimmed_top_px: top,
    trimmed_left_px: left,
    ms: Date.now() - t0,
  });
  return croppedUrl;
}

/** 8-char alnum suffix matching the existing R2 key convention in the
 *  production-doc image route. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
