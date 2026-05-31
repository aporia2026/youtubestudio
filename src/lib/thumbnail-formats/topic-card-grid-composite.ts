/**
 * Topic Card Grid — server-side composite step.
 *
 * Runs after the AI image is generated for any thumbnail that includes
 * per-cell user uploads. The AI is told to leave the uploaded cells as
 * clean white backgrounds; this module then deterministically paints the
 * user's exact image bytes (plus a redrawn label) into each reserved cell
 * so the user's upload appears verbatim in the final thumbnail.
 *
 * Why this exists:
 * - GPT Image 2 and friends do not faithfully reproduce a user-supplied
 *   bitmap inside a single cell of a generated grid. i2i blends the
 *   reference, it doesn't paste. Post-composite is the only way to keep
 *   the uploaded image pixel-perfect.
 * - The composite step is decoupled from the prompt path so non-uploaded
 *   generations skip it entirely (zero overhead).
 *
 * Dependencies: `sharp` (native image library) + a bundled Patrick Hand TTF
 * at `public/fonts/PatrickHand-Regular.ttf`. The TTF must exist on disk on
 * the deployed function or the label-rendering call will fail at runtime
 * with a fontconfig error. The plan covers bundling the file in
 * `_plans/2026-05-19-topic-card-grid-circles-and-uploads.md`.
 *
 * Pure-ish module: it uses `sharp` (a native binding) and reads the bundled
 * font file from disk, but otherwise has no Next.js or React imports — it's
 * unit-testable directly via vitest.
 */

import path from 'node:path';
import sharp from 'sharp';
import {
  circleCellGeometry,
  type CardShape,
  type GridLayout,
  type TopicCard,
} from './topic-card-grid';
import {
  DEFAULT_FONT_ID,
  findFontById,
  type ThumbnailFont,
} from './topic-card-grid-fonts';
import { fontFilePath } from './topic-card-grid-fonts-server';
import { applyFilter, type ImageFilter } from './shared-overlay-pipeline';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Absolute path to the bundled label font. Kept as a constant so the
 *  font reference is centralised — if we ever swap fonts, change it here.
 *  Sharp's `fontfile` parameter takes a path; fontconfig wraps the rest. */
export const LABEL_FONT_PATH = path.join(
  process.cwd(),
  'public/fonts/PatrickHand-Regular.ttf',
);
export const LABEL_FONT_FAMILY = 'Patrick Hand';

/** Cap on input pixel count for sharp's decoder. Prevents the well-known
 *  PNG/JPEG "pixel bomb" DoS where a tiny file decodes to gigabytes. 100M
 *  pixels comfortably covers any legitimate thumbnail upload (a 10000×10000
 *  image) without leaving the door open for an 8MB file that expands to
 *  500 megapixels. */
export const SHARP_INPUT_PIXEL_CAP = 100_000_000;

/** White used everywhere the composite paints background. Matches the AI
 *  grid's gutter / label-strip white so the seam between uploaded cells
 *  and AI cells reads as continuous canvas. */
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 } as const;

/** Black for cell borders + label text. */
const BLACK = '#000000';

/** Square-mode illustration region fraction (top portion of the cell). */
const SQUARE_ILLUSTRATION_FRAC = 0.8;
/**
 * Square-mode cell border thickness in canvas pixels. Scales with cell
 * width so a 4K render (cells ~1200 px wide) gets a ~7 px border that's
 * visible against full-bleed photos — a fixed 3 px disappeared at high
 * resolution and made the uploaded image look like it overflowed the
 * border. Floor of 3 px so tiny test canvases keep a hairline border.
 */
function squareBorderPx(cellW: number): number {
  return Math.max(3, Math.round(cellW * 0.006));
}

// ─── Public types ───────────────────────────────────────────────────────────

/** Sharp resize strategy for a per-cell upload. `cover` (default) centre-
 *  crops to fill the cell; `contain` letterboxes the original aspect on a
 *  white background; `fill` stretches to the exact cell rectangle. Wire-
 *  shape mirrors the `fit` field on the route body's uploads array. */
export type UploadFit = 'cover' | 'contain' | 'fill';

/**
 * One cell-upload payload. The route resolves the URL into bytes (with the
 * existing SSRF guard), then hands the bytes here so this module stays
 * free of network code. `cardIndex` is 1-based and matches `TopicCard.index`.
 *
 * `fit` and `filter` are per-upload overrides — when absent the default
 * is cover-fit with no filter, matching the historical behaviour. Both
 * fields are validated server-side before they reach this module; the
 * composite trusts the values verbatim.
 */
export interface CellUpload {
  cardIndex: number;
  /** Raw image bytes — PNG/JPEG/WebP. Sharp will auto-detect the format. */
  bytes: Buffer;
  /** Per-upload fit strategy. Defaults to `'cover'`. */
  fit?: UploadFit;
  /** Per-upload image filter. Defaults to undefined (no filter). */
  filter?: ImageFilter;
}

export interface ApplyCellUploadsInput {
  /** AI-generated image as bytes. Any sharp-supported format works; output
   *  will always be PNG. */
  baseImage: Buffer;
  layout: GridLayout;
  cards: TopicCard[];
  cardShape: CardShape;
  uploads: CellUpload[];
  /** Scales the rendered label font size up or down. Defaults to 1.0
   *  (the canonical size derived from the layout's cell height). The
   *  composite computes one fontPt for the whole grid from the
   *  layout's canonical band height — never from the per-cell detected
   *  band height — so every cell renders its label at the same size
   *  regardless of divider-detection drift. The multiplier scales that
   *  shared fontPt; the caller is responsible for clamping to the
   *  valid range (see LABEL_SIZE_MIN / LABEL_SIZE_MAX in
   *  topic-card-grid.ts). */
  labelSizeMultiplier?: number;
  /** Canonical id of the bundled label font (see
   *  `topic-card-grid-fonts.ts`'s `THUMBNAIL_FONTS`). Unknown ids fall
   *  back to the default silently — no throw, no broken render. Omit
   *  to use Patrick Hand (matches the bundled reference). */
  fontId?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Cell bounding box in canvas pixels for the given 1-based card index.
 * Mirrors the math in `computeRegions` / `computeCircleRegions`, but
 * returns the FULL cell rectangle (not just the disc) — the composite
 * needs to wipe the entire cell, not just the illustration region.
 */
export function cellRect(layout: GridLayout, cardIndex: number): { x: number; y: number; w: number; h: number } {
  const { width, height, rows, cols, outerMargin: om, gutter: g } = layout;
  const cardW = (width - 2 * om - (cols - 1) * g) / cols;
  const cardH = (height - 2 * om - (rows - 1) * g) / rows;
  const i = cardIndex - 1; // convert to 0-based
  const r = Math.floor(i / cols);
  const c = i % cols;
  const x = om + c * (cardW + g);
  const y = om + r * (cardH + g);
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(cardW),
    h: Math.round(cardH),
  };
}

/**
 * Build a circular alpha mask SVG of the given diameter. The white circle
 * paints "keep" and the transparent background paints "drop" when used
 * with sharp's `composite({ blend: 'dest-in' })`.
 */
export function circularMaskSvg(diameter: number): Buffer {
  // Half-pixel offset so the circle sits on integer pixels cleanly. Using
  // a hair-tight radius (diameter/2 with no shrink) so the edge anti-
  // aliases naturally — librsvg's circle primitive does sub-pixel AA out
  // of the box.
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}"><circle cx="${diameter / 2}" cy="${diameter / 2}" r="${diameter / 2}" fill="white"/></svg>`,
  );
}

/**
 * Resize uploaded bytes to exactly fit the target rectangle with the
 * caller-specified fit strategy, then optionally recolour through a
 * single image filter.
 *
 * Fit strategies:
 *  - `cover` (default): preserves aspect, centre-crops the overflow.
 *    What users intuitively expect when they drop an image into a slot —
 *    the image fills the slot edge-to-edge, the off-axis edges are
 *    trimmed.
 *  - `contain`: preserves aspect, letterboxes inside the slot on a
 *    WHITE background. Matches the rest of the format's chrome (the
 *    label band background + cell gutter wipe are also white) so the
 *    letterbox reads as part of the card rather than a foreign band.
 *  - `fill`: stretches to the exact rectangle. Distorts the aspect but
 *    guarantees no crop and no letterbox.
 *
 * Filter is applied as a second Sharp pipeline (decode + encode round
 * trip via `applyFilter`). The marginal cost of one extra round trip on
 * a ~1200x1200 cell is negligible compared to the AI render's 30-300s,
 * and going through the shared helper keeps the filter implementation
 * DRY with the canvas-wide post-process filter.
 */
