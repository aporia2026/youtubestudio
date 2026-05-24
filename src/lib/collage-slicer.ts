/**
 * Slice a 2×2 collage image into 4 per-shot images.
 *
 * Pipeline context: the production-doc collage flow generates a single
 * 2×2 grid of 16:9 cells at 1K, runs it through Recraft Crisp Upscale
 * (~4×, see `src/lib/upscale.ts`), then calls this helper to split the
 * upscaled image into 4 per-shot R2-hosted images.
 *
 * Layout
 *   ┌──────┬──────┐
 *   │  0   │  1   │   indices = [top-left, top-right,
 *   ├──────┼──────┤              bottom-left, bottom-right]
 *   │  2   │  3   │
 *   └──────┴──────┘
 *
 * Gutter trimming
 *   The generation prompt asks for a thin neutral border between cells,
 *   and we crop the gutter away here. Two configurable percentages:
 *     - OUTER_TRIM_PCT: shaved from the outer edge of each cell (top
 *       and side that touches the image border) to remove the outer
 *       margin that some models add.
 *     - INNER_TRIM_PCT: shaved from the inner edge of each cell (the
 *       edge that adjoins the centre cross) to guarantee no gutter
 *       pixels survive into the final shot image.
 *   Both default to 1.0%. Tune post-QA once we see real model output.
 */
import sharp from 'sharp';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from './r2';
import { logger } from './logger';

const OUTER_TRIM_PCT = 0.01; // 1% of total image dim on each outer edge
const INNER_TRIM_PCT = 0.01; // 1% of total image dim on each inner edge

export interface CollageSliceResult {
  /** Permanent R2 URLs for the 4 sliced quadrants, in
   *  [top-left, top-right, bottom-left, bottom-right] order. */
  quadrantUrls: [string, string, string, string];
  /** Source dimensions read from the upscaled image. */
  sourceWidth: number;
  sourceHeight: number;
  /** Final per-quadrant dimensions (after trim) — same for all 4. */
  quadrantWidth: number;
  quadrantHeight: number;
  /** Total time spent in slice + upload. */
  totalMs: number;
}

export class CollageSliceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CollageSliceError';
  }
}

/**
 * Fetch the upscaled collage image, slice into 4 quadrants, upload
 * each to R2, return the 4 permanent URLs. Throws `CollageSliceError`
 * on any failure — caller decides whether to fall back to per-shot
 * single calls.
 *
 * Output format is JPEG (smaller files than PNG for photographic
 * content; shot images don't need transparency).
 */
export async function sliceCollage(upscaledUrl: string, opts?: {
  /** R2 key prefix. Default 'prodoc-images-collage'. Useful to override
   *  for the dev/tester endpoint so tester runs don't mix into the
   *  same prefix as real shots. */
  r2KeyPrefix?: string;
}): Promise<CollageSliceResult> {
  const t0 = Date.now();
  const prefix = opts?.r2KeyPrefix ?? 'prodoc-images-collage';

  // Fetch + decode
  let buf: Buffer;
  try {
    const res = await fetch(upscaledUrl);
    if (!res.ok) {
      throw new CollageSliceError(`fetch failed: HTTP ${res.status}`);
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof CollageSliceError) throw err;
    throw new CollageSliceError('failed to fetch upscaled collage', err);
  }

  const meta = await sharp(buf).metadata();
  if (typeof meta.width !== 'number' || typeof meta.height !== 'number') {
    throw new CollageSliceError('sharp metadata missing width/height');
  }
  const W = meta.width;
  const H = meta.height;

  // Compute extract rectangles. Each quadrant occupies a quarter of the
  // image, less the outer trim on its image-edge sides and the inner
  // trim on its centre-cross sides.
  const outerTrimX = Math.round(W * OUTER_TRIM_PCT);
  const outerTrimY = Math.round(H * OUTER_TRIM_PCT);
  const innerTrimX = Math.round(W * INNER_TRIM_PCT);
  const innerTrimY = Math.round(H * INNER_TRIM_PCT);
  const halfW = Math.floor(W / 2);
  const halfH = Math.floor(H / 2);

  // Each quadrant is sharp.extract({ left, top, width, height }).
  // Order matches the index convention in CollageSliceResult.
  const rects: { left: number; top: number; width: number; height: number }[] = [
    // [0] top-left
    {
      left: outerTrimX,
      top: outerTrimY,
      width: halfW - outerTrimX - innerTrimX,
      height: halfH - outerTrimY - innerTrimY,
    },
    // [1] top-right
    {
      left: halfW + innerTrimX,
      top: outerTrimY,
      width: (W - halfW) - innerTrimX - outerTrimX,
      height: halfH - outerTrimY - innerTrimY,
    },
    // [2] bottom-left
    {
      left: outerTrimX,
      top: halfH + innerTrimY,
      width: halfW - outerTrimX - innerTrimX,
      height: (H - halfH) - innerTrimY - outerTrimY,
    },
    // [3] bottom-right
    {
      left: halfW + innerTrimX,
      top: halfH + innerTrimY,
      width: (W - halfW) - innerTrimX - outerTrimX,
      height: (H - halfH) - innerTrimY - outerTrimY,
    },
  ];

  // Sanity — every rect must have positive dimensions and stay inside
  // the source. Most likely failure cause is a 1×1 image, which would
  // produce zero-size cells. Better to error than upload garbage.
  for (let i = 0; i < 4; i++) {
    const r = rects[i];
    if (
      r.width <= 0
      || r.height <= 0
      || r.left + r.width > W
      || r.top + r.height > H
    ) {
      throw new CollageSliceError(
        `quadrant ${i} extract out of bounds: ${JSON.stringify(r)} on source ${W}×${H}`,
      );
    }
  }

  // Extract + upload all 4 in parallel. Sharp pipelines can be reused
  // safely for separate .extract() calls because each call returns a
  // new clone; but we recreate sharp(buf) per quadrant to keep the
  // mental model simple.
  const bucket = getImagesBucket();
  const tsSlug = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uploads = await Promise.all(
    rects.map(async (rect, i) => {
      const t1 = Date.now();
      const jpeg = await sharp(buf).extract(rect).jpeg({ quality: 92 }).toBuffer();
      const r2Key = `${prefix}/${tsSlug}-${i}.jpg`;
      await uploadToBucket(bucket, r2Key, jpeg, 'image/jpeg');
      const url = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      logger.info('[collage slice] quadrant uploaded', {
        index: i,
        rect,
        bytes: jpeg.length,
        ms: Date.now() - t1,
      });
      return url;
    }),
  );

  const result: CollageSliceResult = {
    quadrantUrls: [uploads[0], uploads[1], uploads[2], uploads[3]],
    sourceWidth: W,
    sourceHeight: H,
    quadrantWidth: rects[0].width,
    quadrantHeight: rects[0].height,
    totalMs: Date.now() - t0,
  };
  logger.info('[collage slice] success', {
    source_w: W,
    source_h: H,
    quadrant_w: result.quadrantWidth,
    quadrant_h: result.quadrantHeight,
    total_ms: result.totalMs,
  });
  return result;
}
