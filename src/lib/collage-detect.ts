/**
 * Detect malformed 2×2 collage generations.
 *
 * Diffusion models occasionally return a collage that's missing one or
 * more cells (blank fill, repeated cell, or solid colour). These pass
 * upscale + slicing without complaint and land in the user's editor as
 * a uniform grey or white image. This module catches the common failure
 * modes BEFORE we commit the quadrants to the doc, so the collage path
 * can retry once and then fall back to per-shot single calls.
 *
 * Heuristic stack, cheapest first:
 *   1. Histogram dominance — if any quadrant is >90% one colour bucket,
 *      it's almost certainly blank fill (the model painted a flat colour
 *      where a scene should be). Cheap: sharp's raw pixel buffer + a
 *      256-bucket reduction.
 *   2. Edge density via Sobel — if any quadrant has near-zero edge
 *      response, it's a smooth gradient or solid fill. Catches the
 *      blurred-fill failure mode that histogram alone misses.
 *
 * Returns a per-quadrant `valid` flag + an overall verdict. The caller
 * decides what to do with that — currently: retry once if any quadrant
 * is invalid, then fall back to per-shot single calls.
 *
 * LLM-vision check is deliberately not v1 — too slow + costly for the
 * routine path. The heuristics here are good enough to catch the
 * 80% of obvious failures and ship a feedback loop quickly.
 */
import sharp from 'sharp';
import { logger } from './logger';

const HISTOGRAM_DOMINANCE_THRESHOLD = 0.9; // 90% pixels in one bucket → blank
const EDGE_DENSITY_THRESHOLD = 5; // Sobel mean below this → too flat

export interface QuadrantDiagnostics {
  /** Whether this quadrant looks like a real generation (not blank/flat). */
  valid: boolean;
  /** Reason the quadrant failed, if any. */
  reason?: 'histogram_dominant' | 'edge_density_low';
  /** Diagnostics for logging — useful when tuning thresholds. */
  dominantBucketFraction: number;
  edgeDensity: number;
}

export interface CollageDetectResult {
  /** Per-quadrant diagnostics. Indices match the slicer order:
   *  [top-left, top-right, bottom-left, bottom-right]. */
  quadrants: [QuadrantDiagnostics, QuadrantDiagnostics, QuadrantDiagnostics, QuadrantDiagnostics];
  /** Overall verdict — true when every quadrant looks valid. */
  allValid: boolean;
  /** Indices of quadrants that failed, for log + UI summary. */
  malformedIndices: number[];
  /** Total time spent detecting. */
  totalMs: number;
}

/**
 * Run detection against the upscaled collage image bytes. Caller passes
 * the buffer (the slicer + this detector are typically both called on
 * the same fetch, so passing bytes avoids a second download).
 */