export async function fitImage(
  bytes: Buffer,
  targetW: number,
  targetH: number,
  fit: UploadFit,
  filter?: ImageFilter,
): Promise<Buffer> {
  const fitted = await sharp(bytes, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
    .resize(targetW, targetH, {
      fit,
      position: 'centre',
      // `contain` needs a background colour for the letterbox; white
      // matches the rest of the format's chrome. Other strategies don't
      // produce empty pixels so the background is ignored.
      background: fit === 'contain' ? WHITE : undefined,
    })
    .png()
    .toBuffer();
  if (!filter) return fitted;
  return applyFilter(fitted, filter);
}

/**
 * Cover-fit + no filter wrapper. Kept as a named export for backwards
 * compatibility with callers that pre-date the per-upload fit / filter
 * fields (a few tests still call it directly with positional args).
 */
export async function fitCover(
  bytes: Buffer,
  targetW: number,
  targetH: number,
): Promise<Buffer> {
  return await fitImage(bytes, targetW, targetH, 'cover');
}

/**
 * Render the card label at the requested size + position-agnostic
 * dimensions. Returns a PNG buffer the caller composites onto the cell.
 *
 * Sharp's `text:` input uses Pango under the hood. We pass `fontfile` to
 * load the bundled Patrick Hand TTF without polluting the system font set.
 * The `font` string carries the size + family in Pango syntax.
 *
 * Empty `text` returns a 1×1 transparent PNG so the composite step can
 * skip a conditional — sharp errors on empty text input.
 */
export async function renderLabelPng(
  text: string,
  targetW: number,
  targetH: number,
  fontPtOverride?: number,
  fontOverride?: { family: string; filePath: string },
): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) {
    return await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  }
  // Pango font-size is in points; sharp defaults to dpi: 72 so 1pt ≈ 1px.
  // 0.55·targetH is empirically calibrated to match the bundled
  // cybersecurity-themes reference: single-line labels render at a
  // comfortably readable size with a small margin around them in the
  // band. Labels long enough to wrap to two lines (e.g. "Espionage,
  // Supply Chain Attacks & Prepositioning") overflow the band height
  // and are downscaled by buildSquareCellOverlay's resize-to-fit guard,
  // appearing slightly smaller than single-line labels — same trade-off
  // the reference makes. Every SINGLE-LINE label in the grid renders at
  // the exact same point size, which is the property that was actually
  // broken: short labels like "UVB-76" used to render ~2× bigger than
  // "Belmez Faces" because of a libvips auto-scale bug.
  //
  // r2.5: callers that need uniform font sizing across the entire grid
  // pass `fontPtOverride` (computed once from the layout's canonical
  // band height, then scaled by the user's labelSize multiplier) so
  // every cell renders its label at the same size regardless of the
  // detected per-cell band height. When omitted, the 0.55·targetH
  // fallback preserves the original per-cell auto-fit for older
  // callers and tests that don't supply the override.
  //
  // CRITICAL: we deliberately do NOT pass `height` to sharp's text
  // input. Despite the docs claiming auto-scaling only happens "if
  // neither dpi nor a font is provided", libvips empirically scales the
  // font to fill the width × height bounding box whenever BOTH are
  // supplied, even with an explicit font string. That's what caused
  // UVB-76 (1 line) to render at ~40pt filling a 52px box while
  // "The Antikythera Mechanism" (2 wrapped lines) rendered at ~18pt to
  // fit the SAME 52px box. Width-only keeps wrap behaviour without the
  // unwanted vertical auto-fit.
  const fontPt = fontPtOverride !== undefined
    ? Math.max(8, Math.round(fontPtOverride))
    : Math.max(12, Math.round(targetH * 0.55));
  const safeW = Math.max(16, Math.round(targetW));
  // Resolve typography. When the caller doesn't pass an override we
  // fall back to the Patrick Hand constants — preserves r2.5 behaviour
  // and keeps tests that don't supply a font passing.
  const family = fontOverride?.family ?? LABEL_FONT_FAMILY;
  const filePath = fontOverride?.filePath ?? LABEL_FONT_PATH;
  return await sharp({
    text: {
      // Escape the few chars that Pango markup treats as control (&, <, >).
      // We're NOT using markup, but Pango still parses these unless we
      // pass them through their entity equivalents. Without this, a label
      // like "AT&T" would silently error out on the Pango parser.
      text: escapePangoText(trimmed),
      fontfile: filePath,
      font: `${family} ${fontPt}`,
      rgba: true,
      width: safeW,
      align: 'centre',
      // Explicit — Pango defaults to 'word' but we depend on it for label
      // uniformity (long labels MUST wrap, not overflow). Pinning it here
      // protects against a future sharp/Pango default change.
      wrap: 'word',
    },
  })
    .png()
    .toBuffer();
}

/**
 * Escape Pango-markup control characters so a label like "AT&T" or "<3"
 * renders as the literal text instead of triggering Pango's parser.
 *
 * Pango treats `&`, `<`, `>` as markup. Without escaping, sharp's text
 * input errors out with "Failed to parse PangoMarkup" on the first such
 * character. The fix is per-character entity replacement.
 */
export function escapePangoText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build a square-mode cell overlay: white background + black border +
 * hairline divider + label-band background. The illustration region is
 * left transparent so the caller can composite the uploaded image into
 * the same overlay before pasting onto the base.
 *
 * Returned PNG is exactly `cellW × cellH`.
 */
export async function buildSquareCellChrome(cellW: number, cellH: number): Promise<Buffer> {
  const illustrationH = Math.round(cellH * SQUARE_ILLUSTRATION_FRAC);
  const labelH = cellH - illustrationH;
  const borderPx = squareBorderPx(cellW);
  const halfBorder = borderPx / 2;
  // SVG with: a white rect covering everything (forms the label strip
  // background — we'll overpaint the illustration area with the image),
  // a scaled black border around the whole cell, and a thin hairline
  // divider between the illustration region and the label band.
  // The border rect is inset by half its stroke width so the stroke
  // stays fully within the cell instead of clipping off the canvas edge.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${cellH}">
    <rect x="0" y="${illustrationH}" width="${cellW}" height="${labelH}" fill="white"/>
    <rect x="${halfBorder}" y="${halfBorder}" width="${cellW - borderPx}" height="${cellH - borderPx}" fill="none" stroke="${BLACK}" stroke-width="${borderPx}"/>
    <line x1="0" y1="${illustrationH}" x2="${cellW}" y2="${illustrationH}" stroke="${BLACK}" stroke-width="${Math.max(1, Math.round(borderPx / 3))}"/>
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Square-mode label-band-only overlay. Used for cells that DON'T have a
 * user upload — we still want to overpaint the AI's label band so the
 * label is rendered at the composite's deterministic font size (matching
 * every other cell), instead of the AI's per-cell auto-scaling that
 * blows up short labels like "UVB-76" to twice the size of longer ones.
 *
 * The returned PNG is `cellW × labelH`. Caller is responsible for the
 * y position — the function doesn't know whether the band lands at the
 * canonical 80% mark or at a pixel-scan-detected label-area top.
 *
 * r2.3 (2026-05-30) — band height is now passed directly by the caller
 * instead of computed as `cellH * 0.2`. Earlier revisions computed
 * `labelH` from `cellH` inside this function which forced every band
 * to be 20% of the detected cell, leaving the AI's gap + label-box-top
 * visible above our overlay when GPT Image 2 rendered cards as two
 * stacked rectangles. The caller now passes the exact band height
 * (typically `detected.bottom - detectAiLabelTop()`) so the overlay
 * covers the entire AI-rendered label area.
 */
