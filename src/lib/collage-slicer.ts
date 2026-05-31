/**
 * Slice a collage image into per-cell shot images.
 *
 * Pipeline context: a collage generation flow produces one image
 * containing multiple shots arranged in a grid, runs it through
 * Recraft Crisp Upscale (~4×, see `src/lib/upscale.ts`), then calls
 * one of the helpers below to split the upscaled image into per-cell
 * R2-hosted images.
 *
 * Two entry points, sharing the same crop + upload primitive:
 *   - `sliceCollage(url)` — legacy 2×2 path used by the `collage_mode`
 *     batch-optimization flow. Returns a 4-tuple of URLs. Existing
 *     callers (auto-pipeline + tester + flex-icon-grid stickers + the
 *     collage API route) consume this shape unchanged.
 *   - `sliceCollageGrid(url, {cols, rows})` — generic N×M path used by
 *     the doodle_explainer_2 motion-collage shot kind. Returns
 *     cols×rows URLs in left-to-right, top-to-bottom order.
 *
 * Both helpers delegate to the same per-cell extract+upload loop —
 * `sliceCollage` is now a thin wrapper that calls
 * `sliceCollageGrid({cols:2, rows:2})` and reshapes the result to the
 * legacy 4-tuple shape.
 *
 * Layout — for a 3×2 collage (cols=3, rows=2):
 *   ┌──────┬──────┬──────┐
 *   │  0   │  1   │  2   │   index = row * cols + col
 *   ├──────┼──────┼──────┤
 *   │  3   │  4   │  5   │
 *   └──────┴──────┴──────┘
 *
 * Gutter trimming
 *   The generation prompt asks for a thin neutral border between cells,
 *   and we crop the gutter away here. Two configurable percentages:
 *     - OUTER_TRIM_PCT: shaved from cell edges that touch the image
 *       border (top of top row, left of left column, etc.).
 *     - INNER_TRIM_PCT: shaved from cell edges that touch other cells
 *       (right of cell A when A's right neighbour is cell B).
 *   Both default to 1.0%. Tuned post-QA against real model output;
 *   change them when systematic gutter remnants appear.
 *
 * See _plans/2026-05-31-doodle-explainer-2-motion-collage.md (Phase 1).
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

/** Hard ceiling on total cells per collage call. Bounds spend (a 5×5
 *  collage at 1K would be ~200×200 per cell — useless after slicing)
 *  AND renderer load (MotionCollageScene mounts one `<Sequence>` per
 *  cell). The doc-level `max_grid_panels` setting clamps further
 *  within this; this constant is the absolute floor neither the LLM
 *  nor a misconfigured doc can punch through. */
export const MAX_COLLAGE_CELLS = 16;

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

export interface CollageSliceGridResult {
  /** Permanent R2 URLs for the sliced cells, in left-to-right,
   *  top-to-bottom order (index = row*cols + col). Length equals
   *  cols × rows on success. */
  panelUrls: string[];
  /** Source dimensions read from the upscaled image. */
  sourceWidth: number;
  sourceHeight: number;
  /** First-cell dimensions (after trim). Reported as the "typical"
   *  cell size; the last column / last row may differ by a pixel or
   *  two when source dimensions aren't evenly divisible by the grid.
   *  Callers wanting exact per-cell dimensions should re-derive from
   *  sourceWidth/Height/cols/rows + the trim constants. */
  panelWidth: number;
  panelHeight: number;
  /** Grid echoed back for telemetry. */
  cols: number;
  rows: number;
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
 * Slice an upscaled collage image into 4 quadrants (top-left, top-
 * right, bottom-left, bottom-right) — the legacy 2×2 shape consumed
 * by the `collage_mode` batch path, the collage tester, the flex-
 * icon-grid stickers route, and the standalone collage API route.
 * Internally delegates to `sliceCollageGrid` and reshapes the result
 * into the historic 4-tuple.
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
  const prefix = opts?.r2KeyPrefix ?? 'prodoc-images-collage';
  const grid = await sliceCollageGrid(upscaledUrl, { cols: 2, rows: 2 }, { r2KeyPrefix: prefix });
  const [tl, tr, bl, br] = grid.panelUrls;
  return {
    quadrantUrls: [tl, tr, bl, br],
    sourceWidth: grid.sourceWidth,
    sourceHeight: grid.sourceHeight,
    quadrantWidth: grid.panelWidth,
    quadrantHeight: grid.panelHeight,
    totalMs: grid.totalMs,
  };
}

/**
 * Slice an upscaled collage image into cols × rows per-cell images.
 * Cells are emitted left-to-right, top-to-bottom (index = row*cols+col).
 *
 * Used by the doodle_explainer_2 motion-collage shot kind, where the
 * AI model produces one storyboard image containing N keyframes of a
 * motion arc; the renderer plays the per-cell slices hard-cut over the
 * row's duration. See
 * `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.
 *
 * Throws `CollageSliceError` on invalid grids, fetch failures, sharp
 * metadata gaps, or out-of-bounds crops (e.g. a tiny source image with
 * a large grid that drives a cell's width/height negative after trim).
 */