export async function detectMalformedCollage(buf: Buffer): Promise<CollageDetectResult> {
  const t0 = Date.now();
  const meta = await sharp(buf).metadata();
  if (typeof meta.width !== 'number' || typeof meta.height !== 'number') {
    // Can't probe shape — defensive: assume valid, the slicer will
    // catch genuine corruption with its own error path.
    logger.warn('[collage detect] missing dimensions, assuming valid');
    return {
      quadrants: [
        emptyDiagnostic(),
        emptyDiagnostic(),
        emptyDiagnostic(),
        emptyDiagnostic(),
      ],
      allValid: true,
      malformedIndices: [],
      totalMs: Date.now() - t0,
    };
  }
  const W = meta.width;
  const H = meta.height;
  const halfW = Math.floor(W / 2);
  const halfH = Math.floor(H / 2);

  // Extract each quadrant at a downsampled resolution — we only need
  // statistical signal, not pixel fidelity. Resize to 256px wide first;
  // the histogram + Sobel run on the small version.
  const rects: { left: number; top: number; width: number; height: number }[] = [
    { left: 0,     top: 0,     width: halfW,         height: halfH },
    { left: halfW, top: 0,     width: W - halfW,     height: halfH },
    { left: 0,     top: halfH, width: halfW,         height: H - halfH },
    { left: halfW, top: halfH, width: W - halfW,     height: H - halfH },
  ];

  const diagnostics = await Promise.all(rects.map(async (rect): Promise<QuadrantDiagnostics> => {
    // Downsample to 256px wide to keep per-quadrant cost minimal.
    const small = await sharp(buf)
      .extract(rect)
      .resize({ width: 256, fit: 'inside' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = small.data;
    const info = small.info;
    // 1) Histogram dominance — bucket the 8-bit greyscale into 16 buckets
    // and check the largest bucket's share. 16 buckets is granular
    // enough to catch single-colour fills without false-positiving on
    // intentional flat-background scenes (sky, walls) that legitimately
    // dominate ~70-80% of one bucket but not 90%.
    const buckets = new Uint32Array(16);
    for (let i = 0; i < pixels.length; i++) {
      buckets[pixels[i] >> 4]++;
    }
    let maxBucket = 0;
    for (let i = 0; i < 16; i++) {
      if (buckets[i] > maxBucket) maxBucket = buckets[i];
    }
    const dominantFraction = maxBucket / pixels.length;

    // 2) Edge density — mean absolute response of a 3×3 Sobel kernel.
    // Single-pass implementation: skip the border pixel and only walk
    // the interior, since the kernel needs all 9 neighbours.
    const w = info.width;
    const h = info.height;
    let edgeSum = 0;
    let edgeCount = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const tl = pixels[(y - 1) * w + (x - 1)];
        const t  = pixels[(y - 1) * w + x];
        const tr = pixels[(y - 1) * w + (x + 1)];
        const l  = pixels[y * w + (x - 1)];
        const r  = pixels[y * w + (x + 1)];
        const bl = pixels[(y + 1) * w + (x - 1)];
        const b  = pixels[(y + 1) * w + x];
        const br = pixels[(y + 1) * w + (x + 1)];
        // Sobel X = -tl - 2l - bl + tr + 2r + br
        // Sobel Y = -tl - 2t - tr + bl + 2b + br
        const gx = (-tl - 2 * l - bl) + (tr + 2 * r + br);
        const gy = (-tl - 2 * t - tr) + (bl + 2 * b + br);
        edgeSum += Math.abs(gx) + Math.abs(gy);
        edgeCount++;
      }
    }
    const edgeDensity = edgeCount > 0 ? edgeSum / edgeCount : 0;

    // Verdict — fail on either signal. Order matters for the `reason`
    // field; histogram dominance is the more specific cause when both
    // trigger (a flat single-colour quadrant trips both).
    if (dominantFraction > HISTOGRAM_DOMINANCE_THRESHOLD) {
      return {
        valid: false,
        reason: 'histogram_dominant',
        dominantBucketFraction: dominantFraction,
        edgeDensity,
      };
    }
    if (edgeDensity < EDGE_DENSITY_THRESHOLD) {
      return {
        valid: false,
        reason: 'edge_density_low',
        dominantBucketFraction: dominantFraction,
        edgeDensity,
      };
    }
    return {
      valid: true,
      dominantBucketFraction: dominantFraction,
      edgeDensity,
    };
  }));

  const malformedIndices = diagnostics
    .map((d, i) => (d.valid ? -1 : i))
    .filter((i): i is number => i >= 0);

  const result: CollageDetectResult = {
    quadrants: [diagnostics[0], diagnostics[1], diagnostics[2], diagnostics[3]],
    allValid: malformedIndices.length === 0,
    malformedIndices,
    totalMs: Date.now() - t0,
  };
  logger.info('[collage detect] result', {
    all_valid: result.allValid,
    malformed_indices: malformedIndices,
    diagnostics: diagnostics.map((d, i) => ({
      i,
      valid: d.valid,
      reason: d.reason,
      dom_frac: Number(d.dominantBucketFraction.toFixed(3)),
      edge: Number(d.edgeDensity.toFixed(2)),
    })),
    total_ms: result.totalMs,
  });
  return result;
}

function emptyDiagnostic(): QuadrantDiagnostics {
  return {
    valid: true,
    dominantBucketFraction: 0,
    edgeDensity: 0,
  };
}