export async function buildSquareLabelBandOverlay(
  label: string,
  cellW: number,
  labelH: number,
  fontPt?: number,
  font?: { family: string; filePath: string },
): Promise<Buffer> {
  const borderPx = squareBorderPx(cellW);
  const halfBorder = borderPx / 2;
  // White rect covering the band, plus the bottom + left + right sides
  // of the cell's outer border (the top hairline is drawn separately so
  // it sits exactly on the illustration/label seam). The band PNG is
  // composited at the cell's labelTop, so its origin (0,0) corresponds
  // to the label-area top in canvas coords.
  const bandSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}">
    <rect x="0" y="0" width="${cellW}" height="${labelH}" fill="white"/>
    <rect x="${halfBorder}" y="0" width="${cellW - borderPx}" height="${labelH - halfBorder}" fill="none" stroke="${BLACK}" stroke-width="${borderPx}"/>
    <line x1="0" y1="0" x2="${cellW}" y2="0" stroke="${BLACK}" stroke-width="${Math.max(1, Math.round(borderPx / 3))}"/>
  </svg>`;
  const labelPad = Math.max(2, Math.round(cellW * 0.04));
  const labelPngRaw = await renderLabelPng(label, cellW - 2 * labelPad, Math.max(8, labelH - 2), fontPt, font);
  // renderLabelPng floors its text-box height at 16 px (pango requirement),
  // so for very small cells the produced PNG can exceed the band height
  // and sharp's composite call errors with "must have same dimensions or
  // smaller". Resize-inside the label PNG to fit the band — only shrinks
  // when needed, so production-size cells get the original pixels back.
  const rawMeta = await sharp(labelPngRaw).metadata();
  const rawW = rawMeta.width ?? 1;
  const rawH = rawMeta.height ?? 1;
  const maxLabelH = Math.max(1, labelH - 2);
  const maxLabelW = Math.max(1, cellW - 2 * labelPad);
  const labelPng = rawH > maxLabelH || rawW > maxLabelW
    ? await sharp(labelPngRaw).resize({ width: maxLabelW, height: maxLabelH, fit: 'inside' }).png().toBuffer()
    : labelPngRaw;
  const finalLabelMeta = await sharp(labelPng).metadata();
  const labelW = finalLabelMeta.width ?? 1;
  const labelTextH = finalLabelMeta.height ?? 1;
  const labelLeft = Math.max(0, Math.round((cellW - labelW) / 2));
  const labelTop = Math.max(0, Math.round((labelH - labelTextH) / 2));
  return await sharp({
    create: { width: cellW, height: labelH, channels: 4, background: WHITE },
  })
    .composite([
      { input: Buffer.from(bandSvg), top: 0, left: 0 },
      { input: labelPng, top: labelTop, left: labelLeft },
    ])
    .png()
    .toBuffer();
}

// ─── AI cell border detection ───────────────────────────────────────────────

/**
 * Pixel-scan threshold for "border pixel" detection. R+G+B sum below
 * this counts as dark. 200 catches both pure black borders and anti-
 * aliased dark grays without false-positiving mid-tone illustration
 * content.
 */
const BORDER_DARK_THRESHOLD = 200;

/**
 * Fraction of the scan range a column/row must hit to count as a
 * border. 0.5 means at least half the pixels in the cell's
 * cross-axis range must be dark. Catches solid borders without
 * snapping onto an isolated dark blotch in the illustration.
 */
const BORDER_COVERAGE_RATIO = 0.5;

/**
 * Maximum offset (in pixels) the detection will accept from the
 * expected `cellRect` edge before falling back. Default is set per
 * call from the caller — typically the inter-cell gutter so we can't
 * snap onto a neighbouring cell's border.
 */
const DEFAULT_BORDER_SEARCH_RANGE = 20;

/**
 * Scan-envelope for one cell's four edges. The composite passes one
 * of these per cell to {@link detectAiCellRect} when it needs the
 * detection to handle AI renders where the cell extends MUCH FURTHER
 * from the layout-computed `expected` rect than the legacy
 * `searchRange` window allows. Two common cases:
 *
 *  - **AI drew flush against the canvas edge** (no outer margin). The
 *    expected position has a `~outerMargin` worth of buffer to the
 *    canvas edge; the AI's real top/left is at `0`. The legacy
 *    `±gutter/2` window misses it entirely.
 *  - **AI drew adjacent cells with shared borders** (no inter-cell
 *    gutter). The expected positions are `gutter` apart, but the
 *    AI's shared border sits exactly halfway between them.
 *
 * `*Min`/`*Max` define the inclusive scan range for that edge. The
 * scan finds the strongest light→dark transition in that range; if
 * the range is entirely dark (AI drew through it) it returns the
 * range's nearer end; if entirely light it returns `fallback`.
 *
 * `fallback` is the position to use when the scan finds nothing
 * useful — canvas edge for outer cells, expected position for
 * interior cells.
 */
export interface CellScanBounds {
  leftMin: number;
  leftMax: number;
  rightMin: number;
  rightMax: number;
  topMin: number;
  topMax: number;
  bottomMin: number;
  bottomMax: number;
  fallback: { left: number; right: number; top: number; bottom: number };
}

/**
 * Build a {@link CellScanBounds} envelope for a card based on its
 * position in the grid. Outer-edge cells (row-0 top, last-row bottom,
 * col-0 left, last-col right) get a scan envelope that reaches the
 * canvas edge — handling the "AI ignored the outer margin" case.
 * Interior cells get a TIGHT envelope that stops at the mid-gutter
 * between this cell and its neighbour — far enough to catch a
 * "no inter-cell gutter" render (shared border lives at the mid-gutter
 * y/x) but NOT far enough to wander into the next cell's content.
 *
 * The first iteration of r2.7 used `cell_extent / 2` as the inter-cell
 * reach, which sent the scan ~330 px past the expected edge on a
 * production canvas — well INSIDE the neighbouring cell. The scan
 * latched onto the neighbour's border and detected aiRect collapsed
 * to nonsense, painting overlapping borders and double labels. The
 * fix is to clamp the reach at `gutter/2 + buffer`: the shared-border
 * y/x lives at `gutter/2` past expected (the midpoint), and a few
 * extra pixels of buffer let us catch it without crossing into the
 * next cell.
 *
 * The `buffer` parameter (default 5% of the cell's smaller side) is
 * the INWARD slack the scan accepts — i.e. how far the AI could have
 * drawn the border INSIDE the expected position.
 */
export function computeScanBounds(
  expected: { x: number; y: number; w: number; h: number },
  rowIdx: number,
  colIdx: number,
  rows: number,
  cols: number,
  canvasW: number,
  canvasH: number,
  gutter: number,
  bufferOverride?: number,
): CellScanBounds {
  const isFirstRow = rowIdx === 0;
  const isLastRow = rowIdx === rows - 1;
  const isFirstCol = colIdx === 0;
  const isLastCol = colIdx === cols - 1;
  const expRight = expected.x + expected.w;
  const expBottom = expected.y + expected.h;
  // Inter-cell reach: half the gutter is exactly the midpoint between
  // expected positions, which is where a "no gutter" AI render places
  // the shared border. Add a 4-px safety margin so anti-aliased
  // boundaries register as transitions; do NOT add more or the scan
  // crosses into the neighbouring cell's expected position and the
  // detection latches onto the neighbour's border instead.
  const interCellReach = bufferOverride ?? Math.max(8, Math.round(gutter / 2) + 4);
  // Inward reach is identical (symmetric scan around expected) so a
  // cell-shrunk AI render and a cell-expanded AI render get the same
  // detection precision.
  const inward = interCellReach;
  return {
    leftMin: isFirstCol ? 0 : Math.max(0, expected.x - interCellReach),
    leftMax: Math.min(canvasW - 1, expected.x + inward),
    rightMin: Math.max(0, expRight - inward),
    rightMax: isLastCol ? canvasW - 1 : Math.min(canvasW - 1, expRight + interCellReach),
    topMin: isFirstRow ? 0 : Math.max(0, expected.y - interCellReach),
    topMax: Math.min(canvasH - 1, expected.y + inward),
    bottomMin: Math.max(0, expBottom - inward),
    bottomMax: isLastRow ? canvasH - 1 : Math.min(canvasH - 1, expBottom + interCellReach),
    // Fallbacks always point at `expected`. The OUTER scan range
    // already reaches the canvas edge for outer-edge cells, so a real
    // AI render that bled past the layout's outer margin will be
    // FOUND via a transition (and used). The fallback only kicks in
    // when no transition was found — typically because the AI
    // rendered with proper outer margin and no clean border line
    // (illustration → white-margin gradient). In that case
    // `expected` is the right answer, NOT the canvas edge — snapping
    // to the canvas edge there would erase the AI's outer-margin
    // whitespace and the user sees "no margin below the bottom row".
    fallback: { left: expected.x, right: expRight, top: expected.y, bottom: expBottom },
  };
}

/**
 * Detect the AI's actual cell rectangle by scanning the rendered base
 * image's pixels for the four border lines (top / bottom / left /
 * right) around the expected `cellRect` position.
 *
 * Why this exists: GPT Image 2 consistently renders cells slightly
 * WIDER than our `defaultGutter` formula predicts (it picks tighter
 * gutters than the 1.1%-of-canvas-width we use). The result is that
 * our composite label band's chrome border lands at our (narrower)
 * `cellW` while the AI's illustration-panel border is at a different
 * x position above it. The user sees the mismatch as a "label strip
 * narrower than the panel" artefact.
 *
 * The fix is to snap our overlay to where the AI ACTUALLY drew the
 * cell, not where we predicted. Pixel-scanning is cheap (a few
 * hundred microseconds per cell), pure (no AI calls), and adapts to
 * whatever GPT Image 2's current gutter-width habit is.
 *
 * The last parameter has two shapes:
 *  - `number` (legacy): symmetric `±searchRange` window around each
 *    expected edge. Used by older callers and the existing unit
 *    tests. Fine when the AI's drift is small (a few pixels) but
 *    fails when the AI ignores the outer margin or inter-cell gutter
 *    entirely.
 *  - `CellScanBounds` (preferred since r2.7): per-edge `[min, max]`
 *    ranges + canvas-edge fallback. Used by the composite path so
 *    detection can reach the canvas edge for outer cells and
 *    half-a-cell inward for interior cells. Fixes the post-tofu
 *    alignment bugs where AI-no-margin / AI-no-gutter renders caused
 *    composite overlays to land in stale `expected` coords.
 *
 * Returns the detected `{x, y, w, h}`. If a scan can't find a useful
 * border on any edge it falls back to that edge's expected/canvas-edge
 * value, so the function never returns a wildly-off rect.
 */
export function detectAiCellRect(
  rawData: Uint8Array | Buffer,
  canvasW: number,
  canvasH: number,
  channels: number,
  expected: { x: number; y: number; w: number; h: number },
  searchRangeOrBounds: number | CellScanBounds = DEFAULT_BORDER_SEARCH_RANGE,
): { x: number; y: number; w: number; h: number } {
  const expRight = expected.x + expected.w;
  const expBottom = expected.y + expected.h;
  // Normalise the last parameter into a per-edge `{outer, inner,
  // fallback}` shape. The number form (`searchRange`, legacy) maps to
  // symmetric ±range windows with `expected`-edge fallbacks. The
  // bounds form (`CellScanBounds`, r2.7) uses the per-edge ranges +
  // per-edge fallbacks verbatim, so outer-edge cells can scan to the
  // canvas edge and fall back to `0` / `canvasW` / `canvasH` when no
  // transition is found.
  const bounds: CellScanBounds = typeof searchRangeOrBounds === 'number'
    ? (() => {
        const sr = searchRangeOrBounds;
        return {
          leftMin: Math.max(0, expected.x - sr),
          leftMax: Math.min(canvasW - 1, expected.x + sr),
          rightMin: Math.max(0, expRight - sr),
          rightMax: Math.min(canvasW - 1, expRight + sr),
          topMin: Math.max(0, expected.y - sr),
          topMax: Math.min(canvasH - 1, expected.y + sr),
          bottomMin: Math.max(0, expBottom - sr),
          bottomMax: Math.min(canvasH - 1, expBottom + sr),
          fallback: { left: expected.x, right: expRight, top: expected.y, bottom: expBottom },
        };
      })()
    : searchRangeOrBounds;

  const isDark = (x: number, y: number): boolean => {
    if (x < 0 || x >= canvasW || y < 0 || y >= canvasH) return false;
    const idx = (y * canvasW + x) * channels;
    return rawData[idx] + rawData[idx + 1] + rawData[idx + 2] < BORDER_DARK_THRESHOLD;
  };

  // All four border searches use TRANSITION-BASED scanning: we look
  // for the place where a light gutter meets a dark border, not just
  // for any dark pixel. Two reasons:
  //   1. The realistic AI render has a white gutter outside the cell
  //      and a dark border around the cell. The transition uniquely
  //      identifies the border location.
  //   2. Test scenarios (and real AI renders with dark-themed
  //      illustrations) can have dark pixels everywhere. A simple
  //      "first dark column" scan would snap to the canvas edge of
  //      such an image; transition scanning prefers transitions.
  //
  // When `usingBounds` is true (r2.7) and the entire scan range turned
  // out to be dark (AI drew through it — no light→dark transition
  // possible), we return the BOUND'S OUTER END as the border position.
  // For outer-edge cells with `boundMin = 0`, that's the canvas edge —
  // exactly what we want when the AI rendered flush against the edge.
  // The legacy `searchRange` callers (and the tests pinning that
  // behaviour) keep falling back to `expected.*` because their bounds
  // are derived symmetrically around expected.
  //
  // Helper: column darkness ratio over a given y-range.
  const columnDarkRatio = (x: number, yStart: number, yEnd: number): number => {
    const totalY = Math.max(1, yEnd - yStart);
    let darkCount = 0;
    for (let y = yStart; y < yEnd; y++) {
      if (isDark(x, y)) darkCount++;
    }
    return darkCount / totalY;
  };

  const rowDarkRatio = (y: number, xStart: number, xEnd: number): number => {
    const totalX = Math.max(1, xEnd - xStart);
    let darkCount = 0;
    for (let x = xStart; x < xEnd; x++) {
      if (isDark(x, y)) darkCount++;
    }
    return darkCount / totalX;
  };

  // Walk the scan range from `outer` toward `inner` looking for a
  // light→dark transition. The OUTER end is where the canvas edge or
  // the inter-cell gutter would be; the INNER end is inside the cell.
  // Returns `null` if no transition is found.
  const findTransition = (
    outer: number,
    inner: number,
    ratioAt: (i: number) => number,
  ): number | null => {
    const step = inner >= outer ? 1 : -1;
    let prev: number | null = null;
    for (let i = outer; step > 0 ? i <= inner : i >= inner; i += step) {
      const dr = ratioAt(i);
      const isDarkRow = dr >= BORDER_COVERAGE_RATIO;
      if (
        prev !== null &&
        prev < BORDER_COVERAGE_RATIO &&
        isDarkRow
      ) {
        return i;
      }
      prev = dr;
    }
    return null;
  };

  // Per-edge scan. `outer` is the bound nearer the canvas edge/gutter,
  // `inner` the bound deeper into the cell. Returns the FIRST
  // light→dark transition found in the scan range; falls back to the
  // edge's `fallback` value if no transition exists. The fallback is
  // the canvas edge for outer-cell bounds, expected position for
  // interior bounds (set by `computeScanBounds`).
  //
  // Caller responsibility (r2.7): even when this falls back, the
  // composite force-paints clean borders at the detected aiRect, so
  // a fallback-induced misalignment is bounded — the worst case is
  // the composite paints a border at expected.x instead of AI's true
  // position, which still produces a clean visible frame.
  const yInteriorStart = Math.max(0, expected.y + 2);
  const yInteriorEnd = Math.min(canvasH, expBottom - 2);
  const xInteriorStart = Math.max(0, expected.x + 2);
  const xInteriorEnd = Math.min(canvasW, expRight - 2);

  // Run all four edge scans. Track which ones found a real transition;
  // if NONE did, the image has no structural evidence of cell borders
  // at all (a uniform-coloured synthetic test image, or a base painted
  // before the AI step touches it). In that case the canvas-edge
  // fallbacks for outer-edge cells would balloon the detected rect to
  // the full canvas — visually nonsensical — so we step back and
  // return `expected` as a single coherent unit instead.
  const leftTransition = findTransition(
    bounds.leftMin,
    bounds.leftMax,
    (x) => columnDarkRatio(x, yInteriorStart, yInteriorEnd),
  );
  const rightTransition = findTransition(
    bounds.rightMax,
    bounds.rightMin,
    (x) => columnDarkRatio(x, yInteriorStart, yInteriorEnd),
  );
  const topTransition = findTransition(
    bounds.topMin,
    bounds.topMax,
    (y) => rowDarkRatio(y, xInteriorStart, xInteriorEnd),
  );
  const bottomTransition = findTransition(
    bounds.bottomMax,
    bounds.bottomMin,
    (y) => rowDarkRatio(y, xInteriorStart, xInteriorEnd),
  );

  const anyTransitionFound =
    leftTransition !== null ||
    rightTransition !== null ||
    topTransition !== null ||
    bottomTransition !== null;
  if (!anyTransitionFound) return expected;

  const left = leftTransition ?? bounds.fallback.left;
  const right = rightTransition ?? bounds.fallback.right;
  const top = topTransition ?? bounds.fallback.top;
  const bottom = bottomTransition ?? bounds.fallback.bottom;

  // Guard against degenerate results (e.g. right scan latches onto the
  // illustration's leftmost dark pixel because the rendering is highly
  // unusual). If the detected rect would have non-positive width or
  // height we fall back to the expected rect.
  if (right <= left || bottom <= top) return expected;

  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  };
}

