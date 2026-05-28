/**
 * Flex Icon Grid — server-side composer.
 *
 * Takes a validated `FlexIconGridConfig` and produces a finished PNG
 * buffer ready to upload to R2 + return to the client. No AI image
 * generation involved; every pixel is composed deterministically with
 * SVG + Sharp.
 *
 * Pipeline:
 *   1. Resolve per-cell background colours (palette engine, adjacency
 *      rule).
 *   2. Build the master SVG — canvas background, every cell's shape,
 *      every cell's ring, every Lucide icon inlined as SVG, every
 *      label band rect, optional title bar background.
 *   3. Rasterise the master SVG to a PNG base via `sharp(svg).png()`.
 *   4. Composite per-cell layers on top:
 *      - Uploaded images (cover-fit, masked to the cell's shape).
 *      - Emoji glyphs (rendered via sharp's text input, Pango).
 *      - Text labels (rendered via sharp's text input with the
 *        configured font + size + colour + optional stroke).
 *      - Text-only content (same path as labels, sized to fit the
 *        whole shape area).
 *      - Title bar text (single text layer over the title bar rect).
 *   5. Final PNG buffer.
 *
 * Why split between SVG base and composited text layers:
 *   librsvg (Sharp's SVG renderer) does not load TTFs from disk at
 *   runtime — it relies on fontconfig, which on Vercel ships only a
 *   minimal system set. We avoid the issue entirely by handing every
 *   piece of text to sharp's text input (`text:`) which passes
 *   `fontfile` directly to Pango. The base SVG carries shapes only.
 *   This mirrors `topic-card-grid-composite.ts`.
 *
 * Observability (rule 14): every step of the pipeline emits a
 * `[flex-icon-grid composer]` log line with input shape and timing so
 * a single failed render can be diagnosed from console output alone.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  applyLabelCase,
  computeCellGeometry,
  computeCellRect,
  computeGridLayout,
  escapeSvgText,
  getConsumedCellIndexes,
  sanitizeUserText,
  type CellBackgroundSpec,
  type CellContent,
  type CellShape,
  type FlexIconCell,
  type FlexIconGridConfig,
  type GridLayout,
  type LabelFont,
  type LabelStyle,
  type RingStyle,
} from './flex-icon-grid';
import { inlineIconSvg } from './flex-icon-grid-icons';
import { pickLabelColourFor, resolveCellBackgrounds } from './flex-icon-grid-palettes';
import { fetchTwemojiSvg } from './flex-icon-grid-emoji';

// ─── Font resolution ────────────────────────────────────────────────────────

/**
 * Pango font-family name + on-disk TTF path per bundled `LabelFont`.
 * The family name passed to Pango must match the TTF's internal
 * Font Family record; we cache the mapping here so the rest of the
 * composer never has to remember.
 *
 * `patrick-hand` reuses the existing
 * `public/fonts/PatrickHand-Regular.ttf` that the topic-card-grid
 * composite already depends on. The other three TTFs ship under a
 * dedicated `public/fonts/flex-icon-grid/` directory.
 *
 * The `'custom'` variant is intentionally absent — it's resolved
 * dynamically per render via `resolveCustomFont` (Phase 4.7).
 */
const FONT_RESOLVER: Record<Exclude<LabelFont, 'custom'>, { family: string; path: string }> = {
  'anton': {
    family: 'Anton',
    path: path.join(process.cwd(), 'public/fonts/flex-icon-grid/Anton-Regular.ttf'),
  },
  'bowlby-one': {
    family: 'Bowlby One',
    path: path.join(process.cwd(), 'public/fonts/flex-icon-grid/BowlbyOne-Regular.ttf'),
  },
  'archivo-black': {
    family: 'Archivo Black',
    path: path.join(process.cwd(), 'public/fonts/flex-icon-grid/ArchivoBlack-Regular.ttf'),
  },
  'patrick-hand': {
    family: 'Patrick Hand',
    path: path.join(process.cwd(), 'public/fonts/PatrickHand-Regular.ttf'),
  },
};

/**
 * Per-render custom-font cache + temp-file tracker. The composer
 * creates one of these at the top of `composeFlexIconGrid` and threads
 * it through every label-overlay call. Behaviour:
 *
 *  - First time a unique custom font URL is requested: fetch the
 *    bytes via the same SSRF-guarded fetcher used for cell uploads,
 *    write them to an os-tmpdir file with a random name, return
 *    `{ family, path }`.
 *  - Subsequent requests for the same URL: serve the cached entry.
 *  - At the end of the render (success OR failure), `cleanup()` deletes
 *    every temp file written. Process never accumulates per-tenant
 *    fonts on disk.
 *
 * Pango/fontconfig need the font installed by family name. We don't
 * trust the uploaded font's internal family record — different fonts
 * can collide on "Regular", "Sans", etc. The resolver assigns a
 * unique randomised family name per URL so Pango never accidentally
 * substitutes one custom font for another within the same render.
 */
interface CustomFontResolver {
  resolve(url: string): Promise<{ family: string; path: string } | null>;
  cleanup(): Promise<void>;
}

