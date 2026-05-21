/**
 * Compute the exact pixel canvas a generated still should target so it
 * lands pixel-clean inside the Remotion composition that will display it.
 *
 * The long-form composition is 1920 × 1080. A section-title stripe sits
 * at the top of the frame and consumes a fraction of the height. When
 * the row's stripe layout is `letterbox`, the b-roll area shrinks to
 * `1080 − stripePx`. Generating at that exact canvas means the image
 * fills the visible area without scaling or cropping. When the layout
 * is `overlay` (or there's no stripe), the image stays full-frame and
 * the stripe — if any — draws on top of it at render time.
 *
 * Width/height are snapped to a model-required grid (Flux/Qwen/HiDream
 * accept multiples of 8; Wan i2v requires 32). The generator at
 * `src/lib/visual-generator/comfyui-local.ts` already snaps to 8 as a
 * safety net, so re-snapping here is defense-in-depth.
 *
 * See `_plans/2026-05-21-resolution-aware-generation.md`.
 */
import { clampSectionStripeFraction } from '@/remotion/components/SectionTitleStripe';

export interface CanvasInput {
  /** When non-empty, the row has a section-title stripe at render time. */
  sectionTitle?: string | null;
  /** How the stripe interacts with the image. Defaults to `'letterbox'` when
   *  a stripe is present (matches the production-doc fallback). */
  sectionTitleLayout?: 'overlay' | 'letterbox';
  /** Stripe height as a fraction of frame height. Optional override —
   *  defaults to the SectionTitleStripe default (0.13). Clamped to
   *  [0.06, 0.22] by `clampSectionStripeFraction`. */
  stripeFraction?: number;
  /** Composition height in pixels. Defaults to 1080 (long-form YouTube). */
  frameHeight?: number;
  /** Composition width in pixels. Defaults to 1920 (long-form YouTube). */
  frameWidth?: number;
  /** Pixel grid the generator requires. Flux/Qwen/HiDream → 8.
   *  Wan i2v → 32. Defaults to 8. */
  grid?: 8 | 16 | 32;
}

export interface CanvasResult {
  width: number;
  height: number;
  /** True when the section-title stripe is letterboxed (image area shrinks). */
  letterboxed: boolean;
  /** Stripe height in pixels (0 when no stripe or overlay layout). */
  stripeHeightPx: number;
}

const DEFAULT_FRAME_WIDTH = 1920;
const DEFAULT_FRAME_HEIGHT = 1080;
const DEFAULT_GRID = 8;

/** Snap a raw pixel count to the nearest multiple of `grid`. Uses round-to-
 *  nearest to keep the canvas as close to the visible area as possible —
 *  the worst-case mismatch is `grid / 2` pixels, which Remotion's render
 *  absorbs invisibly via its `object-fit: cover` default. */
function snapToGrid(raw: number, grid: number): number {
  return Math.round(raw / grid) * grid;
}

export function computeImageCanvas(input: CanvasInput = {}): CanvasResult {
  const frameWidth = input.frameWidth ?? DEFAULT_FRAME_WIDTH;
  const frameHeight = input.frameHeight ?? DEFAULT_FRAME_HEIGHT;
  const grid = input.grid ?? DEFAULT_GRID;

  const hasStripe = Boolean(input.sectionTitle?.trim());
  // When a stripe is present but no layout specified, fall back to
  // 'letterbox' — same default the production-doc resolves at render time.
  const layout: 'overlay' | 'letterbox' = hasStripe
    ? (input.sectionTitleLayout ?? 'letterbox')
    : 'overlay';

  const letterboxed = hasStripe && layout === 'letterbox';
  const fraction = clampSectionStripeFraction(input.stripeFraction);
  const stripeHeightPx = letterboxed ? Math.round(frameHeight * fraction) : 0;

  const rawWidth = frameWidth;
  const rawHeight = frameHeight - stripeHeightPx;

  return {
    width: snapToGrid(rawWidth, grid),
    height: snapToGrid(rawHeight, grid),
    letterboxed,
    stripeHeightPx,
  };
}