/**
 * Threshold for "white pixel" detection. R+G+B sum greater than this
 * counts as white-ish. 700 catches pure white (765) and lightly-tinted
 * near-white pixels without flagging mid-tone illustration content.
 */
const WHITE_PIXEL_THRESHOLD = 700;

/**
 * Row coverage ratio required to call a row "mostly white". 0.7 lets
 * the row carry up to 30% non-white pixels (a stray label-box border
 * outline, a corner of the illustration that intrudes a row or two)
 * without misclassifying the row as illustration.
 */
const WHITE_ROW_COVERAGE = 0.7;

/**
 * Row coverage ratio required to call a row "mostly dark" — i.e. a
 * candidate illustration→label divider line. 0.5 catches a solid
 * horizontal black line plus its anti-aliasing without false-
 * positiving on a row that happens to clip a dark corner of the
 * illustration. Matches the same ratio `detectAiCellRect` uses for
 * border rows.
 */
const DARK_ROW_COVERAGE = 0.5;

/**
 * Find the top of the AI's drawn illustration→label divider line
 * inside a detected cell rect.
 *
 * Why this exists: GPT Image 2 draws a horizontal black divider
 * between the illustration and the label band. Our composite paints
 * its own hairline + label band on top. If we anchor our overlay
 * BELOW the AI's divider (which was the r2.3 behaviour — find the
 * first mostly-white row), the AI's divider stays visible above our
 * hairline and the user sees TWO parallel horizontal lines with a
 * sliver of white between them — the "doubled hairline" artefact.
 *
 * The fix is to start the overlay AT the top edge of the AI's
 * divider line, so our overlay's white fill covers the divider and
 * our own hairline replaces it at the exact same y. Result: a
 * single clean hairline at the seam, no gap.
 *
 * Scanner: walks DOWN through the cell from 60% of cellH looking
 * for the first row whose dark-pixel ratio exceeds
 * `DARK_ROW_COVERAGE`. Stops scanning at 95% of cellH so a stray
 * dark row at the cell's bottom border can't get picked.
 *
 * r2.4.1: also REQUIRES the candidate row to be followed within a
 * few rows by a predominantly white row. A real divider sits right
 * above the white label band, so the bright stripe below confirms
 * it. Without this check, photoreal style renders trip on dark
 * patches in the illustration (the underside of a broken piggy
 * bank, the dark wood under a product photo, the dark laptop
 * background behind a logo) and place the band overlay way too
 * high — making the band ~2× taller than intended and the rendered
 * label font ~2× too big.
 *
 * Returns the y coordinate of the divider's top edge in canvas
 * coords, or `null` when no candidate row is found (caller should
 * fall back to the "first mostly-white row" heuristic, then to the
 * 80% default).
 */