function makeCustomFontResolver(fetcher: UploadFetcher): CustomFontResolver {
  const cache = new Map<string, { family: string; path: string }>();
  const tempFiles: string[] = [];
  return {
    async resolve(url: string) {
      if (cache.has(url)) return cache.get(url)!;
      let bytes: Buffer;
      try {
        bytes = await fetcher(url);
      } catch (err) {
        console.warn('[flex-icon-grid composer] custom font fetch failed', {
          url_prefix: url.slice(0, 60),
          reason: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
      const family = `fg-custom-${crypto.randomBytes(6).toString('hex')}`;
      const ext = url.match(/\.(ttf|otf|woff|woff2)(?:\?|$)/i)?.[1] ?? 'ttf';
      const tempPath = path.join(
        os.tmpdir(),
        `${family}.${ext.toLowerCase()}`,
      );
      await fs.writeFile(tempPath, bytes);
      tempFiles.push(tempPath);
      const entry = { family, path: tempPath };
      cache.set(url, entry);
      return entry;
    },
    async cleanup() {
      for (const p of tempFiles) {
        try { await fs.unlink(p); } catch { /* file may already be gone */ }
      }
    },
  };
}

/**
 * Resolve a `LabelStyle.font` to its `{ family, path }`. For bundled
 * fonts the lookup is synchronous; for `'custom'` the resolver fetches
 * + writes the temp file and may return `null` on fetch failure (in
 * which case the caller falls back to the configured `defaultLabel`
 * font so a single broken font URL doesn't kill the whole render).
 */
async function resolveLabelFont(
  style: LabelStyle,
  resolver: CustomFontResolver,
  fallback: Exclude<LabelFont, 'custom'>,
): Promise<{ family: string; path: string }> {
  if (style.font === 'custom' && style.customFontUrl) {
    const got = await resolver.resolve(style.customFontUrl);
    if (got) return got;
  }
  if (style.font === 'custom') return FONT_RESOLVER[fallback];
  return FONT_RESOLVER[style.font];
}

/** Pick a bundled-font fallback for cells that requested 'custom' but
 *  whose URL failed to fetch. Honours the config's `defaultLabel.font`
 *  when it itself isn't 'custom' — keeps the visual character of the
 *  rest of the grid. Final fallback is Anton to match the panel
 *  default. */
function defaultFallbackFont(config: FlexIconGridConfig): Exclude<LabelFont, 'custom'> {
  if (config.defaultLabel.font !== 'custom') return config.defaultLabel.font;
  return 'anton';
}

// ─── Shared constants ───────────────────────────────────────────────────────

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 } as const;

/** Same cap the topic-card-grid composite uses — protects against
 *  pixel-bomb decodes on uploaded images. */
const SHARP_INPUT_PIXEL_CAP = 100_000_000;

/** Cap on icon-area font size used by the `text-only` content type.
 *  The font naturally scales with cell size; this is the absolute
 *  pixel ceiling so a 1×1 grid doesn't render a 700pt label. */
const TEXT_ONLY_FONT_PX_CEILING = 220;

// ─── Public surface ─────────────────────────────────────────────────────────

/**
 * Fetcher for an uploaded image URL. The render API supplies the
 * function so the composer stays free of network code (matches the
 * topic-card-grid-composite contract). Tests inject a stub that
 * returns canned bytes.
 *
 * The fetcher is responsible for SSRF protection — it should refuse
 * URLs that don't point at our R2 bucket. The composer trusts what
 * comes back.
 */
export type UploadFetcher = (url: string) => Promise<Buffer>;

export interface ComposeInput {
  config: FlexIconGridConfig;
  fetchUpload: UploadFetcher;
}

/**
 * Top-level composer. Returns a PNG buffer at `config.width × config.height`.
 *
 * Errors thrown here surface as 500s; the route should log them with
 * the same `[flex-icon-grid composer]` namespace so the production
 * trail stays consistent.
 */
export async function composeFlexIconGrid(input: ComposeInput): Promise<Buffer> {
  const start = Date.now();
  const { config, fetchUpload } = input;
  const { width, height } = config;
  console.info('[flex-icon-grid composer] start', {
    width, height, rows: config.rows, cols: config.cols,
    cell_count: config.cells.length,
    palette: paletteSummary(config),
    title_bar: !!config.titleBar,
  });

  const layout = computeGridLayout(config);
  const backgrounds = resolveCellBackgrounds(config);

  // 1) Base SVG — shapes, rings, inlined Lucide icons, title bar
  //    background. No text on this layer.
  const baseSvg = buildBaseSvg(config, layout, backgrounds);
  const baseStart = Date.now();
  const baseBuffer = await sharp(Buffer.from(baseSvg), {
    density: 144, // 2× density so vector lines stay crisp at output res
  })
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer();
  console.info('[flex-icon-grid composer] base svg ok', {
    bytes: baseBuffer.length, ms: Date.now() - baseStart,
  });

  // Custom-font resolver shared across every overlay call in this
  // render. Fetches user-uploaded TTFs via the same SSRF-guarded
  // fetcher, caches per URL, tracks temp files for cleanup. Cleanup
  // runs unconditionally in the `finally` below so a failed render
  // never leaks per-tenant fonts onto the function's tmpdir.
  const fontResolver = makeCustomFontResolver(fetchUpload);
  let finalBuffer: Buffer;
  try {
    // 2) Per-cell text + image overlays. Built in parallel where
    //    possible — each cell's overlays are independent of each
    //    other. Upload fetches are the slow path (network); resolve
    //    them in parallel via Promise.all. Cells consumed by another
    //    cell's span are skipped entirely.
    const overlayPlanStart = Date.now();
    const consumedForOverlays = getConsumedCellIndexes(config);
    const cellOverlays = await Promise.all(
      config.cells
        .filter((cell) => !consumedForOverlays.has(cell.index))
        .map((cell) =>
          buildCellOverlays(cell, config, layout, backgrounds[cell.index - 1], fetchUpload, fontResolver),
        ),
    );
    console.info('[flex-icon-grid composer] cell overlays planned', {
      ms: Date.now() - overlayPlanStart,
      cell_count: cellOverlays.length,
      total_overlays: cellOverlays.reduce((acc, list) => acc + list.length, 0),
    });

    const overlays: sharp.OverlayOptions[] = cellOverlays.flat();

    // 3) Title bar text — single overlay layered on top of the title
    //    bar background that the base SVG already painted.
    if (config.titleBar) {
      const titleOverlay = await buildTitleBarOverlay(config, fontResolver);
      if (titleOverlay) overlays.push(titleOverlay);
    }

    // 4) Single composite pass — one decode of the base, one encode of
    //    the output, regardless of how many cells / overlays.
    const compositeStart = Date.now();
    finalBuffer = await sharp(baseBuffer, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
      .composite(overlays)
      .png()
      .toBuffer();
    console.info('[flex-icon-grid composer] done', {
      bytes: finalBuffer.length,
      composite_ms: Date.now() - compositeStart,
      total_ms: Date.now() - start,
    });
  } finally {
    await fontResolver.cleanup();
  }
  return finalBuffer;
}

// ─── Base SVG ───────────────────────────────────────────────────────────────

/**
 * Build the master SVG carrying all the vector geometry (background,
 * cell shapes, rings, inlined icons, title bar background). Text is
 * not rendered here — the SVG output gets a sharp text overlay pass
 * afterwards. Keeping the boundaries clean lets us use real TTF
 * fonts without depending on system fontconfig.
 */
export function buildBaseSvg(
  config: FlexIconGridConfig,
  layout: GridLayout,
  backgrounds: string[],
): string {
  const { width, height } = config;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(renderCanvasBackground(config));
  if (config.titleBar) parts.push(renderTitleBarBackground(config));
  // Cell backgrounds may include gradients / patterns — accumulate
  // any required `<defs>` once and emit them after the canvas
  // background but before the cells. Pattern + gradient definitions
  // collide if they share ids, so each cell gets a unique id derived
  // from its index. Consumed cells (claimed by another cell's
  // cellSpan) are skipped entirely.
  const consumed = getConsumedCellIndexes(config);
  const renderableCells = config.cells.filter((c) => !consumed.has(c.index));
  const cellDefs: string[] = [];
  const cellBgFills: string[] = [];
  for (const cell of renderableCells) {
    const resolvedBg = resolveCellBackground(cell, backgrounds[cell.index - 1] ?? '#0a0a0a');
    const { fill, defs } = emitCellBackgroundFill(resolvedBg, cell.index);
    if (defs) cellDefs.push(defs);
    cellBgFills.push(fill);
  }
  if (cellDefs.length > 0) {
    parts.push(`<defs>${cellDefs.join('')}</defs>`);
  }
  for (let i = 0; i < renderableCells.length; i++) {
    const cell = renderableCells[i];
    const rect = computeCellRect(layout, cell.index, cell.cellSpan);
    const bgFill = cellBgFills[i];
    const referenceColour =
      cell.backgroundColor ?? backgrounds[cell.index - 1] ?? '#0a0a0a';
    parts.push(renderCellBackgroundRect(rect, bgFill));
    const shape = cell.shape ?? config.defaultCellShape;
    const ring = resolveRing(cell, config);
    const labelStyle = resolveLabelStyle(cell, config);
    const geom = computeCellGeometry(rect.x, rect.y, rect.w, rect.h, labelStyle.position);
    parts.push(renderCellShape(geom, shape, referenceColour, config.cornerRadius, ring));
    // Inline Lucide icon — done in the base SVG so we get crisp
    // vector at any output resolution. Other content types render
    // as text/image overlays after rasterisation (separate pass).
    if (cell.content.type === 'icon-library') {
      parts.push(renderIconLibrary(cell.content, geom, referenceColour, ring));
    }
  }
  parts.push(`</svg>`);
  return parts.join('');
}

function renderCanvasBackground(config: FlexIconGridConfig): string {
  const { width, height, background } = config;
  if (background.type === 'gradient') {
    const id = 'fg-bg-grad';
    return [
      `<defs><linearGradient id="${id}" gradientTransform="rotate(${background.angle} 0.5 0.5)">`,
      `<stop offset="0%" stop-color="${escapeSvgText(background.from)}"/>`,
      `<stop offset="100%" stop-color="${escapeSvgText(background.to)}"/>`,
      `</linearGradient></defs>`,
      `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${id})"/>`,
    ].join('');
  }
  return `<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeSvgText(background.color)}"/>`;
}

function renderTitleBarBackground(config: FlexIconGridConfig): string {
  const { titleBar, width, height } = config;
  if (!titleBar) return '';
  const y = titleBar.position === 'top' ? 0 : height - titleBar.height;
  return `<rect x="0" y="${y}" width="${width}" height="${titleBar.height}" fill="${escapeSvgText(titleBar.background)}"/>`;
}

function renderCellBackgroundRect(
  rect: { x: number; y: number; w: number; h: number },
  fillAttr: string,
): string {
  // `fillAttr` may be a plain hex colour OR a `url(#fg-cell-bg-N)`
  // reference into <defs> for gradients / patterns. Either form is
  // already escaped — emit verbatim.
  return `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="${fillAttr}"/>`;
}

/**
 * Resolve the per-cell background to a concrete `CellBackgroundSpec`.
 * Precedence:
 *   1. `cell.background` — explicit Phase-2 rich spec.
 *   2. `cell.backgroundColor` — Phase-1 solid shorthand.
 *   3. Palette assignment from `resolveCellBackgrounds`.
 * Pure function — exported for the live preview so the client uses
 * the same resolution logic as the server composer.
 */
export function resolveCellBackground(
  cell: FlexIconCell,
  paletteColour: string,
): CellBackgroundSpec {
  if (cell.background) return cell.background;
  if (cell.backgroundColor) return { type: 'solid', color: cell.backgroundColor };
  return { type: 'solid', color: paletteColour };
}

/**
 * Emit the `fill` attribute (and any `<defs>` content) for the cell's
 * background spec. Solid → direct hex. Gradient → linearGradient def
 * + url() ref. Pattern → SVG `<pattern>` def + url() ref. Image →
 * pattern with embedded image fragment (so the cell rect's `fill`
 * remains a simple url() reference).
 *
 * `cellIndex` is folded into every def id so multiple cells with
 * different gradient/pattern configs don't collide.
 */
function emitCellBackgroundFill(
  spec: CellBackgroundSpec,
  cellIndex: number,
): { fill: string; defs: string } {
  if (spec.type === 'solid') {
    return { fill: escapeSvgText(spec.color), defs: '' };
  }
  if (spec.type === 'gradient') {
    const id = `fg-cell-bg-${cellIndex}`;
    const defs =
      `<linearGradient id="${id}" gradientTransform="rotate(${spec.angle} 0.5 0.5)">` +
      `<stop offset="0%" stop-color="${escapeSvgText(spec.from)}"/>` +
      `<stop offset="100%" stop-color="${escapeSvgText(spec.to)}"/>` +
      `</linearGradient>`;
    return { fill: `url(#${id})`, defs };
  }
  if (spec.type === 'pattern') {
    const id = `fg-cell-bg-${cellIndex}`;
    const defs = emitPatternDef(id, spec);
    return { fill: `url(#${id})`, defs };
  }
  // image
  const id = `fg-cell-bg-${cellIndex}`;
  const defs =
    `<pattern id="${id}" patternUnits="objectBoundingBox" width="1" height="1">` +
    `<image href="${escapeSvgText(spec.url)}" x="0" y="0" width="1" height="1" preserveAspectRatio="xMidYMid slice"/>` +
    `</pattern>`;
  return { fill: `url(#${id})`, defs };
}

/**
 * Build a small SVG `<pattern>` definition for one of the catalogue
 * patterns. Pattern unit size is 24 px — small enough to read as a
 * texture, large enough to render cleanly at 4K output.
 *
 * The four catalogue patterns:
 *  - dots: small filled circle on a solid background.
 *  - stripes: 45° diagonal stripe.
 *  - grid: thin horizontal + vertical lines.
 *  - checker: alternating squares (8 px granularity).
 */
function emitPatternDef(
  id: string,
  spec: Extract<CellBackgroundSpec, { type: 'pattern' }>,
): string {
  const fg = escapeSvgText(spec.fg);
  const bg = escapeSvgText(spec.bg);
  if (spec.pattern === 'dots') {
    return (
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="24" height="24">` +
      `<rect width="24" height="24" fill="${bg}"/>` +
      `<circle cx="12" cy="12" r="3" fill="${fg}"/>` +
      `</pattern>`
    );
  }
  if (spec.pattern === 'stripes') {
    return (
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="20" height="20" patternTransform="rotate(45)">` +
      `<rect width="20" height="20" fill="${bg}"/>` +
      `<rect width="10" height="20" fill="${fg}"/>` +
      `</pattern>`
    );
  }
  if (spec.pattern === 'grid') {
    return (
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="24" height="24">` +
      `<rect width="24" height="24" fill="${bg}"/>` +
      `<path d="M 24 0 L 0 0 0 24" fill="none" stroke="${fg}" stroke-width="2"/>` +
      `</pattern>`
    );
  }
  // checker
  return (
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="16" height="16">` +
    `<rect width="16" height="16" fill="${bg}"/>` +
    `<rect x="0" y="0" width="8" height="8" fill="${fg}"/>` +
    `<rect x="8" y="8" width="8" height="8" fill="${fg}"/>` +
    `</pattern>`
  );
}

function renderCellShape(
  geom: ReturnType<typeof computeCellGeometry>,
  shape: CellShape,
  cellBackground: string,
  cornerRadius: number,
  ring: RingStyle,
): string {
  const cx = geom.shapeX + geom.shapeW / 2;
  const cy = geom.shapeY + geom.shapeH / 2;
  const ringAttrs = ring
    ? ` stroke="${escapeSvgText(ring.color)}" stroke-width="${ring.thickness}"${
        ring.style === 'dashed'
          ? ` stroke-dasharray="${ring.thickness * 2} ${ring.thickness * 1.5}"`
          : ''
      }`
    : '';
  // Shape fill: the icon ring's inner area gets a near-white
  // background so the embedded Lucide icon reads against it (the
  // reference look — icons sit in an off-white disc on the bright
  // cell). When the user has uploaded an image or chosen text-only,
  // the overlay pass paints on top of this fill anyway.
  const shapeFill = '#fbfbf8';
  if (shape === 'circle') {
    const r = geom.shapeW / 2;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${shapeFill}"${ringAttrs}/>`;
  }
  if (shape === 'rounded-square') {
    const rx = Math.min(cornerRadius, geom.shapeW / 4);
    return `<rect x="${geom.shapeX}" y="${geom.shapeY}" width="${geom.shapeW}" height="${geom.shapeH}" rx="${rx}" ry="${rx}" fill="${shapeFill}"${ringAttrs}/>`;
  }
  if (shape === 'hexagon') {
    const points = hexagonPoints(cx, cy, geom.shapeW);
    return `<polygon points="${points}" fill="${shapeFill}"${ringAttrs}/>`;
  }
  if (shape === 'pill') {
    const pw = geom.shapeW * 0.55;
    const ph = geom.shapeH;
    const px = cx - pw / 2;
    const py = cy - ph / 2;
    const pr = pw / 2;
    return `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="${pr}" ry="${pr}" fill="${shapeFill}"${ringAttrs}/>`;
  }
  if (shape === 'capsule') {
    const cw = geom.shapeW;
    const ch = geom.shapeH * 0.55;
    const cxr = cx - cw / 2;
    const cyr = cy - ch / 2;
    const cr = ch / 2;
    return `<rect x="${cxr}" y="${cyr}" width="${cw}" height="${ch}" rx="${cr}" ry="${cr}" fill="${shapeFill}"${ringAttrs}/>`;
  }
  // square
  return `<rect x="${geom.shapeX}" y="${geom.shapeY}" width="${geom.shapeW}" height="${geom.shapeH}" fill="${shapeFill}"${ringAttrs}/>`;
}

/**
 * Six vertices for a flat-top regular hexagon centred at (cx, cy)
 * inscribed in a square of side `size`. Returned as the SVG
 * `points` attribute string. Flat-top means the top and bottom edges
 * are horizontal — visually heavier than pointy-top, matches the
 * "honeycomb" look the editor most often wants.
 *
 * Inscribed in a square: the hexagon's full width equals `size`; its
 * height is `size * sqrt(3)/2` so it sits centred vertically with
 * roughly 6.7% margin top + bottom.
 */
function hexagonPoints(cx: number, cy: number, size: number): string {
  const w = size;
  const h = size * 0.866; // sqrt(3) / 2
  const halfW = w / 2;
  const halfH = h / 2;
  const quarterW = w / 4;
  return [
    `${cx - halfW},${cy}`,
    `${cx - quarterW},${cy - halfH}`,
    `${cx + quarterW},${cy - halfH}`,
    `${cx + halfW},${cy}`,
    `${cx + quarterW},${cy + halfH}`,
    `${cx - quarterW},${cy + halfH}`,
  ].join(' ');
}

function renderIconLibrary(
  content: Extract<CellContent, { type: 'icon-library' }>,
  geom: ReturnType<typeof computeCellGeometry>,
  _cellBackground: string,
  ring: RingStyle,
): string {
  // Icon sits at ~62% of the shape's diameter — the reference
  // channels have the glyph filling most of the disc with a small
  // breathing margin inside the ring. Stroke colour matches the ring
  // (or falls back to dark) so the icon and ring read as one
  // continuous element.
  const iconSize = Math.round(geom.shapeW * 0.62);
  const cx = geom.shapeX + geom.shapeW / 2;
  const cy = geom.shapeY + geom.shapeH / 2;
  const strokeColor = ring?.color ?? '#0a0a0a';
  // Icon stroke ~3% of icon size, floored at 2 px — keeps Lucide
  // line weight consistent across cell sizes from preview thumbnails
  // (under 100 px) to 4K renders (cell ~1200 px).
  const strokeWidth = Math.max(2, Math.round(iconSize * 0.06));
  return inlineIconSvg(content.name, cx, cy, iconSize, strokeColor, strokeWidth);
}

// ─── Per-cell overlay pass ──────────────────────────────────────────────────

/**
 * Build the sharp composite overlays for one cell. Returns the
 * overlays in paint order. Each overlay is positioned with absolute
 * (top, left) co-ordinates relative to the canvas.
 *
 * Sharp composites overlays in array order, so this returns:
 *   1. Uploaded image (if any) — masked to the shape.
 *   2. Emoji glyph (if any) — text overlay sized to fit the shape.
 *   3. Text-only content (if any) — text overlay sized to fit the
 *      whole shape area.
 *   4. Label text (always rendered when label is visible) — separate
 *      band below/above or overlay strip.
 */
async function buildCellOverlays(
  cell: FlexIconCell,
  config: FlexIconGridConfig,
  layout: GridLayout,
  background: string,
  fetchUpload: UploadFetcher,
  fontResolver: CustomFontResolver,
): Promise<sharp.OverlayOptions[]> {
  const rect = computeCellRect(layout, cell.index, cell.cellSpan);
  const labelStyle = resolveLabelStyle(cell, config);
  const shape = cell.shape ?? config.defaultCellShape;
  const ring = resolveRing(cell, config);
  const geom = computeCellGeometry(rect.x, rect.y, rect.w, rect.h, labelStyle.position);

  const overlays: sharp.OverlayOptions[] = [];

  // Content overlays
  if (cell.content.type === 'upload') {
    const uploadOverlay = await buildUploadOverlay(cell.content.url, geom, shape, ring, config.cornerRadius, fetchUpload, cell.index);
    if (uploadOverlay) overlays.push(uploadOverlay);
  } else if (cell.content.type === 'ai-sticker' && cell.content.url) {
    // Generated stickers paint exactly like uploads — the URL points
    // at the sliced quadrant the generate-stickers route uploaded to
    // R2. When the sticker has not yet been generated (`url` empty)
    // the cell falls through to its shape fill (handled by the base
    // SVG) — visible as an empty disc the user can click to generate.
    const stickerOverlay = await buildUploadOverlay(cell.content.url, geom, shape, ring, config.cornerRadius, fetchUpload, cell.index);
    if (stickerOverlay) overlays.push(stickerOverlay);
  } else if (cell.content.type === 'emoji') {
    const emojiOverlay = await buildEmojiOverlay(cell.content.char, geom);
    if (emojiOverlay) overlays.push(emojiOverlay);
  } else if (cell.content.type === 'text-only') {
    const textOverlay = await buildTextOnlyOverlay(cell.label, geom, labelStyle, background, fontResolver, defaultFallbackFont(config));
    if (textOverlay) overlays.push(textOverlay);
  }
  // `icon-library` already painted into the base SVG — no overlay
  // needed.

  // Label overlay (skip when overlap with text-only mode, which
  // already prints the label as its content).
  if (labelStyle.position !== 'hidden' && cell.content.type !== 'text-only') {
    const labelOverlay = await buildLabelOverlay(cell.label, geom, labelStyle, background, cell.content.type === 'upload', shape, fontResolver, defaultFallbackFont(config));
    if (labelOverlay) overlays.push(labelOverlay);
  }

  return overlays;
}

// ─── Upload overlay ─────────────────────────────────────────────────────────

async function buildUploadOverlay(
  url: string,
  geom: ReturnType<typeof computeCellGeometry>,
  shape: CellShape,
  ring: RingStyle,
  cornerRadius: number,
  fetchUpload: UploadFetcher,
  cellIndex: number,
): Promise<sharp.OverlayOptions | null> {
  const fetchStart = Date.now();
  let bytes: Buffer;
  try {
    bytes = await fetchUpload(url);
  } catch (err) {
    console.warn('[flex-icon-grid composer] upload fetch failed', {
      cell_index: cellIndex, url_prefix: url.slice(0, 60),
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  console.info('[flex-icon-grid composer] upload fetched', {
    cell_index: cellIndex, bytes: bytes.length, ms: Date.now() - fetchStart,
  });
  const w = Math.round(geom.shapeW);
  const h = Math.round(geom.shapeH);
  if (w <= 0 || h <= 0) return null;
  // Cover-fit the bytes into the shape's bounding box.
  let imageBuffer = await sharp(bytes, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
    .resize(w, h, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
  // Mask to the shape so corner pixels (circle / rounded square)
  // don't leak over the ring. Mask is generated as a tiny SVG and
  // applied via `blend: 'dest-in'` (same technique as
  // topic-card-grid-composite's circularMaskSvg).
  const mask = shapeMaskSvg(shape, w, h, cornerRadius);
  if (mask) {
    imageBuffer = await sharp(imageBuffer)
      .composite([{ input: Buffer.from(mask), blend: 'dest-in' }])
      .png()
      .toBuffer();
  }
  // Inset by the ring thickness so the ring stays visible around
  // the image. Ring is drawn in the base SVG; this just makes sure
  // the overlay doesn't sit on top of the ring stroke.
  const ringThickness = ring?.thickness ?? 0;
  const inset = Math.max(0, Math.round(ringThickness / 2));
  return {
    input: imageBuffer,
    top: Math.round(geom.shapeY) + inset,
    left: Math.round(geom.shapeX) + inset,
  };
}

function shapeMaskSvg(shape: CellShape, w: number, h: number, cornerRadius: number): string | null {
  if (shape === 'circle') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}" fill="white"/></svg>`;
  }
  if (shape === 'rounded-square') {
    const r = Math.min(cornerRadius, Math.min(w, h) / 4);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="white"/></svg>`;
  }
  if (shape === 'hexagon') {
    const points = hexagonPoints(w / 2, h / 2, Math.min(w, h));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><polygon points="${points}" fill="white"/></svg>`;
  }
  if (shape === 'pill') {
    const pw = w * 0.55;
    const ph = h;
    const px = (w - pw) / 2;
    const pr = pw / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${px}" y="0" width="${pw}" height="${ph}" rx="${pr}" ry="${pr}" fill="white"/></svg>`;
  }
  if (shape === 'capsule') {
    const cw = w;
    const ch = h * 0.55;
    const cyr = (h - ch) / 2;
    const cr = ch / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="${cyr}" width="${cw}" height="${ch}" rx="${cr}" ry="${cr}" fill="white"/></svg>`;
  }
  // square — no mask needed; the image already fills the rect.
  return null;
}

// ─── Emoji overlay ──────────────────────────────────────────────────────────

async function buildEmojiOverlay(
  char: string,
  geom: ReturnType<typeof computeCellGeometry>,
): Promise<sharp.OverlayOptions | null> {
  const safe = sanitizeUserText(char, 16);
  if (!safe) return null;
  // Emoji size matches the icon-library size (~62% of shape) so the
  // visual weight reads the same regardless of which content type the
  // user picks.
  const sizePx = Math.max(16, Math.round(Math.min(geom.shapeW, geom.shapeH) * 0.62));
  const safeW = Math.max(16, Math.round(geom.shapeW));
  // Try Twemoji first — produces colour SVG glyphs reliably across
  // every deploy environment (Vercel Linux included), which the
  // system-fontconfig path doesn't. Fall through to Pango's text
  // input only if the Twemoji CDN didn't return an SVG for this
  // codepoint (rare unknown emoji or transient CDN failure).
  const twemojiSvg = await fetchTwemojiSvg(safe);
  if (twemojiSvg) {
    const buf = await sharp(twemojiSvg, { density: 288 })
      .resize(sizePx, sizePx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const left = Math.round(geom.shapeX + (geom.shapeW - sizePx) / 2);
    const top = Math.round(geom.shapeY + (geom.shapeH - sizePx) / 2);
    return { input: buf, top, left };
  }
  // Pango fallback — same behaviour as the Phase 1 implementation.
  const buf = await sharp({
    text: {
      text: safe,
      font: `sans ${sizePx}`,
      rgba: true,
      width: safeW,
      align: 'centre',
    },
  })
    .png()
    .toBuffer();
  const meta = await sharp(buf).metadata();
  const renderedW = meta.width ?? safeW;
  const renderedH = meta.height ?? sizePx;
  const left = Math.round(geom.shapeX + (geom.shapeW - renderedW) / 2);
  const top = Math.round(geom.shapeY + (geom.shapeH - renderedH) / 2);
  return { input: buf, top, left };
}

// ─── Text-only overlay ──────────────────────────────────────────────────────

async function buildTextOnlyOverlay(
  label: string,
  geom: ReturnType<typeof computeCellGeometry>,
  labelStyle: LabelStyle,
  background: string,
  fontResolver: CustomFontResolver,
  defaultFont: Exclude<LabelFont, 'custom'>,
): Promise<sharp.OverlayOptions | null> {
  // For text-only content the label IS the cell content — render it
  // big and centred inside the shape area, ignoring labelStyle.position
  // (the configured position would put it outside the shape).
  const text = applyLabelCase(sanitizeUserText(label, 30), labelStyle.case);
  if (!text) return null;
  const font = await resolveLabelFont(labelStyle, fontResolver, defaultFont);
  const sizePx = Math.min(
    TEXT_ONLY_FONT_PX_CEILING,
    Math.max(20, Math.round(Math.min(geom.shapeW, geom.shapeH) * 0.40)),
  );
  const safeW = Math.max(16, Math.round(geom.shapeW * 0.9));
  const colour = resolveLabelTextColour(labelStyle, background);
  const buf = await sharp({
    text: {
      text: escapePangoText(text),
      fontfile: font.path,
      font: `${font.family} ${sizePx}`,
      rgba: true,
      width: safeW,
      align: 'centre',
      wrap: 'word',
    },
  })
    .png()
    .toBuffer();
  // Apply tint via composite if the configured colour isn't black —
  // Pango doesn't take a fill in our path, so we tint the rendered
  // alpha bitmap with a solid colour layer.
  const tinted = await tintPngTo(buf, colour);
  const meta = await sharp(tinted).metadata();
  const renderedW = meta.width ?? safeW;
  const renderedH = meta.height ?? sizePx;
  const left = Math.round(geom.shapeX + (geom.shapeW - renderedW) / 2);
  const top = Math.round(geom.shapeY + (geom.shapeH - renderedH) / 2);
  return { input: tinted, top, left };
}

// ─── Label overlay ──────────────────────────────────────────────────────────

async function buildLabelOverlay(
  label: string,
  geom: ReturnType<typeof computeCellGeometry>,
  labelStyle: LabelStyle,
  background: string,
  _isUploadCell: boolean,
  _shape: CellShape,
  fontResolver: CustomFontResolver,
  defaultFont: Exclude<LabelFont, 'custom'>,
): Promise<sharp.OverlayOptions | null> {
  if (labelStyle.position === 'hidden') return null;
  const text = applyLabelCase(sanitizeUserText(label, 60), labelStyle.case);
  if (!text) return null;
  const font = await resolveLabelFont(labelStyle, fontResolver, defaultFont);
  // Label font size: 60% of the band height for single-line, 35%
  // for two-line — chunky enough to read at mobile thumbnail size
  // while leaving a small breathing margin around the text. Floor of
  // 12 px so tiny preview cells don't drop below Pango's minimum.
  const bandH = Math.round(labelStyle.position === 'overlay' ? geom.labelH * 0.7 : geom.labelH);
  const sizePx = Math.max(
    12,
    Math.round(bandH * (labelStyle.maxLines === 2 ? 0.42 : 0.62)),
  );
  const safeW = Math.max(16, Math.round(geom.labelW * 0.92));
  const colour = resolveLabelTextColour(labelStyle, background);
  let buf = await sharp({
    text: {
      text: escapePangoText(text),
      fontfile: font.path,
      font: `${font.family} ${sizePx}`,
      rgba: true,
      width: safeW,
      align: 'centre',
      wrap: 'word',
    },
  })
    .png()
    .toBuffer();
  // Tint to the configured colour (Pango renders alpha; we paint the
  // alpha mask in the configured colour).
  buf = await tintPngTo(buf, colour);
  // Optional stroke: render a second copy at a slightly larger size
  // tinted to the stroke colour, then composite the main text on top.
  // Cheap approximation of a real outline that's "good enough" at
  // YouTube thumbnail render sizes (we revisit if visible artefacts
  // crop up). Skipped when stroke is null or zero thickness.
  if (labelStyle.stroke && labelStyle.stroke.thickness > 0) {
    const strokeBuf = await sharp({
      text: {
        text: escapePangoText(text),
        fontfile: font.path,
        font: `${font.family} ${sizePx}`,
        rgba: true,
        width: safeW,
        align: 'centre',
        wrap: 'word',
      },
    })
      .png()
      .toBuffer();
    const tintedStroke = await tintPngTo(strokeBuf, labelStyle.stroke.color);
    const strokeMeta = await sharp(tintedStroke).metadata();
    const sw = (strokeMeta.width ?? safeW) + labelStyle.stroke.thickness * 2;
    const sh = (strokeMeta.height ?? sizePx) + labelStyle.stroke.thickness * 2;
    // Blow the stroke layer up by the thickness so it shows around
    // the inner text. Cheap and works at thumbnail size.
    const dilated = await sharp(tintedStroke).resize(sw, sh, { fit: 'fill' }).png().toBuffer();
    buf = await sharp(dilated)
      .composite([{ input: buf, gravity: 'centre' }])
      .png()
      .toBuffer();
  }
  // Resize-inside if Pango rendered taller than the band (long
  // unbreakable words). Mirrors the guard in topic-card-grid-composite.
  const finalMeta = await sharp(buf).metadata();
  const bw = finalMeta.width ?? safeW;
  const bh = finalMeta.height ?? sizePx;
  const maxBandH = Math.max(8, Math.round(geom.labelH) - 4);
  if (bh > maxBandH || bw > safeW) {
    buf = await sharp(buf).resize({ width: safeW, height: maxBandH, fit: 'inside' }).png().toBuffer();
  }
  const finalMeta2 = await sharp(buf).metadata();
  const fw = finalMeta2.width ?? safeW;
  const fh = finalMeta2.height ?? sizePx;
  const left = Math.round(geom.labelX + (geom.labelW - fw) / 2);
  const top =
    labelStyle.position === 'overlay'
      ? Math.round(geom.labelY + (geom.labelH - fh) / 2)
      : Math.round(geom.labelY + (geom.labelH - fh) / 2);
  return { input: buf, top, left };
}

// ─── Title bar overlay ──────────────────────────────────────────────────────

async function buildTitleBarOverlay(
  config: FlexIconGridConfig,
  fontResolver: CustomFontResolver,
): Promise<sharp.OverlayOptions | null> {
  const { titleBar, width, height } = config;
  if (!titleBar) return null;
  const text = sanitizeUserText(titleBar.text, 80);
  if (!text) return null;
  // Title bar carries its own font but no `LabelStyle` envelope; wrap
  // the field in a minimal style so `resolveLabelFont` can dispatch
  // uniformly. The fallback font sees the bundled set since the title
  // bar doesn't (yet) support a custom font URL.
  const minimalStyle: LabelStyle = {
    position: 'below',
    font: titleBar.font,
    case: 'as-typed',
    color: titleBar.color,
    stroke: null,
    maxLines: 1,
  };
  const fallbackFont: Exclude<LabelFont, 'custom'> =
    titleBar.font === 'custom' ? 'anton' : titleBar.font;
  const font = await resolveLabelFont(minimalStyle, fontResolver, fallbackFont);
  const safeW = Math.max(16, Math.round(width * 0.94));
  const sizePx = Math.max(16, Math.round(titleBar.height * 0.55));
  let buf = await sharp({
    text: {
      text: escapePangoText(text),
      fontfile: font.path,
      font: `${font.family} ${sizePx}`,
      rgba: true,
      width: safeW,
      align: 'centre',
      wrap: 'none',
    },
  })
    .png()
    .toBuffer();
  buf = await tintPngTo(buf, titleBar.color);
  const meta = await sharp(buf).metadata();
  const bw = meta.width ?? safeW;
  const bh = meta.height ?? sizePx;
  const left = Math.round((width - bw) / 2);
  const top =
    titleBar.position === 'top'
      ? Math.round((titleBar.height - bh) / 2)
      : Math.round(height - titleBar.height + (titleBar.height - bh) / 2);
  return { input: buf, top, left };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveRing(cell: FlexIconCell, config: FlexIconGridConfig): RingStyle {
  if (cell.ring === null) return null;
  if (cell.ring) return cell.ring;
  return config.defaultRing;
}

function resolveLabelStyle(cell: FlexIconCell, config: FlexIconGridConfig): LabelStyle {
  return {
    ...config.defaultLabel,
    ...(cell.labelStyle ?? {}),
  };
}

/**
 * Pick the label rendering colour. When the user has explicitly set a
 * colour on the label style, use it. Otherwise, pick black or white
 * automatically based on background luminance — protects against
 * black labels on near-black cells (unreadable) and white labels on
 * yellow cells (also unreadable).
 *
 * Heuristic: if the configured colour is the panel's default
 * (`#0a0a0a`), assume the user hasn't overridden it and auto-pick;
 * if the colour is anything else, respect the user's choice.
 */
function resolveLabelTextColour(style: LabelStyle, background: string): string {
  if (style.color !== '#0a0a0a' && style.color !== '#0A0A0A') return style.color;
  return pickLabelColourFor(background);
}

/**
 * Recolour an alpha PNG to a target solid colour while preserving
 * the per-pixel alpha. Used because sharp's text input renders the
 * glyphs in white by default, and we need them in the configured
 * colour without re-rendering through Pango (which would require
 * a different markup path).
 *
 * Implementation: extract the alpha channel as a mask, generate a
 * solid-colour buffer of the same size, and use `dest-in` to keep
 * only the alpha-covered pixels.
 */
async function tintPngTo(buffer: Buffer, hex: string): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  const w = meta.width ?? 1;
  const h = meta.height ?? 1;
  const { r, g, b } = parseHexToRgb(hex);
  const colourLayer = await sharp({
    create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return await sharp(colourLayer)
    .composite([{ input: buffer, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

function parseHexToRgb(hex: string): { r: number; g: number; b: number } {
  const s = hex.replace(/^#/, '');
  if (s.length === 3) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/**
 * Pango markup escape — same surface area as
 * `escapePangoText` in `topic-card-grid-composite.ts`. Inlined here
 * to keep the composer free of cross-module imports for trivial
 * helpers.
 */
function escapePangoText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paletteSummary(config: FlexIconGridConfig): string {
  if (config.palette.type === 'preset') return `preset:${config.palette.name}`;
  return `custom:${config.palette.colors.length}`;
}

/** Re-exports used by the render route + tests. */
export { computeGridLayout, resolveCellBackgrounds, WHITE };
