/**
 * Pixel-saliency analysis for production-doc row images.
 *
 * Splits an image into a small grid (default 4 cols × 3 rows) and assigns
 * each cell two numbers:
 *
 *   - `busyness` (0..1): how visually loaded the cell is. Higher = more
 *     edges / contrast / content. Used to *avoid* overlays landing on
 *     focal content.
 *   - `dominantColor` (`#RRGGBB`): the cell's average RGB. Used to give
 *     overlays a halo color that ties them to their local environment.
 *
 * The busyness proxy is **brightness standard deviation** within the cell:
 *   - Flat sky / clean wall  →  low stdev → empty
 *   - Text, faces, busy art  →  high stdev → busy
 *
 * It's a coarse proxy — not Sobel-grade edge detection — but free,
 * deterministic, and good enough to pick "the least cluttered quadrant"
 * for an overlay. Scores are normalized 0..1 relative to the image's
 * own min/max so a uniformly-busy image still has an emptiest cell.
 *
 * Implementation note: we resize the source to a fixed 80×60 grid sample
 * before reading raw pixels, so the pipeline is O(constant) regardless
 * of input size — typically <50 ms for any source.
 */

import sharp from 'sharp';
import type { ImageSaliencyMap } from '@/remotion/utils';

/** Sample resolution used internally — must be a multiple of GRID_COLS / GRID_ROWS. */
const SAMPLE_WIDTH = 80;
const SAMPLE_HEIGHT = 60;
const GRID_COLS = 4;
const GRID_ROWS = 3;

const CELL_W = SAMPLE_WIDTH / GRID_COLS;   // 20 px
const CELL_H = SAMPLE_HEIGHT / GRID_ROWS;  // 20 px

/** Convert a 0..255 channel triple to lowercase `#rrggbb` hex. */
function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    [r, g, b]
      .map((c) => clamp(c).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Compute the saliency map of an image buffer.
 *
 * Returns `null` (rather than throwing) if `sharp` can't decode the
 * input — the caller is expected to log and skip, not crash the
 * image-generation route.
 */
export async function computeImageSaliency(
  buf: Buffer,
): Promise<ImageSaliencyMap | null> {
  let raw: Buffer;
  try {
    const { data } = await sharp(buf)
      // `fill` ignores aspect so the cell grid is uniform regardless of
      // source aspect — we're not preserving any specific ratio, we're
      // sampling content density.
      .resize(SAMPLE_WIDTH, SAMPLE_HEIGHT, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    raw = data;
  } catch (err) {
    // Don't throw — the caller falls back to LLM-zone placement when
    // saliency isn't available.
    console.warn('[saliency compute] sharp decode failed', { err: String(err) });
    return null;
  }

  const cellCount = GRID_COLS * GRID_ROWS;
  // First pass: per-cell sum of brightness, sum-of-squares of brightness,
  // and sum of R/G/B. One linear walk of the 14400-byte buffer.
  const yMean = new Array<number>(cellCount).fill(0);
  const ySqMean = new Array<number>(cellCount).fill(0);
  const rMean = new Array<number>(cellCount).fill(0);
  const gMean = new Array<number>(cellCount).fill(0);
  const bMean = new Array<number>(cellCount).fill(0);

  for (let py = 0; py < SAMPLE_HEIGHT; py++) {
    const cy = Math.min(GRID_ROWS - 1, Math.floor(py / CELL_H));
    for (let px = 0; px < SAMPLE_WIDTH; px++) {
      const cx = Math.min(GRID_COLS - 1, Math.floor(px / CELL_W));
      const cell = cy * GRID_COLS + cx;
      const i = (py * SAMPLE_WIDTH + px) * 3;
      const r = raw[i];
      const g = raw[i + 1];
      const b = raw[i + 2];
      // Rec.601 luma — same coefficients sRGB uses for monitor luminance.
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      yMean[cell] += y;
      ySqMean[cell] += y * y;
      rMean[cell] += r;
      gMean[cell] += g;
      bMean[cell] += b;
    }
  }

  const samplesPerCell = CELL_W * CELL_H;
  const busynessRaw = new Array<number>(cellCount);
  const dominantColors = new Array<string>(cellCount);

  for (let i = 0; i < cellCount; i++) {
    const mean = yMean[i] / samplesPerCell;
    const variance = Math.max(0, ySqMean[i] / samplesPerCell - mean * mean);
    busynessRaw[i] = Math.sqrt(variance);
    dominantColors[i] = rgbToHex(
      rMean[i] / samplesPerCell,
      gMean[i] / samplesPerCell,
      bMean[i] / samplesPerCell,
    );
  }

  // Normalize busyness to 0..1 relative to this image's own min/max so
  // "least busy" is meaningful even on uniformly-busy or uniformly-flat
  // images. A 1-px-wide guard band on the divisor prevents NaN when the
  // whole image is one tone.
  const minB = Math.min(...busynessRaw);
  const maxB = Math.max(...busynessRaw);
  const span = Math.max(maxB - minB, 1e-6);
  const busyness = busynessRaw.map((v) => (v - minB) / span);

  return {
    cols: GRID_COLS,
    rows: GRID_ROWS,
    busyness,
    dominantColors,
  };
}
