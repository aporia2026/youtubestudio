/**
 * Server-side white-fill erase for white-background sketch styles.
 *
 * The CLIENT-side equivalent we shipped earlier in
 * `src/lib/editor/white-fill-erase.ts` failed in production: R2 doesn't
 * send Access-Control-Allow-Origin headers that satisfy the canvas's
 * crossOrigin='anonymous' requirement, so `ctx.getImageData()` taints
 * the canvas and the composite throws. Moving the work to the server
 * eliminates the CORS layer — we fetch both buffers server-to-server,
 * composite with sharp, and upload the result to R2 like every other
 * generated image.
 *
 * Mask polarity matches what `MaskBrushEditor.buildMaskBlob` emits:
 *   - Black pixel in the mask = "regenerate / erase this"
 *   - White pixel = "preserve"
 *
 * Pure(ish) module: depends on sharp, the R2 client, and node fetch.
 * Tested via `tests/erase-white-fill-server.test.ts` (composite logic
 * extracted so the network side stays at the route handler).
 */

import sharp from 'sharp';
import { logger } from '@/lib/logger';
import {
  buildUserUploadKey,
  getImagesBucket,
  getImagesDownloadUrl,
  uploadToBucket,
} from '@/lib/r2';

/** Mask channel value at or below this counts as "black" (= erase here).
 *  The mask builder emits pure 0 for painted pixels, so 8 is a safe
 *  floor against any PNG/JPEG re-encode noise the upload + R2 cycle
 *  introduces. Exported for test parity with the client helper. */
export const MASK_BLACK_RGB_THRESHOLD = 8;

export interface CompositeWhiteFillBuffersArgs {
  /** Source image raw RGBA pixel buffer. Length must be width*height*4. */
  srcRgba: Buffer;
  /** Mask image raw RGBA (or RGB) pixel buffer at the same resolution. */
  maskRgba: Buffer;
  /** Number of bytes per pixel in `srcRgba`. We always normalise to 4
   *  via sharp.ensureAlpha() at the boundary, but the helper accepts
   *  either to keep its arithmetic explicit. */
  srcChannels: 3 | 4;
  /** Same idea for the mask. */
  maskChannels: 3 | 4;
  /** Pixel count: width * height. */
  pixelCount: number;
}

/** Per-pixel composite: where the mask is black, write opaque white into
 *  the source; otherwise pass the source pixel through unchanged.
 *  Allocates a fresh Buffer so the inputs stay clean.
 *
 *  Exported so tests can exercise the pixel logic without touching
 *  sharp or the network. */
export function compositeWhiteFillBuffers(args: CompositeWhiteFillBuffersArgs): Buffer {
  const { srcRgba, maskRgba, srcChannels, maskChannels, pixelCount } = args;
  if (srcRgba.length !== pixelCount * srcChannels) {
    throw new Error(
      `compositeWhiteFillBuffers: src length ${srcRgba.length} != pixelCount ${pixelCount} × srcChannels ${srcChannels}`,
    );
  }
  if (maskRgba.length !== pixelCount * maskChannels) {
    throw new Error(
      `compositeWhiteFillBuffers: mask length ${maskRgba.length} != pixelCount ${pixelCount} × maskChannels ${maskChannels}`,
    );
  }
  const out = Buffer.alloc(srcRgba.length);
  for (let i = 0; i < pixelCount; i++) {
    const sOff = i * srcChannels;
    const mOff = i * maskChannels;
    const isMaskBlack =
      maskRgba[mOff] <= MASK_BLACK_RGB_THRESHOLD
      && maskRgba[mOff + 1] <= MASK_BLACK_RGB_THRESHOLD
      && maskRgba[mOff + 2] <= MASK_BLACK_RGB_THRESHOLD;
    if (isMaskBlack) {
      out[sOff] = 255;
      out[sOff + 1] = 255;
      out[sOff + 2] = 255;
      if (srcChannels === 4) out[sOff + 3] = 255;
    } else {
      out[sOff] = srcRgba[sOff];
      out[sOff + 1] = srcRgba[sOff + 1];
      out[sOff + 2] = srcRgba[sOff + 2];
      if (srcChannels === 4) out[sOff + 3] = srcRgba[sOff + 3];
    }
  }
  return out;
}

/**
 * Fetch the source + mask, composite white over the masked region, and
 * upload the resulting PNG to the images bucket. Returns the persistent
 * download URL ready to drop onto a row via the editor's commitRowImage.
 *
 * Fail-loud: any fetch / decode / upload failure throws with enough
 * context for the route's catch block to surface a clear error to the
 * caller. The editor's MaskBrushEditor wraps the call in a toast.
 */
export async function eraseViaServerWhiteFill(args: {
  sourceImageUrl: string;
  maskImageUrl: string;
}): Promise<string> {
  const t0 = Date.now();
  logger.info('[erase white-fill server] start', {
    srcPreview: args.sourceImageUrl.slice(0, 80),
    maskPreview: args.maskImageUrl.slice(0, 80),
  });
  const [srcRes, maskRes] = await Promise.all([
    fetch(args.sourceImageUrl),
    fetch(args.maskImageUrl),
  ]);
  if (!srcRes.ok) {
    throw new Error(`source image fetch failed (HTTP ${srcRes.status})`);
  }
  if (!maskRes.ok) {
    throw new Error(`mask image fetch failed (HTTP ${maskRes.status})`);
  }
  const [srcAb, maskAb] = await Promise.all([
    srcRes.arrayBuffer(),
    maskRes.arrayBuffer(),
  ]);
  const srcInput = Buffer.from(srcAb);
  const maskInput = Buffer.from(maskAb);
  const srcMeta = await sharp(srcInput).metadata();
  if (!srcMeta.width || !srcMeta.height) {
    throw new Error('source image metadata missing width/height');
  }
  const { width, height } = srcMeta;
  // Force RGBA on the source so the per-pixel arithmetic always has 4
  // bytes per pixel. Resize the mask to the source's dimensions so a
  // mask uploaded at a slightly different resolution (rare but
  // possible if the brush editor's canvas was rounded) still aligns.
  const [srcRaw, maskRaw] = await Promise.all([
    sharp(srcInput).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(maskInput)
      .resize(width, height, { fit: 'fill', kernel: 'nearest' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  const composited = compositeWhiteFillBuffers({
    srcRgba: srcRaw.data,
    maskRgba: maskRaw.data,
    srcChannels: 4,
    maskChannels: 4,
    pixelCount: width * height,
  });
  const png = await sharp(composited, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
  // R2 upload. Same key prefix the user-upload endpoint uses so the
  // bucket layout stays consistent across surfaces.
  const r2Key = buildUserUploadKey(`white-fill-erase-${Date.now()}.png`);
  await uploadToBucket(getImagesBucket(), r2Key, png, 'image/png');
  const downloadUrl = await getImagesDownloadUrl(r2Key);
  logger.info('[erase white-fill server] done', {
    width,
    height,
    bytes: png.length,
    durationMs: Date.now() - t0,
    r2Key,
  });
  return downloadUrl;
}