export function detectAiDividerLine(
  rawData: Uint8Array | Buffer,
  canvasW: number,
  canvasH: number,
  channels: number,
  detected: { x: number; y: number; w: number; h: number },
): number | null {
  const xStart = Math.max(0, detected.x + 2);
  const xEnd = Math.min(canvasW, detected.x + detected.w - 2);
  const totalX = Math.max(1, xEnd - xStart);
  // Scan window deliberately narrow: real dividers in this format
  // never appear higher than ~70% of cellH. Starting at 60% adds a
  // small safety margin for AI renders that put the illustration
  // panel a touch shorter than the prompt asked for, while keeping
  // the upper half of the cell out of reach of false positives.
  const scanStart = Math.max(0, detected.y + Math.floor(detected.h * 0.6));
  const scanEnd = Math.min(canvasH - 1, detected.y + Math.floor(detected.h * 0.95));
  const rowDarkRatio = (y: number): number => {
    let darkCount = 0;
    for (let x = xStart; x < xEnd; x++) {
      const idx = (y * canvasW + x) * channels;
      if (rawData[idx] + rawData[idx + 1] + rawData[idx + 2] < BORDER_DARK_THRESHOLD) {
        darkCount++;
      }
    }
    return darkCount / totalX;
  };
  const rowWhiteRatio = (y: number): number => {
    let whiteCount = 0;
    for (let x = xStart; x < xEnd; x++) {
      const idx = (y * canvasW + x) * channels;
      if (rawData[idx] + rawData[idx + 1] + rawData[idx + 2] > WHITE_PIXEL_THRESHOLD) {
        whiteCount++;
      }
    }
    return whiteCount / totalX;
  };
  for (let y = scanStart; y <= scanEnd; y++) {
    if (rowDarkRatio(y) < DARK_ROW_COVERAGE) continue;
    // Candidate dark row found. Verify the label band sits directly
    // beneath it: look 2-8 rows down for at least one mostly-white
    // row. The dy range allows for divider strokes 1-3 px thick + a
    // possible 1-pixel anti-alias before the band's white interior
    // starts.
    let whiteVerified = false;
    for (let dy = 2; dy <= 8; dy++) {
      const verifyY = y + dy;
      if (verifyY > scanEnd) break;
      if (rowWhiteRatio(verifyY) > WHITE_ROW_COVERAGE) {
        whiteVerified = true;
        break;
      }
    }
    if (whiteVerified) return y;
    // Not a real divider — dark patch in the illustration. Keep
    // scanning further down for the actual divider, if any.
  }
  return null;
}

/**
 * Find the top of the AI's label area inside a detected cell rect.
 *
 * Used as the fallback when `detectAiDividerLine` returns `null` —
 * the AI didn't draw a clear divider, but the cell may still have a
 * usable white-strip-on-the-bottom layout. Walks DOWN from 40% of
 * cellH looking for the FIRST mostly-white row, which is either the
 * gap between a two-rectangle illustration / label render or the
 * top of a unified cell's white label strip.
 *
 * Pre-r2.4 this was the primary detector; r2.4 demoted it because
 * it lands BELOW the AI's divider, leaving the divider visible above
 * our overlay (the "doubled hairline" artefact). It still beats
 * "80% of cellH" as a last-ditch fallback, so we keep it.
 *
 * Returns the y coordinate of the first mostly-white row in canvas
 * coords, or `null` if no such row is found (caller should fall back
 * to the 80% default).
 */
export function detectAiLabelTop(
  rawData: Uint8Array | Buffer,
  canvasW: number,
  canvasH: number,
  channels: number,
  detected: { x: number; y: number; w: number; h: number },
): number | null {
  const xStart = Math.max(0, detected.x + 2);
  const xEnd = Math.min(canvasW, detected.x + detected.w - 2);
  const totalX = Math.max(1, xEnd - xStart);
  // Scan from 40% of cellH down to 95% of cellH. Starting at 40%
  // keeps us safely below typical illustration content; stopping
  // at 95% prevents snapping onto the cell's bottom border line.
  const scanStart = Math.max(0, detected.y + Math.floor(detected.h * 0.4));
  const scanEnd = Math.min(canvasH - 1, detected.y + Math.floor(detected.h * 0.95));
  for (let y = scanStart; y <= scanEnd; y++) {
    let whiteCount = 0;
    for (let x = xStart; x < xEnd; x++) {
      const idx = (y * canvasW + x) * channels;
      const sum = rawData[idx] + rawData[idx + 1] + rawData[idx + 2];
      if (sum > WHITE_PIXEL_THRESHOLD) whiteCount++;
    }
    if (whiteCount / totalX > WHITE_ROW_COVERAGE) return y;
  }
  return null;
}

// ─── Top-level ──────────────────────────────────────────────────────────────

/**
 * Composite uploaded images and uniform-style labels over the AI-generated
 * base. Returns the final PNG buffer ready to upload to R2.
 *
 * Two overlay kinds run per cell:
 *  - Uploaded cells get a full-cell overlay (image cover-fit + chrome +
 *    composite label). Square mode paints the white background, black
 *    border, illustration/label hairline; circle mode paints a white
 *    canvas + masked disc + label strip beneath. Wipes whatever the AI
 *    drew there entirely.
 *  - Cells WITHOUT uploads get a label-band-only overlay (square mode)
 *    that wipes just the bottom 20% of the cell and paints the composite
 *    label there at the deterministic font size. The AI's illustration
 *    stays intact, but its label is replaced. This stops the AI's
 *    per-cell font autoscaling from blowing up short labels like
 *    "UVB-76" to ~1.5× the size of longer labels — every cell ends up
 *    with the same label size as the uploaded cells, matching the
 *    bundled reference's clean uniform look.
 *
 * If `uploads` is empty AND `cards` is empty we still re-encode to PNG so
 * the caller has a consistent output format. Circle-mode label
 * uniformisation for non-upload cells is NOT implemented yet — circle
 * mode is rarer and the existing AI label rendering on white canvas
 * works tolerably; revisit if a similar complaint shows up there.
 *
 * All overlays accumulate into one `.composite([...])` call so the
 * pipeline does a single decode + single encode of the (potentially 4K)
 * base, regardless of cell count.
 */
