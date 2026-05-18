/**
 * Heuristic gate for Bria RMBG output — Phase 4 of
 * `_plans/2026-05-18-overlay-system-overhaul.md`.
 *
 * RMBG-2.0 is good but not perfect. Two common failure modes:
 *
 *   - "Eats everything": RMBG misreads the subject as background and
 *     produces a near-blank cutout. alphaCoverage < 5%.
 *   - "Halo bleed": RMBG leaves a soft frame of semi-transparent pixels
 *     around the image, which composites as a visible rectangle on
 *     real scenes. edgeHaloBleed > 40% average alpha at the perimeter.
 *
 * A third mode — "shattered subject" — RMBG slices a logo into many
 * disconnected fragments. componentCount > 5 for a single-logo source
 * is a red flag.
 *
 * The decision tree (per plan):
 *   alphaCoverage < 0.05   → revert-original  (RMBG ate everything)
 *   alphaCoverage > 0.95   → revert-original  (RMBG did nothing)
 *   edgeHaloBleed > 0.40   → ambiguous        (halo — vision tiebreaker)
 *   componentCount > 5     → ambiguous        (shattered — vision tiebreaker)
 *   otherwise              → keep-rmbg        (clean cutout)
 *
 * No network calls — this is pure CPU on the bytes we already have.
 * For a typical 1024×1024 PNG the whole pass takes under 100 ms.
 */
import sharp from 'sharp';

export type RmbgGateDecision = 'keep-rmbg' | 'revert-original' | 'ambiguous';

export interface RmbgGateResult {
  decision: RmbgGateDecision;
  /** Fraction of pixels with alpha > 10 in the cutout (0..1). */
  alphaCoverage: number;
  /** Average alpha at the perimeter (shrunk by 2 px), normalised 0..1.
   *  High = RMBG left a soft halo at the edges. */
  edgeHaloBleed: number;
  /** Count of disconnected opaque blobs ≥ 1% of image area. >1 on a
   *  single-logo source suggests RMBG shattered the subject. */
  componentCount: number;
  /** Plain-English summary of why this decision was made — surfaced in
   *  the telemetry log. */
  reason: string;
}

/** Sample at this resolution before measuring — keeps the cost bounded
 *  regardless of input size. 200×200 is large enough to preserve halo
 *  + component detection accuracy and small enough that the whole pass
 *  runs well under 100 ms. */
const SAMPLE_SIZE = 200;

/** Alpha > this counts as "opaque" for coverage / component analysis.
 *  Set above 0 to ignore noise pixels that RMBG sometimes leaves as
 *  1-2 alpha rather than truly 0. */
const ALPHA_THRESHOLD = 10;

/** Alpha threshold for "perimeter halo" detection — higher than the
 *  basic opacity threshold so a fully feathered border still counts as
 *  halo bleed at this sample point. */
const HALO_ALPHA_NORMALIZER = 255;

const MIN_COMPONENT_FRACTION = 0.01;

/** Decision-tree cutoffs (per plan). Exposed as constants so a future
 *  data-driven tuning pass can sweep them without code changes. */
export const ALPHA_COVERAGE_MIN = 0.05;
export const ALPHA_COVERAGE_MAX = 0.95;
export const EDGE_HALO_THRESHOLD = 0.4;
export const MAX_COMPONENT_COUNT = 5;

/**
 * Run the heuristic gate on RMBG output bytes. The result tells the
 * caller whether the cutout is safe to ship, should be discarded for
 * the original, or needs a vision LLM tiebreaker.
 */
