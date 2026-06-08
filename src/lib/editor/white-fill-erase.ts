/**
 * Client-side white-fill erase for white-background sketch styles.
 *
 * Replaces the Ideogram v3-edit round-trip with a deterministic canvas
 * composite: load the source image + the brush mask (both PNGs hosted
 * on R2), draw the source onto a working canvas, then paint pure white
 * over every pixel where the mask is black. The result is uploaded
 * back to R2 via `/api/uploads/image` and the returned URL replaces
 * the row's image — same UX, no AI call.
 *
 * Mask polarity matches what `MaskBrushEditor.buildMaskBlob` emits:
 *   - Black pixel in the mask = "regenerate / erase this"
 *   - White pixel = "preserve"
 * The mask is a binary PNG at the source's natural pixel dimensions.
 *
 * Browser-only — uses HTMLImageElement + canvas. Don't import on the
 * server. Tested in `tests/white-fill-erase.test.ts` (pure helpers
 * extracted so the canvas-bound function stays thin).
 */

/** Threshold below which a mask RGB channel counts as "black". The
 *  client-side mask builder emits pure 0 for painted areas, so 8 is a
 *  safe floor against any JPEG/PNG compression noise. */
const MASK_BLACK_RGB_THRESHOLD = 8;

export interface WhiteFillResult {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Pure helper — given the source image RGBA bytes and the mask RGBA
 * bytes (both already loaded into Uint8ClampedArrays of equal length),
 * return a NEW RGBA array where every pixel under a "black" mask pixel
 * has been replaced with opaque white.
 *
 * Exported so unit tests can verify the pixel logic without a canvas.
 */
export function compositeWhiteFill(
  src: Uint8ClampedArray,
  mask: Uint8ClampedArray,
): Uint8ClampedArray {
  if (src.length !== mask.length) {
    throw new Error(
      `compositeWhiteFill: src/mask byte-length mismatch (src=${src.length}, mask=${mask.length})`,
    );
  }
  if (src.length % 4 !== 0) {
    throw new Error(`compositeWhiteFill: src length ${src.length} is not a multiple of 4`);
  }
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const isMaskBlack =
      mask[i] <= MASK_BLACK_RGB_THRESHOLD
      && mask[i + 1] <= MASK_BLACK_RGB_THRESHOLD
      && mask[i + 2] <= MASK_BLACK_RGB_THRESHOLD;
    if (isMaskBlack) {
      out[i] = 255;
      out[i + 1] = 255;
      out[i + 2] = 255;
      out[i + 3] = 255;
    } else {
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = src[i + 3];
    }
  }
  return out;
}

/** Load an image URL into a same-origin HTMLImageElement. Sets crossOrigin
 *  so the resulting canvas isn't tainted (required for getImageData). */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/** Draw `img` onto a 2D canvas at its natural pixel dimensions and
 *  return the RGBA byte array. Throws when the browser refuses to
 *  produce a 2D context (very old browsers / locked-down environments). */
function readImageBytes(img: HTMLImageElement): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for image read');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

/**
 * Produce a PNG blob of `sourceImageUrl` with the masked region painted
 * pure white. Browser-only — uses fetch/Image/canvas. The two inputs
 * must come from CORS-enabled origins (R2 with appropriate headers).
 */
export async function buildWhiteFillBlob(args: {
  sourceImageUrl: string;
  maskImageUrl: string;
}): Promise<WhiteFillResult> {
  const [srcImg, maskImg] = await Promise.all([
    loadImage(args.sourceImageUrl),
    loadImage(args.maskImageUrl),
  ]);
  if (srcImg.naturalWidth !== maskImg.naturalWidth
      || srcImg.naturalHeight !== maskImg.naturalHeight) {
    throw new Error(
      `Source / mask dimension mismatch — source ${srcImg.naturalWidth}x${srcImg.naturalHeight}, mask ${maskImg.naturalWidth}x${maskImg.naturalHeight}`,
    );
  }
  const src = readImageBytes(srcImg);
  const mask = readImageBytes(maskImg);
  const composited = compositeWhiteFill(src.data, mask.data);
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for output canvas');
  // Allocate ImageData via createImageData so its `data` buffer type
  // is the canvas's own — sidesteps the TS 5.x ArrayBufferLike
  // narrowing on the `new ImageData(...)` constructor that some TS
  // configurations reject.
  const imageData = ctx.createImageData(src.width, src.height);
  imageData.data.set(composited);
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => {
      if (!b) reject(new Error('Canvas toBlob returned null'));
      else resolve(b);
    }, 'image/png');
  });
  return { blob, width: src.width, height: src.height };
}

/**
 * Full white-fill erase pipeline: composite + presigned upload to R2.
 * Returns the persistent download URL of the new image, ready to drop
 * onto a row via `commitRowImage`.
 *
 * Mirrors the MaskBrushEditor's existing R2 upload flow so the two
 * paths feel identical from a caller's perspective.
 */
export async function eraseViaWhiteFill(args: {
  sourceImageUrl: string;
  maskImageUrl: string;
}): Promise<string> {
  const { blob } = await buildWhiteFillBlob({
    sourceImageUrl: args.sourceImageUrl,
    maskImageUrl: args.maskImageUrl,
  });
  // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC for presigned URL
  const presignRes = await fetch('/api/uploads/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: `white-fill-erase-${Date.now()}.png`,
      contentType: 'image/png',
      fileSize: blob.size,
    }),
  });
  if (!presignRes.ok) {
    const err = await presignRes.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Presign failed (${presignRes.status})`);
  }
  const { uploadUrl, downloadUrl } = (await presignRes.json()) as {
    uploadUrl: string;
    downloadUrl: string;
  };
  // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC to R2
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: blob,
  });
  if (!putRes.ok) throw new Error(`White-fill upload failed (${putRes.status})`);
  return downloadUrl;
}
