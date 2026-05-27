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

/**
 * One cell-upload payload. The route resolves the URL into bytes (with the
 * existing SSRF guard), then hands the bytes here so this module stays
 * free of network code. `cardIndex` is 1-based and matches `TopicCard.index`.
 */
export interface CellUpload {
  cardIndex: number;
  /** Raw image bytes — PNG/JPEG/WebP. Sharp will auto-detect the format. */
  bytes: Buffer;
}

export interface ApplyCellUploadsInput {
  /** AI-generated image as bytes. Any sharp-supported format works; output
   *  will always be PNG. */
  baseImage: Buffer;
  layout: GridLayout;
  cards: TopicCard[];
  cardShape: CardShape;
  uploads: CellUpload[];
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
 * Crop + resize uploaded bytes to exactly fit the target rectangle using
 * the "cover" strategy (preserves aspect, centre-crops the overflow). This
 * is what users intuitively expect when they drop an image into a slot —
 * the image fills the slot, the off-axis edges are trimmed.
 */
export async function fitCover(
  bytes: Buffer,
  targetW: number,
  targetH: number,
): Promise<Buffer> {
  return await sharp(bytes, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
    .resize(targetW, targetH, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
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
  // Target ~55% of the band height as the cap-height so a single-line
  // label fits comfortably with breathing room. Patrick Hand has tall
  // ascenders; 0.55 is the empirically-OK upper bound.
  const fontPt = Math.max(12, Math.round(targetH * 0.55));
  // Sharp's text input wants a positive width AND height. We size the box
  // generously so Pango doesn't auto-shrink; the composite step positions
  // the result so its bounding box is centred on the label band.
  const safeW = Math.max(16, Math.round(targetW));
  const safeH = Math.max(16, Math.round(targetH));
  return await sharp({
    text: {
      // Escape the few chars that Pango markup treats as control (&, <, >).
      // We're NOT using markup, but Pango still parses these unless we
      // pass them through their entity equivalents. Without this, a label
      // like "AT&T" would silently error out on the Pango parser.
      text: escapePangoText(trimmed),
      fontfile: LABEL_FONT_PATH,
      font: `${LABEL_FONT_FAMILY} ${fontPt}`,
      rgba: true,
      width: safeW,
      height: safeH,
      align: 'centre',
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
 * The returned PNG is `cellW × labelH` (bottom strip only). Caller
 * composites it at `(cell.x, cell.y + illustrationH)` so the AI's
 * illustration region is left untouched.
 */
export async function buildSquareLabelBandOverlay(
  label: string,
  cellW: number,
  cellH: number,
): Promise<{ overlay: Buffer; topOffset: number }> {
  const illustrationH = Math.round(cellH * SQUARE_ILLUSTRATION_FRAC);
  const labelH = cellH - illustrationH;
  const borderPx = squareBorderPx(cellW);
  const halfBorder = borderPx / 2;
  // White rect covering the band, plus the bottom + left + right sides
  // of the cell's outer border (the top hairline is drawn separately so
  // it sits exactly on the illustration/label seam). The band PNG is
  // composited at the cell's labelTop, so its origin (0,0) corresponds
  // to (cell.x, cell.y + illustrationH) in canvas coords.
  const bandSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}">
    <rect x="0" y="0" width="${cellW}" height="${labelH}" fill="white"/>
    <rect x="${halfBorder}" y="0" width="${cellW - borderPx}" height="${labelH - halfBorder}" fill="none" stroke="${BLACK}" stroke-width="${borderPx}"/>
    <line x1="0" y1="0" x2="${cellW}" y2="0" stroke="${BLACK}" stroke-width="${Math.max(1, Math.round(borderPx / 3))}"/>
  </svg>`;
  const labelPad = Math.max(2, Math.round(cellW * 0.04));
  const labelPngRaw = await renderLabelPng(label, cellW - 2 * labelPad, Math.max(8, labelH - 2));
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
  const overlay = await sharp({
    create: { width: cellW, height: labelH, channels: 4, background: WHITE },
  })
    .composite([
      { input: Buffer.from(bandSvg), top: 0, left: 0 },
      { input: labelPng, top: labelTop, left: labelLeft },
    ])
    .png()
    .toBuffer();
  return { overlay, topOffset: illustrationH };
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

  const cardByIndex = new Map<number, TopicCard>();
  for (const c of cards) cardByIndex.set(c.index, c);
  const uploadByIndex = new Map<number, Buffer>();
  for (const up of uploads) uploadByIndex.set(up.cardIndex, up.bytes);

  const overlays: sharp.OverlayOptions[] = [];

  // Iterate every card in reading order. Upload presence picks between
  // full-cell overlay (wipes the AI render at that cell) and label-only
  // overlay (keeps the AI illustration, only overpaints the label band).
  for (const card of cards) {
    const rect = cellRect(layout, card.index);
    const uploadedBytes = uploadByIndex.get(card.index);

    if (uploadedBytes) {
      const overlay =
        cardShape === 'circle'
          ? await buildCircleCellOverlay(uploadedBytes, card.label, rect.w, rect.h)
          : await buildSquareCellOverlay(uploadedBytes, card.label, rect.w, rect.h);
      overlays.push({ input: overlay, top: rect.y, left: rect.x });
      continue;
    }

    // Non-upload cells: only paint a uniform-style label band in square
    // mode. Skip for circle mode — the AI renders labels beneath the
    // disc on white canvas and overpainting risks blanking the disc if
    // the layout-derived band misses by a few pixels (the reference
    // sample size for circle mode is small).
    if (cardShape === 'square') {
      const { overlay, topOffset } = await buildSquareLabelBandOverlay(card.label, rect.w, rect.h);
      overlays.push({ input: overlay, top: rect.y + topOffset, left: rect.x });
    }
  }

  if (overlays.length === 0) {
    return await sharp(baseImage, { limitInputPixels: SHARP_INPUT_PIXEL_CAP }).png().toBuffer();
  }

  return await sharp(baseImage, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
    .composite(overlays)
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
): Promise<Buffer> {
  const illustrationH = Math.round(cellH * SQUARE_ILLUSTRATION_FRAC);
  const labelH = cellH - illustrationH;

  // 1) Cover-fit the uploaded image to the illustration area.
  const illustrationPng = await fitCover(imageBytes, cellW, illustrationH);

  // 2) Render the label text PNG. We give it the label band width with
  //    a small horizontal padding so descenders don't kiss the border.
  const labelPad = Math.max(2, Math.round(cellW * 0.04));
  const labelPng = await renderLabelPng(
    label,
    cellW - 2 * labelPad,
    Math.max(8, labelH - 2),
  );
  const labelMeta = await sharp(labelPng).metadata();
  const labelW = labelMeta.width ?? 1;
  const labelTextH = labelMeta.height ?? 1;

  // 3) Render the chrome (border + hairline + label band background).
  const chrome = await buildSquareCellChrome(cellW, cellH);

  // 4) Composite everything onto a white base of the cell size so the
  //    cell is fully covered (wiping anything the AI rendered there).
  const labelLeft = Math.max(0, Math.round((cellW - labelW) / 2));
  const labelTop = Math.max(
    illustrationH + 1,
    illustrationH + Math.round((labelH - labelTextH) / 2),
  );
  return await sharp({
    create: { width: cellW, height: cellH, channels: 4, background: WHITE },
  })
    .composite([
      { input: illustrationPng, top: 0, left: 0 },
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
): Promise<Buffer> {
  // Geometry is computed in canvas-local coords; we pass cellX/cellY = 0
  // so the returned positions are within the overlay's own frame.
  const geom = circleCellGeometry(0, 0, cellW, cellH);
  const discD = Math.round(geom.discD);

  // 1) Cover-fit the uploaded image to a discD × discD square.
  const square = await fitCover(imageBytes, discD, discD);

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
  const labelPng = await renderLabelPng(label, labelW, labelH);
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