export async function gateRmbgOutput(rmbgBytes: Buffer): Promise<RmbgGateResult> {
  const { data, info } = await sharp(rmbgBytes)
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixelCount = width * height;

  // ── alphaCoverage ───────────────────────────────────────────────────
  let opaqueCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    const alphaIdx = i * channels + 3;
    if (data[alphaIdx]! > ALPHA_THRESHOLD) opaqueCount++;
  }
  const alphaCoverage = opaqueCount / pixelCount;

  // ── edgeHaloBleed ───────────────────────────────────────────────────
  // Sample the alpha channel along a perimeter ring 2 px in from the
  // edge. We dodge the absolute outermost pixels because sharp's
  // antialiased resize can leave the outermost row/column with
  // sub-pixel artifacts that aren't representative of the real halo.
  const margin = 2;
  let perimeterAlphaSum = 0;
  let perimeterPixels = 0;
  if (width > 2 * margin && height > 2 * margin) {
    // Top + bottom horizontal strips
    for (let x = margin; x < width - margin; x++) {
      perimeterAlphaSum += data[(margin * width + x) * channels + 3]!;
      perimeterAlphaSum += data[((height - 1 - margin) * width + x) * channels + 3]!;
      perimeterPixels += 2;
    }
    // Left + right vertical strips, excluding the corners already counted
    for (let y = margin + 1; y < height - margin - 1; y++) {
      perimeterAlphaSum += data[(y * width + margin) * channels + 3]!;
      perimeterAlphaSum += data[(y * width + width - 1 - margin) * channels + 3]!;
      perimeterPixels += 2;
    }
  }
  const edgeHaloBleed =
    perimeterPixels > 0 ? perimeterAlphaSum / perimeterPixels / HALO_ALPHA_NORMALIZER : 0;

  // ── componentCount ──────────────────────────────────────────────────
  const componentCount = countSignificantComponents(
    data,
    width,
    height,
    channels,
    Math.floor(pixelCount * MIN_COMPONENT_FRACTION),
  );

  // ── Decision ────────────────────────────────────────────────────────
  let decision: RmbgGateDecision;
  let reason: string;
  if (alphaCoverage < ALPHA_COVERAGE_MIN) {
    decision = 'revert-original';
    reason = `RMBG ate everything (alphaCoverage ${alphaCoverage.toFixed(2)} < ${ALPHA_COVERAGE_MIN})`;
  } else if (alphaCoverage > ALPHA_COVERAGE_MAX) {
    decision = 'revert-original';
    reason = `RMBG did nothing (alphaCoverage ${alphaCoverage.toFixed(2)} > ${ALPHA_COVERAGE_MAX})`;
  } else if (edgeHaloBleed > EDGE_HALO_THRESHOLD) {
    decision = 'ambiguous';
    reason = `Halo bleed at edges (${(edgeHaloBleed * 100).toFixed(0)}% > ${EDGE_HALO_THRESHOLD * 100}%)`;
  } else if (componentCount > MAX_COMPONENT_COUNT) {
    decision = 'ambiguous';
    reason = `Subject shattered into ${componentCount} components (> ${MAX_COMPONENT_COUNT})`;
  } else {
    decision = 'keep-rmbg';
    reason = `Clean cutout — coverage ${(alphaCoverage * 100).toFixed(0)}%, halo ${(edgeHaloBleed * 100).toFixed(0)}%, ${componentCount} component(s)`;
  }

  return {
    decision,
    alphaCoverage: roundTo(alphaCoverage, 3),
    edgeHaloBleed: roundTo(edgeHaloBleed, 3),
    componentCount,
    reason,
  };
}

/** BFS flood-fill to count connected opaque components. Uses a head
 *  pointer instead of `Array.shift()` so the whole pass is O(N) in
 *  the pixel count. Only components ≥ `minSize` pixels count toward
 *  the return value — tiny stray dots are ignored. */
function countSignificantComponents(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  minSize: number,
): number {
  const visited = new Uint8Array(width * height);
  let significantCount = 0;

  for (let startY = 0; startY < height; startY++) {
    for (let startX = 0; startX < width; startX++) {
      const startIdx = startY * width + startX;
      if (visited[startIdx]) continue;
      const startAlpha = data[startIdx * channels + 3]!;
      if (startAlpha <= ALPHA_THRESHOLD) {
        visited[startIdx] = 1;
        continue;
      }

      // BFS — head pointer keeps each push O(1) and the whole flood O(N).
      const queue: number[] = [startIdx];
      visited[startIdx] = 1;
      let head = 0;
      let size = 0;
      while (head < queue.length) {
        const cur = queue[head]!;
        head++;
        size++;
        const cx = cur % width;
        const cy = Math.floor(cur / width);
        // 4-connectivity is plenty for "is this one blob"; 8-connectivity
        // would just merge components separated by 1-pixel diagonal gaps,
        // which we don't actually want.
        const neighbours: Array<[number, number]> = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (visited[nIdx]) continue;
          visited[nIdx] = 1;
          const nAlpha = data[nIdx * channels + 3]!;
          if (nAlpha > ALPHA_THRESHOLD) queue.push(nIdx);
        }
      }

      if (size >= minSize) significantCount++;
    }
  }

  return significantCount;
}

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