export async function applyCellUploads(input: ApplyCellUploadsInput): Promise<Buffer> {
  const { baseImage, layout, cards, cardShape, uploads } = input;
  const labelSizeMultiplier = input.labelSizeMultiplier ?? 1;

  // Resolve the label font once per call. Unknown ids fall back to the
  // default silently — the route already validates against the
  // allowlist, this layer is belt-and-braces. `font` is undefined when
  // the caller omits `fontId`, which keeps the per-call overhead at
  // zero for legacy tests that don't supply one.
  const fontIdRequested = input.fontId ?? DEFAULT_FONT_ID;
  const resolvedFont: ThumbnailFont | null = findFontById(fontIdRequested) ?? findFontById(DEFAULT_FONT_ID);
  const font = resolvedFont
    ? { family: resolvedFont.family, filePath: fontFilePath(resolvedFont) }
    : undefined;
  console.info('[topic-card-grid composite font]', {
    font_id_requested: fontIdRequested,
    font_id_used: resolvedFont?.id ?? null,
    family: resolvedFont?.family ?? null,
    file_path: font?.filePath ?? null,
  });

  const cardByIndex = new Map<number, TopicCard>();
  for (const c of cards) cardByIndex.set(c.index, c);
  const uploadByIndex = new Map<number, CellUpload>();
  for (const up of uploads) uploadByIndex.set(up.cardIndex, up);

  // Compute one canonical fontPt for the whole grid. Derived from the
  // LAYOUT's canonical band height (20% of the canonical cell height),
  // not from any cell's detected band height — so every cell renders
  // its label at the same point size regardless of where the per-cell
  // divider scanner landed. The 0.55 fraction matches the historical
  // per-cell heuristic in `renderLabelPng`'s no-override branch, so a
  // 1.0 multiplier produces visually the same size as r2.4.1 on cells
  // whose detection landed at the canonical 80% mark.
  const canonicalCellH =
    (layout.height - 2 * layout.outerMargin - (layout.rows - 1) * layout.gutter) /
    layout.rows;
  const canonicalBandH = Math.round(canonicalCellH * 0.2);
  const baseFontPt = Math.max(12, Math.round(canonicalBandH * 0.55));
  const fontPt = Math.max(8, Math.round(baseFontPt * labelSizeMultiplier));
  console.info('[topic-card-grid composite font-size]', {
    canonical_cell_h: canonicalCellH,
    canonical_band_h: canonicalBandH,
    base_font_pt: baseFontPt,
    multiplier: labelSizeMultiplier,
    font_pt_applied: fontPt,
  });

  const overlays: sharp.OverlayOptions[] = [];

  // Half-gutter white wipe pad. Belt-and-braces against AI bleed in
  // two distinct cases:
  //   - Uploaded / mixed-upload cells (useFullCellOverlay = true): the
  //     AI's drawn cell boundaries never line up perfectly with our
  //     cellRect formula, so a few pixels of the AI's cell content end
  //     up outside the composite cell overlay and visible in the
  //     gutter. We wipe four-sides-around the cell before painting the
  //     overlay on top.
  //   - Pure-prompt cells (useFullCellOverlay = false): the AI also
  //     drifts on cellW (it picks tighter column gutters than our
  //     ~1.1%-of-canvas formula, rendering cells WIDER than we
  //     predict) AND on label-strip width (it sometimes draws the
  //     label as a narrower centred sub-frame). Both leave AI-rendered
  //     border lines and tag-box edges visible just outside our band
  //     overlay's edges. We wipe the band's left slack, right slack,
  //     and bottom slack (the row gutter beneath) to absorb both
  //     drifts. Vertical extent of the side wipes is bounded to the
  //     band height so the AI's illustration in the top 80% is NEVER
  //     erased. The top of the band is intentionally not wiped —
  //     that's the illustration/label seam.
  // Clamped to canvas bounds for edge cells.
  const gutterPad = Math.max(0, Math.round(layout.gutter / 2));
  const wipeOverlays: sharp.OverlayOptions[] = [];

  // When ANY upload is present in this request, EVERY non-uploaded cell
  // is treated as "user-intended an upload here, it just didn't reach
  // us" rather than as a prompt-mode cell where AI illustration is
  // wanted. We paint those cells fully blank (white placeholder) with
  // only a composite label, wiping any AI bleed entirely. Two reasons:
  //   1) When mixed uploads exist, AI bleed below/around uploaded cells
  //      is a constant misalignment hazard (the AI's drawn cell layout
  //      never matches our cellRect formula exactly). Treating the
  //      whole grid as composite-rendered removes the seam.
  //   2) If an upload SILENTLY fails (URL expired, presign mismatch,
  //      client state stale), the visible result is a clean blank cell
  //      with just the label — a clear signal the user can re-upload,
  //      instead of a confusing AI hallucination of what their image
  //      probably looked like with a misaligned bleed strip.
  // Pure prompt mode (uploads.length === 0) keeps the existing
  // behaviour: the AI's illustration stays and only the label band is
  // overpainted.
  const someUploadsProvided = uploads.length > 0;

  // Reuse one tiny white PNG for every failed-upload placeholder — it
  // gets resized via fitCover anyway, so the source dimensions don't
  // matter beyond "positive integers".
  let whitePlaceholderBytes: Buffer | null = null;
  const getWhitePlaceholder = async (): Promise<Buffer> => {
    if (!whitePlaceholderBytes) {
      whitePlaceholderBytes = await sharp({
        create: { width: 100, height: 100, channels: 4, background: WHITE },
      })
        .png()
        .toBuffer();
    }
    return whitePlaceholderBytes;
  };

  // In pure-prompt square mode, the band overlay needs to snap to the
  // AI's ACTUAL cell border position rather than our `cellRect`-math
  // position. GPT Image 2 picks tighter gutters than our 1.1%-of-
  // canvas-width formula, so its cell border lands at a different x
  // than our overlay's border would, and the user sees the band as
  // visibly narrower than the illustration panel above. We decode the
  // base image's raw pixels once and pixel-scan around each expected
  // cellRect for the true border lines. Detection is cheap (a few
  // hundred microseconds per cell on a 4K image) and only runs in
  // pure-prompt square mode — upload mode wipes the whole cell with
  // chrome at our cellRect, so detection wouldn't help there.
  const useBorderDetection = !someUploadsProvided && cardShape === 'square' && cards.length > 0;
  let detectedRects: Map<number, { x: number; y: number; w: number; h: number }> | null = null;
  // Hoist the decoded raw pixels so the per-card loop can reuse them
  // for `detectAiLabelTop`. Decoding a 4K base image is the expensive
  // step (~50 ms); running multiple scans over the same buffer is
  // cheap (a few hundred µs each).
  let aiPixels: { data: Buffer; width: number; height: number; channels: number } | null = null;
  if (useBorderDetection) {
    const { data: rawPixels, info: rawInfo } = await sharp(baseImage, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    aiPixels = {
      data: rawPixels as Buffer,
      width: rawInfo.width,
      height: rawInfo.height,
      channels: rawInfo.channels,
    };
    // r2.7: switched from a symmetric ±gutter/2 search range to
    // per-cell `CellScanBounds`. The legacy window was ~11-25 px at
    // production canvas sizes (1.1% of canvas width), and GPT Image 2
    // consistently renders cells with MUCH wider drift than that:
    //   - Outer-edge cells often rendered flush against the canvas
    //     edge (no outer margin at all → ~22-45 px from expected).
    //   - Adjacent cells in the same row often share borders (no
    //     inter-cell gutter → ~22-45 px from expected).
    // Both put the AI's real border outside the legacy ±window, so
    // detection silently fell back to `expected` coords and the
    // composite painted overlays in the wrong place. See the visible
    // bugs (no row-1 top border; black border lines cutting INTO
    // row-2 illustrations; band-vs-illustration x mismatch) in
    // `_plans/2026-05-31-topic-card-grid-detection-bounds-fix.md`.
    detectedRects = new Map();
    for (const card of cards) {
      const expected = cellRect(layout, card.index);
      const rowIdx = Math.floor((card.index - 1) / layout.cols);
      const colIdx = (card.index - 1) % layout.cols;
      const bounds = computeScanBounds(
        expected,
        rowIdx,
        colIdx,
        layout.rows,
        layout.cols,
        rawInfo.width,
        rawInfo.height,
        layout.gutter,
      );
      const detected = detectAiCellRect(
        rawPixels,
        rawInfo.width,
        rawInfo.height,
        rawInfo.channels,
        expected,
        bounds,
      );
      console.info('[topic-card-grid composite cell-rect]', {
        card_index: card.index,
        row_idx: rowIdx,
        col_idx: colIdx,
        expected_x: expected.x,
        expected_y: expected.y,
        expected_w: expected.w,
        expected_h: expected.h,
        detected_x: detected.x,
        detected_y: detected.y,
        detected_w: detected.w,
        detected_h: detected.h,
        // Bounds give future-debuggers a complete picture of why the
        // detection landed where it did.
        bounds_top: [bounds.topMin, bounds.topMax],
        bounds_bottom: [bounds.bottomMin, bounds.bottomMax],
        bounds_left: [bounds.leftMin, bounds.leftMax],
        bounds_right: [bounds.rightMin, bounds.rightMax],
        fallback: bounds.fallback,
      });
      detectedRects.set(card.index, detected);
    }
  }

  // Iterate every card in reading order. Upload presence + the mixed-
  // vs-prompt distinction above picks between three overlay kinds:
  //   - Uploaded cell: full overlay with the user's image
  //   - Non-uploaded cell in mixed mode: full overlay with white
  //     placeholder (wipes any AI bleed; signals failed upload)
  //   - Non-uploaded cell in pure-prompt mode: label-band only
  //     (preserves the AI's illustration), PLUS a row-gutter wipe
  //     beneath the cell so any AI-rendered label text that overflowed
  //     into the gutter doesn't survive next to our composite label
  for (const card of cards) {
    const rect = cellRect(layout, card.index);
    const uploaded = uploadByIndex.get(card.index);
    const uploadedBytes = uploaded?.bytes;
    const useFullCellOverlay = uploadedBytes !== undefined || someUploadsProvided;

    if (useFullCellOverlay) {
      const imageBytes = uploadedBytes ?? (await getWhitePlaceholder());
      // Per-upload fit + filter. Defaults to 'cover' with no filter so
      // failed-upload placeholders (white squares) render the same as
      // pre-Phase-5 — no surprise behaviour for the existing flow.
      const uploadFit: UploadFit = uploaded?.fit ?? 'cover';
      const uploadFilter: ImageFilter | undefined = uploaded?.filter;
      if (uploaded?.fit || uploaded?.filter) {
        console.info('[topic-card-grid upload-fit]', {
          card_index: card.index,
          fit: uploadFit,
          filter: uploadFilter ?? null,
        });
      }
      // Stage the white wipe (cellRect + gutterPad on each side, clamped
      // to canvas) BEFORE the cell overlay so sharp paints them in this
      // order: base → wipes → cells → labels.
      if (gutterPad > 0) {
        const wipeLeft = Math.max(0, rect.x - gutterPad);
        const wipeTop = Math.max(0, rect.y - gutterPad);
        const wipeRight = Math.min(layout.width, rect.x + rect.w + gutterPad);
        const wipeBottom = Math.min(layout.height, rect.y + rect.h + gutterPad);
        const wipeW = Math.max(1, wipeRight - wipeLeft);
        const wipeH = Math.max(1, wipeBottom - wipeTop);
        const wipePng = await sharp({
          create: { width: wipeW, height: wipeH, channels: 4, background: WHITE },
        })
          .png()
          .toBuffer();
        wipeOverlays.push({ input: wipePng, top: wipeTop, left: wipeLeft });
      }
      const overlay =
        cardShape === 'circle'
          ? await buildCircleCellOverlay(imageBytes, card.label, rect.w, rect.h, fontPt, font, uploadFit, uploadFilter)
          : await buildSquareCellOverlay(imageBytes, card.label, rect.w, rect.h, fontPt, font, uploadFit, uploadFilter);
      overlays.push({ input: overlay, top: rect.y, left: rect.x });
      continue;
    }

    // Pure prompt mode (zero uploads in request): only paint a uniform-
    // style label band in square mode. Skip for circle mode — the AI
    // renders labels beneath the disc on white canvas and overpainting
    // risks blanking the disc if the layout-derived band misses by a
    // few pixels (the reference sample size for circle mode is small).
    if (cardShape === 'square') {
      // Anchor everything (band overlay, side wipes, row gutter wipe)
      // to the AI's detected cell rectangle instead of our cellRect-
      // math rect, so the composite's border matches the illustration
      // panel's border above it. Falls back to `rect` if detection
      // wasn't run or failed for this card.
      const aiRect = detectedRects?.get(card.index) ?? rect;
      // Find the band top in this order of preference:
      //   1. The AI's drawn illustration→label divider line (r2.4).
      //      Starting at the divider's TOP edge lets our overlay's
      //      white fill cover the AI's divider, and our hairline
      //      replaces it at the same y — single visible line, no
      //      doubled-hairline gap.
      //   2. The first mostly-white row inside the cell. Lands BELOW
      //      the divider when one exists, so it's the second pick;
      //      still useful when the AI rendered a two-rectangle layout
      //      with a clean white gap.
      //   3. 80% of cellH (the canonical layout fraction). Last-ditch
      //      fallback when detection finds neither a divider nor a
      //      white row.
      const fallbackBandTop = aiRect.y + Math.round(aiRect.h * SQUARE_ILLUSTRATION_FRAC);
      let bandTopSource: 'divider' | 'white-row-fallback' | 'percentage-fallback' = 'percentage-fallback';
      const detectedDivider = (() => {
        if (!useBorderDetection || !aiPixels) return null;
        return detectAiDividerLine(
          aiPixels.data,
          aiPixels.width,
          aiPixels.height,
          aiPixels.channels,
          aiRect,
        );
      })();
      const detectedLabelTop = detectedDivider === null && useBorderDetection && aiPixels
        ? detectAiLabelTop(
            aiPixels.data,
            aiPixels.width,
            aiPixels.height,
            aiPixels.channels,
            aiRect,
          )
        : null;
      // Clamp the detected top so the band doesn't end up taller than
      // 40% of cellH (sanity floor — we don't want to swallow the
      // illustration if the scanner snaps to a stray dark or white row).
      const minBandTop = aiRect.y + Math.round(aiRect.h * 0.6);
      let bandTop: number;
      if (detectedDivider !== null) {
        bandTop = Math.max(minBandTop, detectedDivider);
        bandTopSource = 'divider';
      } else if (detectedLabelTop !== null) {
        bandTop = Math.max(minBandTop, detectedLabelTop);
        bandTopSource = 'white-row-fallback';
      } else {
        bandTop = fallbackBandTop;
        bandTopSource = 'percentage-fallback';
      }
      console.info('[topic-card-grid composite divider-scan]', {
        card_index: card.index,
        detected_divider_y: detectedDivider,
        detected_white_row_y: detectedLabelTop,
        band_top_used: bandTop,
        source: bandTopSource,
      });
      const bandH = aiRect.y + aiRect.h - bandTop;
      // L-shaped slack wipe around the band. Anchored at the DETECTED
      // edges so the wipe lands in genuine AI gutter slack rather
      // than inside the illustration. With detection in place this is
      // mostly a no-op on a well-aligned base, but stays as belt-and-
      // braces against detection drift on edge cases.
      if (gutterPad > 0 && bandH > 0) {
        const leftWipeLeft = Math.max(0, aiRect.x - gutterPad);
        const leftWipeW = Math.max(0, aiRect.x - leftWipeLeft);
        if (leftWipeW > 0) {
          const leftWipePng = await sharp({
            create: { width: leftWipeW, height: bandH, channels: 4, background: WHITE },
          })
            .png()
            .toBuffer();
          wipeOverlays.push({ input: leftWipePng, top: bandTop, left: leftWipeLeft });
        }
        const rightWipeRight = Math.min(layout.width, aiRect.x + aiRect.w + gutterPad);
        const rightWipeW = Math.max(0, rightWipeRight - (aiRect.x + aiRect.w));
        if (rightWipeW > 0) {
          const rightWipePng = await sharp({
            create: { width: rightWipeW, height: bandH, channels: 4, background: WHITE },
          })
            .png()
            .toBuffer();
          wipeOverlays.push({ input: rightWipePng, top: bandTop, left: aiRect.x + aiRect.w });
        }
        const bottomWipeTop = aiRect.y + aiRect.h;
        const bottomWipeBottom = Math.min(layout.height, bottomWipeTop + gutterPad);
        const bottomWipeH = Math.max(0, bottomWipeBottom - bottomWipeTop);
        if (bottomWipeH > 0) {
          const bottomWipeLeft = leftWipeLeft;
          const bottomWipeRight = rightWipeRight;
          const bottomWipeW = Math.max(1, bottomWipeRight - bottomWipeLeft);
          const bottomWipePng = await sharp({
            create: { width: bottomWipeW, height: bottomWipeH, channels: 4, background: WHITE },
          })
            .png()
            .toBuffer();
          wipeOverlays.push({ input: bottomWipePng, top: bottomWipeTop, left: bottomWipeLeft });
        }
      }
      if (bandH > 0) {
        const overlay = await buildSquareLabelBandOverlay(card.label, aiRect.w, bandH, fontPt, font);
        overlays.push({ input: overlay, top: bandTop, left: aiRect.x });
      }
      // r2.4: paint a thin black top border at the top edge of every
      // cell. The AI sometimes omits the top border on row 2+ when it
      // renders the grid with cells sharing borders (top row's bottom
      // = bottom row's top, drawn once). The shared line gets wiped
      // by the top row's bottom gutter wipe — or never drawn for the
      // bottom row at all — leaving row 2 visibly "open" at the top.
      // Re-painting unconditionally at aiRect.y guarantees every cell
      // has a top border: cells that already had one get the same y
      // re-stroked (no visible change); cells that didn't get the
      // missing line.
      //
      // r2.7: extended the force-paint to ALL FOUR sides. The same
      // class of failure happens on the left/right/bottom edges too
      // when the AI rendered cells edge-to-edge with the canvas (no
      // outer margin) or with shared inter-cell borders (no gutter).
      // After the r2.7 bounds-based detection lands aiRect on the AI's
      // actual cell boundary, painting a stroke at each of the four
      // edges guarantees a clean frame regardless of which borders
      // the AI drew. Width = squareBorderPx, matching the rest of our
      // composite borders.
      const borderThickness = squareBorderPx(aiRect.w);
      const horizBorderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${aiRect.w}" height="${borderThickness}"><rect x="0" y="0" width="${aiRect.w}" height="${borderThickness}" fill="${BLACK}"/></svg>`;
      const horizBorderPng = await sharp(Buffer.from(horizBorderSvg)).png().toBuffer();
      const vertBorderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${borderThickness}" height="${aiRect.h}"><rect x="0" y="0" width="${borderThickness}" height="${aiRect.h}" fill="${BLACK}"/></svg>`;
      const vertBorderPng = await sharp(Buffer.from(vertBorderSvg)).png().toBuffer();
      // Position the bottom + right strokes so their OUTER edge lands
      // exactly on the cell's outer boundary (not one pixel past it).
      // For a cell at aiRect.y .. aiRect.y + aiRect.h, the bottom
      // stroke's TOP-LEFT corner sits at y = aiRect.y + aiRect.h -
      // borderThickness so the stroke ends at the cell's bottom.
      overlays.push({ input: horizBorderPng, top: aiRect.y, left: aiRect.x });
      overlays.push({
        input: horizBorderPng,
        top: Math.max(0, aiRect.y + aiRect.h - borderThickness),
        left: aiRect.x,
      });
      overlays.push({ input: vertBorderPng, top: aiRect.y, left: aiRect.x });
      overlays.push({
        input: vertBorderPng,
        top: aiRect.y,
        left: Math.max(0, aiRect.x + aiRect.w - borderThickness),
      });
      console.info('[topic-card-grid composite cell-borders]', {
        card_index: card.index,
        ai_rect_x: aiRect.x,
        ai_rect_y: aiRect.y,
        ai_rect_w: aiRect.w,
        ai_rect_h: aiRect.h,
        thickness: borderThickness,
      });
    }
  }

  // Wipes paint FIRST so cell overlays land on top of them. Sharp
  // composites overlays in array order, so prepending the wipe array
  // gives us the correct paint order: base → wipes → cell overlays →
  // label-band overlays.
  const finalOverlays = [...wipeOverlays, ...overlays];

  if (finalOverlays.length === 0) {
    return await sharp(baseImage, { limitInputPixels: SHARP_INPUT_PIXEL_CAP }).png().toBuffer();
  }

  return await sharp(baseImage, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
    .composite(finalOverlays)
    .png()
    .toBuffer();
}

/**
 * Square-mode per-cell overlay. Exactly `cellW × cellH`. Layout:
 *  - Top SQUARE_ILLUSTRATION_FRAC (80%) holds the cover-fit uploaded image.
 *  - Bottom 20% is a white label band with the label text centred.
 *  - 3px black border wraps the cell, 1px hairline at the illustration/
 *    label boundary.
 */
async function buildSquareCellOverlay(
  imageBytes: Buffer,
  label: string,
  cellW: number,
  cellH: number,
  fontPt?: number,
  font?: { family: string; filePath: string },
  fit: UploadFit = 'cover',
  filter?: ImageFilter,
): Promise<Buffer> {
  const illustrationH = Math.round(cellH * SQUARE_ILLUSTRATION_FRAC);
  const labelH = cellH - illustrationH;
  const borderPx = squareBorderPx(cellW);

  // 1) Fit the uploaded image to the illustration area INSET by the
  //    border thickness on the left, right, and top so the image sits
  //    INSIDE the black border instead of running edge-to-edge with the
  //    border painted on top. The bottom edge of the image meets the
  //    hairline divider at y=illustrationH (no inset there — the hairline
  //    sits on the seam between image and label band).
  //    `fit` and `filter` are per-upload overrides; defaults match the
  //    pre-Phase-5 behaviour (cover + no filter).
  const insetW = Math.max(1, cellW - 2 * borderPx);
  const insetH = Math.max(1, illustrationH - borderPx);
  const illustrationPng = await fitImage(imageBytes, insetW, insetH, fit, filter);

  // 2) Render the label text PNG. We give it the label band width with
  //    a small horizontal padding so descenders don't kiss the border.
  const labelPad = Math.max(2, Math.round(cellW * 0.04));
  const maxLabelW = Math.max(1, cellW - 2 * labelPad);
  const maxLabelH = Math.max(1, labelH - 2);
  const labelPngRaw = await renderLabelPng(label, maxLabelW, maxLabelH, fontPt, font);
  // Sharp's text input treats `width` as a wrap-hint, not a hard cap, so
  // unbreakable labels like "UVB-76" render wider than maxLabelW (and
  // long multi-word labels can wrap to 2 lines that exceed maxLabelH).
  // Resize-inside shrinks the rendered bitmap to fit both axes; labels
  // that already fit pass through unchanged. Mirrors the same guard in
  // buildSquareLabelBandOverlay so uploaded and non-upload cells use
  // identical sizing rules.
  const rawMeta = await sharp(labelPngRaw).metadata();
  const rawW = rawMeta.width ?? 1;
  const rawH = rawMeta.height ?? 1;
  const labelPng = rawW > maxLabelW || rawH > maxLabelH
    ? await sharp(labelPngRaw)
        .resize({ width: maxLabelW, height: maxLabelH, fit: 'inside' })
        .png()
        .toBuffer()
    : labelPngRaw;
  const labelMeta = await sharp(labelPng).metadata();
  const labelW = labelMeta.width ?? 1;
  const labelTextH = labelMeta.height ?? 1;

  // 3) Render the chrome (border + hairline + label band background).
  const chrome = await buildSquareCellChrome(cellW, cellH);

  // 4) Composite everything onto a white base of the cell size so the
  //    cell is fully covered (wiping anything the AI rendered there).
  //    Illustration sits at (borderPx, borderPx) so the border wraps it.
  const labelLeft = Math.max(0, Math.round((cellW - labelW) / 2));
  const labelTop = Math.max(
    illustrationH + 1,
    illustrationH + Math.round((labelH - labelTextH) / 2),
  );
  return await sharp({
    create: { width: cellW, height: cellH, channels: 4, background: WHITE },
  })
    .composite([
      { input: illustrationPng, top: borderPx, left: borderPx },
      { input: chrome, top: 0, left: 0 },
      { input: labelPng, top: labelTop, left: labelLeft },
    ])
    .png()
    .toBuffer();
}

/**
 * Circle-mode per-cell overlay. Exactly `cellW × cellH`. Layout:
 *  - Whole cell starts as white (covers any AI render).
 *  - The disc occupies the top portion (geometry from
 *    `circleCellGeometry`); the uploaded image is cover-fit into a square
 *    equal to the disc diameter, then alpha-masked to a circle.
 *  - The label sits in the remaining strip beneath the disc, centred.
 *
 * No black border, no hairline — circles float on the white canvas.
 */
async function buildCircleCellOverlay(
  imageBytes: Buffer,
  label: string,
  cellW: number,
  cellH: number,
  fontPt?: number,
  font?: { family: string; filePath: string },
  fit: UploadFit = 'cover',
  filter?: ImageFilter,
): Promise<Buffer> {
  // Geometry is computed in canvas-local coords; we pass cellX/cellY = 0
  // so the returned positions are within the overlay's own frame.
  const geom = circleCellGeometry(0, 0, cellW, cellH);
  const discD = Math.round(geom.discD);

  // 1) Fit the uploaded image to a discD × discD square. `fit` and
  //    `filter` are per-upload overrides; defaults match the pre-Phase-5
  //    behaviour (cover + no filter).
  const square = await fitImage(imageBytes, discD, discD, fit, filter);

  // 2) Apply the circular alpha mask (dest-in keeps only the pixels under
  //    the white circle, dropping the corners to transparent).
  const masked = await sharp(square)
    .composite([{ input: circularMaskSvg(discD), blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 3) Render the label text PNG.
  const labelPad = Math.max(2, Math.round(cellW * 0.025));
  const labelW = Math.max(16, Math.round(geom.labelW) - 2 * labelPad);
  const labelH = Math.max(8, Math.round(geom.labelH) - 2);
  const labelPng = await renderLabelPng(label, labelW, labelH, fontPt, font);
  const labelMeta = await sharp(labelPng).metadata();
  const labelTextW = labelMeta.width ?? 1;
  const labelTextH = labelMeta.height ?? 1;

  // 4) Composite onto a white base of the cell size.
  const discLeft = Math.round(geom.discCx - discD / 2);
  const discTop = Math.round(geom.discCy - discD / 2);
  const labelLeft = Math.max(0, Math.round((cellW - labelTextW) / 2));
  const labelTop = Math.max(
    discTop + discD + 1,
    Math.round(geom.labelY + (geom.labelH - labelTextH) / 2),
  );
  return await sharp({
    create: { width: cellW, height: cellH, channels: 4, background: WHITE },
  })
    .composite([
      { input: masked, top: discTop, left: discLeft },
      { input: labelPng, top: labelTop, left: labelLeft },
    ])
    .png()
    .toBuffer();
}