export async function sliceCollageGrid(
  upscaledUrl: string,
  grid: { cols: number; rows: number },
  opts?: {
    /** R2 key prefix. Default 'prodoc-images-collage-grid'. */
    r2KeyPrefix?: string;
  },
): Promise<CollageSliceGridResult> {
  const t0 = Date.now();
  const { cols, rows } = grid;
  const prefix = opts?.r2KeyPrefix ?? 'prodoc-images-collage-grid';

  // Grid validation — cheap, runs before any IO.
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new CollageSliceError(`grid dimensions must be integers, got cols=${cols} rows=${rows}`);
  }
  if (cols < 1 || rows < 1) {
    throw new CollageSliceError(`grid dimensions must be >= 1, got cols=${cols} rows=${rows}`);
  }
  const totalCells = cols * rows;
  if (totalCells > MAX_COLLAGE_CELLS) {
    throw new CollageSliceError(
      `grid cells exceed hard cap: ${cols}×${rows} = ${totalCells} > ${MAX_COLLAGE_CELLS}`,
    );
  }

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

  // Per-cell raw size. Each cell occupies one slot of a cols×rows grid.
  // Math.floor keeps cell coordinates on integer pixels; the LAST
  // column and LAST row absorb any remainder so the slice covers the
  // entire image with no missing strip on the right / bottom edge.
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);
  const outerTrimX = Math.round(W * OUTER_TRIM_PCT);
  const outerTrimY = Math.round(H * OUTER_TRIM_PCT);
  const innerTrimX = Math.round(W * INNER_TRIM_PCT);
  const innerTrimY = Math.round(H * INNER_TRIM_PCT);

  // Build extract rectangles. For each (col, row):
  //   - left/right edges shave outerTrim when the cell is on the image
  //     border, otherwise innerTrim.
  //   - top/bottom edges shave outerTrim when the cell is on the image
  //     border, otherwise innerTrim.
  //   - The LAST column's right edge sits exactly at W (the cell width
  //     absorbs any remainder); the LAST row's bottom edge sits at H.
  type Rect = { left: number; top: number; width: number; height: number };
  const rects: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rawLeft = c * cellW;
      const rawTop = r * cellH;
      const rawRight = c === cols - 1 ? W : (c + 1) * cellW;
      const rawBottom = r === rows - 1 ? H : (r + 1) * cellH;
      const leftTrim = c === 0 ? outerTrimX : innerTrimX;
      const topTrim = r === 0 ? outerTrimY : innerTrimY;
      const rightTrim = c === cols - 1 ? outerTrimX : innerTrimX;
      const bottomTrim = r === rows - 1 ? outerTrimY : innerTrimY;
      const left = rawLeft + leftTrim;
      const top = rawTop + topTrim;
      const width = rawRight - rawLeft - leftTrim - rightTrim;
      const height = rawBottom - rawTop - topTrim - bottomTrim;
      rects.push({ left, top, width, height });
    }
  }

  // Sanity — every rect must have positive dimensions and stay inside
  // the source. The most likely failure cause is the caller passing a
  // tiny source image with a large grid (trims push width/height
  // negative). Better to error than upload garbage.
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (
      rect.width <= 0
      || rect.height <= 0
      || rect.left + rect.width > W
      || rect.top + rect.height > H
    ) {
      throw new CollageSliceError(
        `cell ${i} (col=${i % cols}, row=${Math.floor(i / cols)}) extract out of bounds: ${JSON.stringify(rect)} on source ${W}×${H}`,
      );
    }
  }

  // Extract + upload all cells in parallel. We recreate sharp(buf) per
  // cell to keep the mental model simple; sharp pipelines are cheap to
  // initialize and each .extract() call is independent.
  const bucket = getImagesBucket();
  const tsSlug = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uploads = await Promise.all(
    rects.map(async (rect, i) => {
      const t1 = Date.now();
      const jpeg = await sharp(buf).extract(rect).jpeg({ quality: 92 }).toBuffer();
      const r2Key = `${prefix}/${tsSlug}-${i}.jpg`;
      await uploadToBucket(bucket, r2Key, jpeg, 'image/jpeg');
      const url = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      logger.info('[collage slice] cell uploaded', {
        index: i,
        col: i % cols,
        row: Math.floor(i / cols),
        rect,
        bytes: jpeg.length,
        ms: Date.now() - t1,
      });
      return url;
    }),
  );

  const result: CollageSliceGridResult = {
    panelUrls: uploads,
    sourceWidth: W,
    sourceHeight: H,
    panelWidth: rects[0].width,
    panelHeight: rects[0].height,
    cols,
    rows,
    totalMs: Date.now() - t0,
  };
  logger.info('[collage slice] success', {
    cols,
    rows,
    cells: rects.length,
    source_w: W,
    source_h: H,
    panel_w: result.panelWidth,
    panel_h: result.panelHeight,
    total_ms: result.totalMs,
  });
  return result;
}
