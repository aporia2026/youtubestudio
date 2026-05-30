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
  computeShadowFilterRegion,
  escapeSvgText,
  getConsumedCellIndexes,
  resolveCellShadow,
  resolveCellStroke,
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
  type ShadowStyle,
} from './flex-icon-grid';
import { inlineIconSvg } from './flex-icon-grid-icons';
import { pickLabelColourFor, resolveCellBackgrounds } from './flex-icon-grid-palettes';
import { fetchTwemojiSvg } from './flex-icon-grid-emoji';
import { fetchFontBytesCached } from './flex-icon-grid-font-cache';

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
  /** URLs that failed to fetch this render. Surfaced through the
   *  compose result so the API can return them to the panel as
   *  "font no longer available" warnings (Phase 4.7 caveat fix). */
  readonly warnings: string[];
  cleanup(): Promise<void>;
}

function makeCustomFontResolver(fetcher: UploadFetcher): CustomFontResolver {
  // Per-render cache of `{ url → { family, tempPath } }`. The BYTE
  // cache (cross-render, module-level) lives in
  // `flex-icon-grid-font-cache.ts` — this Map only memoises the
  // current render's temp-file writes so two cells referencing the
  // same custom font share one temp file.
  const cache = new Map<string, { family: string; path: string }>();
  const tempFiles: string[] = [];
  const warnings: string[] = [];
  return {
    warnings,
    async resolve(url: string) {
      if (cache.has(url)) return cache.get(url)!;
      let bytes: Buffer;
      try {
        // Read through the module-level byte cache — same URL across
        // renders within the same Lambda instance reuses the bytes
        // and skips the network fetch.
        bytes = await fetchFontBytesCached(url, fetcher);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn('[flex-icon-grid composer] custom font fetch failed', {
          url_prefix: url.slice(0, 60),
          reason,
        });
        warnings.push(url);
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
/**
 * Compose result.
 *  - `buffer`: the rendered PNG ready to upload to R2.
 *  - `fontWarnings`: unique URLs whose custom-font fetch failed this
 *    render. Phase 4.7 caveat fix — the render route returns these
 *    so the panel can show "font no longer available" badges per
 *    affected cell instead of silently falling back to Anton.
 */
export interface ComposeResult {
  buffer: Buffer;
  fontWarnings: string[];
}

export async function composeFlexIconGrid(input: ComposeInput): Promise<ComposeResult> {
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
      const titleOverlays = await buildTitleBarOverlay(config, fontResolver);
      if (titleOverlays) overlays.push(...titleOverlays);
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
  // Dedupe warning URLs — a single broken URL referenced by multiple
  // cells should surface once, not N times.
  const fontWarnings = Array.from(new Set(fontResolver.warnings));
  if (fontWarnings.length > 0) {
    console.warn('[flex-icon-grid composer] font warnings', {
      count: fontWarnings.length,
      url_prefixes: fontWarnings.map((u) => u.slice(0, 60)),
    });
  }
  return { buffer: finalBuffer, fontWarnings };
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
  const cellShadows: (ShadowStyle | null)[] = [];
  for (const cell of renderableCells) {
    const resolvedBg = resolveCellBackground(cell, backgrounds[cell.index - 1] ?? '#0a0a0a');
    const { fill, defs } = emitCellBackgroundFill(resolvedBg, cell.index);
    if (defs) cellDefs.push(defs);
    cellBgFills.push(fill);
    // Phase 4.11: collect each cell's resolved shadow so we can emit
    // one <filter> per shadowed cell. Cells without a shadow skip the
    // filter entirely so the existing flat-cell SVG is byte-identical.
    // Phase 4.13: pass the cell's shape size to the filter region
    // helper so percentage math is exact across grid sizes.
    const resolvedShadow = resolveCellShadow(cell, config);
    cellShadows.push(resolvedShadow);
    if (resolvedShadow) {
      const cellRectForShadow = computeCellRect(layout, cell.index, cell.cellSpan);
      const cellLabelStyle = resolveLabelStyle(cell, config);
      const cellGeomForShadow = computeCellGeometry(
        cellRectForShadow.x, cellRectForShadow.y,
        cellRectForShadow.w, cellRectForShadow.h,
        cellLabelStyle.position,
      );
      cellDefs.push(emitShadowFilterDef(resolvedShadow, cell.index, cellGeomForShadow.shapeW));
    }
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
    // Phase 4.30: outer cell stroke. Painted AFTER the background
    // fill so the stroke sits on top of the fill but underneath
    // the shape + content. Inset by half the thickness so the
    // stroke renders inside the cell rectangle instead of
    // overflowing into the neighbouring cell.
    const cellStroke = resolveCellStroke(cell, config);
    if (cellStroke && cellStroke.thickness > 0) {
      const inset = cellStroke.thickness / 2;
      parts.push(
        `<rect x="${rect.x + inset}" y="${rect.y + inset}" width="${rect.w - cellStroke.thickness}" height="${rect.h - cellStroke.thickness}" fill="none" stroke="${escapeSvgText(cellStroke.color)}" stroke-width="${cellStroke.thickness}"/>`,
      );
    }
    const shape = cell.shape ?? config.defaultCellShape;
    const ring = resolveRing(cell, config);
    const labelStyle = resolveLabelStyle(cell, config);
    const geom = computeCellGeometry(rect.x, rect.y, rect.w, rect.h, labelStyle.position);
    const shadowFilterId = cellShadows[i] ? `fg-cell-shadow-${cell.index}` : null;
    // Phase 4.16 → 4.19: wrap the shape (and inline icon) in a
    // transform group when the cell carries rotation OR flipX/flipY.
    // Rotation is applied AFTER the flip so the user's "rotate 45°"
    // intuition holds — flips swap axes, then the result is rotated.
    // The wrapping group's pivot is the shape's geometric centre so
    // both transforms compose around the same point. Label band is
    // OUTSIDE the wrap so it stays upright + readable.
    const rotation = cell.rotation ?? 0;
    const flipX = cell.flipX === true;
    const flipY = cell.flipY === true;
    const needsTransform = rotation !== 0 || flipX || flipY;
    if (needsTransform) {
      const cx = geom.shapeX + geom.shapeW / 2;
      const cy = geom.shapeY + geom.shapeH / 2;
      // SVG transform list applies right-to-left. To get
      // "rotate then scale around the shape centre" we translate to
      // origin, scale, rotate, translate back. Coalesce to a single
      // matrix-equivalent transform string so the emitted SVG stays
      // compact.
      const sx = flipX ? -1 : 1;
      const sy = flipY ? -1 : 1;
      parts.push(
        `<g transform="translate(${cx} ${cy}) rotate(${rotation}) scale(${sx} ${sy}) translate(${-cx} ${-cy})">`,
      );
    }
    parts.push(renderCellShape(geom, shape, referenceColour, config.cornerRadius, ring, shadowFilterId));
    // Inline Lucide icon — done in the base SVG so we get crisp
    // vector at any output resolution. Other content types render
    // as text/image overlays after rasterisation (separate pass).
    if (cell.content.type === 'icon-library') {
      parts.push(renderIconLibrary(cell.content, geom, referenceColour, ring));
    }
    if (needsTransform) {
      parts.push(`</g>`);
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
  // Phase 4.33: overlay-top + overlay-bottom render at the same y
  // as their non-overlay counterparts; the difference is only at
  // the layout level (overlay positions don't displace the grid).
  const isTopPos = titleBar.position === 'top' || titleBar.position === 'overlay-top';
  const y = isTopPos ? 0 : height - titleBar.height;
  // Phase 4.28 → 4.29: resolve the bar fill — transparent (when
  // set) beats gradient beats solid. Transparent renders the rect
  // with `fill="none"` (or skipped entirely when there's also no
  // shadow). Gradient emits a `<defs>` entry with a stable id;
  // solid uses the hex directly.
  const gradient = titleBar.backgroundGradient;
  const isTransparent = titleBar.backgroundTransparent === true;
  let fillExpr: string;
  let extraDef = '';
  if (isTransparent) {
    fillExpr = 'none';
  } else if (gradient) {
    const gradId = 'fg-title-bar-bg';
    extraDef =
      `<linearGradient id="${gradId}" gradientTransform="rotate(${gradient.angle} 0.5 0.5)">` +
      `<stop offset="0%" stop-color="${escapeSvgText(gradient.from)}"/>` +
      `<stop offset="100%" stop-color="${escapeSvgText(gradient.to)}"/>` +
      `</linearGradient>`;
    fillExpr = `url(#${gradId})`;
  } else {
    fillExpr = escapeSvgText(titleBar.background);
  }
  // Phase 4.27 → 4.28: optional drop shadow under the bar
  // rectangle. Uses the same SVG `<filter>` pattern as per-cell
  // shadows, with the bar HEIGHT (not width) as the shape-size hint
  // for accurate region clamping — a 12 px blur over a 96 px-tall
  // bar reads similarly to a 12 px blur over a 96 px cell, while
  // using the canvas width (1280 px) would have collapsed the
  // shadow to near-invisibility.
  //
  // Phase 4.28 also flips the offsetY direction for bottom bars so
  // the shadow always casts AWAY from the canvas edge — top bar
  // shadows downward into the cells; bottom bar shadows upward
  // into the cells. The UI control stays "positive = stronger
  // shadow"; the renderer handles direction implicitly.
  // Phase 4.29: skip the shadow filter when the bar is transparent —
  // there's no fill to cast a shadow from. The text overlay paints
  // on its own pass and doesn't get a bar-level shadow either.
  if (titleBar.shadow && !isTransparent) {
    const filterId = 'fg-title-bar-shadow';
    // Phase 4.33: bottom-style positions (regular + overlay) flip
    // the shadow direction so it casts away from the canvas edge.
    const isBottomPos =
      titleBar.position === 'bottom' || titleBar.position === 'overlay-bottom';
    const directedShadow: NonNullable<ShadowStyle> = {
      ...titleBar.shadow,
      offsetY: isBottomPos
        ? -Math.abs(titleBar.shadow.offsetY)
        : Math.abs(titleBar.shadow.offsetY),
    };
    const filterDef = emitShadowFilterDef(directedShadow, -1, titleBar.height);
    // Override the auto-generated cellIndex-based id since this is
    // the bar, not a cell. Replace the emitted id to point at our
    // stable name.
    const def = filterDef.replace('fg-cell-shadow--1', filterId);
    return [
      `<defs>${extraDef}${def}</defs>`,
      `<rect x="0" y="${y}" width="${width}" height="${titleBar.height}" fill="${fillExpr}" filter="url(#${filterId})"/>`,
    ].join('');
  }
  const defs = extraDef ? `<defs>${extraDef}</defs>` : '';
  return `${defs}<rect x="0" y="${y}" width="${width}" height="${titleBar.height}" fill="${fillExpr}"/>`;
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
  shadowFilterId: string | null,
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
  // Phase 4.11: shadow is applied via an SVG <filter> defined in the
  // canvas-level <defs>. Empty string when the cell has no shadow so
  // existing thumbnails render byte-identical.
  const shadowAttr = shadowFilterId ? ` filter="url(#${shadowFilterId})"` : '';
  // Shape fill: the icon ring's inner area gets a near-white
  // background so the embedded Lucide icon reads against it (the
  // reference look — icons sit in an off-white disc on the bright
  // cell). When the user has uploaded an image or chosen text-only,
  // the overlay pass paints on top of this fill anyway.
  const shapeFill = '#fbfbf8';
  if (shape === 'circle') {
    const r = geom.shapeW / 2;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${shapeFill}"${ringAttrs}${shadowAttr}/>`;
  }
  if (shape === 'rounded-square') {
    const rx = Math.min(cornerRadius, geom.shapeW / 4);
    return `<rect x="${geom.shapeX}" y="${geom.shapeY}" width="${geom.shapeW}" height="${geom.shapeH}" rx="${rx}" ry="${rx}" fill="${shapeFill}"${ringAttrs}${shadowAttr}/>`;
  }
  if (shape === 'hexagon') {
    const points = hexagonPoints(cx, cy, geom.shapeW);
    return `<polygon points="${points}" fill="${shapeFill}"${ringAttrs}${shadowAttr}/>`;
  }
  if (shape === 'pill') {
    const pw = geom.shapeW * 0.55;
    const ph = geom.shapeH;
    const px = cx - pw / 2;
    const py = cy - ph / 2;
    const pr = pw / 2;
    return `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="${pr}" ry="${pr}" fill="${shapeFill}"${ringAttrs}${shadowAttr}/>`;
  }
  if (shape === 'capsule') {
    const cw = geom.shapeW;
    const ch = geom.shapeH * 0.55;
    const cxr = cx - cw / 2;
    const cyr = cy - ch / 2;
    const cr = ch / 2;
    return `<rect x="${cxr}" y="${cyr}" width="${cw}" height="${ch}" rx="${cr}" ry="${cr}" fill="${shapeFill}"${ringAttrs}${shadowAttr}/>`;
  }
  // square
  return `<rect x="${geom.shapeX}" y="${geom.shapeY}" width="${geom.shapeW}" height="${geom.shapeH}" fill="${shapeFill}"${ringAttrs}${shadowAttr}/>`;
}

/**
 * Phase 4.11: emit an SVG <filter> definition that produces a drop
 * shadow with the given offset, blur, colour and opacity. Returned
 * as a fragment to inline into the canvas-level <defs> block. The
 * SourceGraphic is overlaid on top of the offset shadow so the
 * shape itself stays crisp — only the shadow halo is blurred.
 *
 * Phase 4.12: the filter region is now derived from the shadow's
 * own offsetY + blur so big shadows don't get clipped. We pad the
 * box by `2 * blur + |offsetY|` on each axis, then express it as a
 * percentage that scales with the filtered element's bounding box.
 * Floored at the prior fixed `-25%/150%` so even shadowless edges
 * still match the Phase-4.11 default region.
 */
function emitShadowFilterDef(
  shadow: NonNullable<ShadowStyle>,
  cellIndex: number,
  shapeSize: number,
): string {
  const region = computeShadowFilterRegion(shadow, shapeSize);
  const id = `fg-cell-shadow-${cellIndex}`;
  return [
    `<filter id="${id}" x="${region.x}%" y="${region.y}%" width="${region.w}%" height="${region.h}%">`,
    `<feGaussianBlur in="SourceAlpha" stdDeviation="${shadow.blur}"/>`,
    `<feOffset dx="0" dy="${shadow.offsetY}" result="offsetblur"/>`,
    `<feFlood flood-color="${escapeSvgText(shadow.color)}" flood-opacity="${shadow.opacity}"/>`,
    `<feComposite in2="offsetblur" operator="in"/>`,
    `<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>`,
    `</filter>`,
  ].join('');
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
  // Phase 4.16: cell rotation applies to the shape (already rotated
  // in the base SVG) AND to content overlays that fill the shape
  // area (upload / emoji / sticker / text-only). Label and badge
  // overlays stay un-rotated so multi-cell grids stay readable.
  const rotation = cell.rotation ?? 0;
  const shapeCx = geom.shapeX + geom.shapeW / 2;
  const shapeCy = geom.shapeY + geom.shapeH / 2;

  const overlays: sharp.OverlayOptions[] = [];

  // Phase 4.19: per-cell flip flags applied alongside rotation so the
  // overlay content matches the SVG shape's transform exactly. Flips
  // happen FIRST (in the same way as the SVG transform) so the user's
  // "flip then rotate 45°" intuition holds.
  const flipX = cell.flipX === true;
  const flipY = cell.flipY === true;

  // Content overlays
  if (cell.content.type === 'upload') {
    const uploadOverlay = await buildUploadOverlay(cell.content.url, geom, shape, ring, config.cornerRadius, fetchUpload, cell.index);
    if (uploadOverlay) overlays.push(await maybeTransformOverlay(uploadOverlay, rotation, flipX, flipY, shapeCx, shapeCy));
  } else if (cell.content.type === 'ai-sticker' && cell.content.url) {
    // Generated stickers paint exactly like uploads — the URL points
    // at the sliced quadrant the generate-stickers route uploaded to
    // R2. When the sticker has not yet been generated (`url` empty)
    // the cell falls through to its shape fill (handled by the base
    // SVG) — visible as an empty disc the user can click to generate.
    const stickerOverlay = await buildUploadOverlay(cell.content.url, geom, shape, ring, config.cornerRadius, fetchUpload, cell.index);
    if (stickerOverlay) overlays.push(await maybeTransformOverlay(stickerOverlay, rotation, flipX, flipY, shapeCx, shapeCy));
  } else if (cell.content.type === 'emoji') {
    const emojiOverlay = await buildEmojiOverlay(cell.content.char, geom);
    if (emojiOverlay) overlays.push(await maybeTransformOverlay(emojiOverlay, rotation, flipX, flipY, shapeCx, shapeCy));
  } else if (cell.content.type === 'text-only') {
    const textOverlay = await buildTextOnlyOverlay(cell.label, geom, labelStyle, background, fontResolver, defaultFallbackFont(config));
    if (textOverlay) overlays.push(await maybeTransformOverlay(textOverlay, rotation, flipX, flipY, shapeCx, shapeCy));
  }
  // `icon-library` already painted into the base SVG — no overlay
  // needed.

  // Label overlay (skip when overlap with text-only mode, which
  // already prints the label as its content).
  if (labelStyle.position !== 'hidden' && cell.content.type !== 'text-only') {
    const labelOverlay = await buildLabelOverlay(cell.label, geom, labelStyle, background, cell.content.type === 'upload', shape, fontResolver, defaultFallbackFont(config));
    if (labelOverlay) overlays.push(labelOverlay);
  }

  // Phase 4.12: corner badge — small pill in a configured cell corner.
  // Rendered after the label so it always sits on top (typical use:
  // numeric rank stickers that need to read above everything else).
  if (cell.badge) {
    const badgeOverlay = await buildBadgeOverlay(cell.badge, rect, fontResolver);
    if (badgeOverlay) overlays.push(badgeOverlay);
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
  // Phase 4.32: apply the optional label text shadow BEFORE the
  // band-fit clamp so the clamp considers the shadow halo too.
  // Mirrors the title text shadow pipeline in
  // `wrapTextWithShadow` for visual + behavioural consistency.
  if (labelStyle.textShadow) {
    buf = await wrapTextWithShadow(buf, labelStyle.textShadow);
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

/** Phase 4.33: LRU-ish cache for alpha-mask uniform RGBA buffers
 *  used inside `wrapTextWithShadow`. Keyed on `${w}x${h}@${opacity}`.
 *  Bounded so a thumbnail with many shadowed labels doesn't grow
 *  the cache without limit; evicts the oldest entry when full.
 *  Sharp's `create` is cheap but not free — caching halves the cost
 *  for repeated identical shadows (the common case where every
 *  cell label shares the canvas-level default shadow). */
const ALPHA_MASK_CACHE = new Map<string, Buffer>();
const ALPHA_MASK_CACHE_MAX = 64;

async function getAlphaMaskBuffer(w: number, h: number, opacity: number): Promise<Buffer> {
  const key = `${w}x${h}@${opacity}`;
  const hit = ALPHA_MASK_CACHE.get(key);
  if (hit) {
    // Refresh insertion order so eviction is LRU.
    ALPHA_MASK_CACHE.delete(key);
    ALPHA_MASK_CACHE.set(key, hit);
    return hit;
  }
  const buf = await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: opacity },
    },
  })
    .png()
    .toBuffer();
  ALPHA_MASK_CACHE.set(key, buf);
  if (ALPHA_MASK_CACHE.size > ALPHA_MASK_CACHE_MAX) {
    const oldest = ALPHA_MASK_CACHE.keys().next().value;
    if (oldest !== undefined) ALPHA_MASK_CACHE.delete(oldest);
  }
  return buf;
}

/**
 * Phase 4.31 → 4.33: wrap a tinted text buffer with an optional drop
 * shadow. The shadow is built by cloning the source, recolouring it
 * with the shadow colour, scaling its alpha by `shadow.opacity`,
 * blurring it, and then compositing the original text on top with
 * the requested `offsetY`. Output buffer is sized to fit BOTH the
 * shadow halo + the main text so the returned size is correct for
 * downstream centring.
 *
 * Phase 4.33 — the alpha-mask buffer is cached per (w, h, opacity)
 * via `getAlphaMaskBuffer`; subsequent renders with the same
 * dimensions reuse the cached mask. No-op when `shadow` is
 * null/undefined.
 */
async function wrapTextWithShadow(
  textBuf: Buffer,
  shadow: NonNullable<ShadowStyle> | null | undefined,
): Promise<Buffer> {
  if (!shadow) return textBuf;
  const meta = await sharp(textBuf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0) return textBuf;

  // Pad the canvas so blur + offset don't get clipped.
  const padX = Math.ceil(2 * shadow.blur);
  const padY = Math.ceil(2 * shadow.blur + Math.abs(shadow.offsetY));
  const outW = w + 2 * padX;
  const outH = h + 2 * padY;

  // Build the shadow layer: recolour + alpha-scale + blur.
  let shadowBuf = await tintPngTo(textBuf, shadow.color);
  // Phase 4.31 → 4.32 → 4.33: scale the alpha by the requested
  // opacity via a `dest-in` composite. Phase 4.33 — the uniform RGBA
  // alpha mask is now cached by `getAlphaMaskBuffer`, so repeated
  // shadows with the same dimensions skip the create+png pipeline.
  const alphaMask = await getAlphaMaskBuffer(w, h, shadow.opacity);
  shadowBuf = await sharp(shadowBuf)
    .composite([{ input: alphaMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  if (shadow.blur > 0) {
    shadowBuf = await sharp(shadowBuf).blur(shadow.blur).png().toBuffer();
  }

  // Composite shadow (offset) + main text (no offset) onto a
  // transparent canvas sized to fit both.
  const composed = await sharp({
    create: {
      width: outW,
      height: outH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: shadowBuf,
        top: padY + shadow.offsetY,
        left: padX,
      },
      {
        input: textBuf,
        top: padY,
        left: padX,
      },
    ])
    .png()
    .toBuffer();

  return composed;
}

// ─── Title bar overlay ──────────────────────────────────────────────────────

async function buildTitleBarOverlay(
  config: FlexIconGridConfig,
  fontResolver: CustomFontResolver,
): Promise<sharp.OverlayOptions[] | null> {
  const { titleBar, width, height } = config;
  if (!titleBar) return null;
  const text = sanitizeUserText(titleBar.text, 80);
  if (!text) return null;
  // Title bar carries its own font + (Phase 4.9a) its own custom-
  // font URL. Wrap in a minimal label-style envelope so
  // `resolveLabelFont` can dispatch uniformly with the per-cell path.
  const minimalStyle: LabelStyle = {
    position: 'below',
    font: titleBar.font,
    case: 'as-typed',
    color: titleBar.color,
    stroke: null,
    maxLines: 1,
    customFontUrl: titleBar.customFontUrl,
    customFontLabel: titleBar.customFontLabel,
  };
  const fallbackFont: Exclude<LabelFont, 'custom'> =
    titleBar.font === 'custom' ? 'anton' : titleBar.font;
  const font = await resolveLabelFont(minimalStyle, fontResolver, fallbackFont);
  // Title bar text horizontal safe area. Phase 4.11.1 — bumped from
  // 94 % of canvas width to a 12 % total horizontal margin (6 % per
  // side, with a 32 px floor on smaller canvases) so long titles
  // don't kiss the bar edges. Lines that fit inside this area pass
  // through unchanged; lines wider than the safe area get scaled to
  // fit via the post-render resize step below — same belt-and-braces
  // pattern the cell-label renderer uses.
  const titleSideMargin = Math.max(32, Math.round(width * 0.06));
  const maxRenderedW = Math.max(16, width - 2 * titleSideMargin);
  const safeW = maxRenderedW;
  // Phase 4.10: when a subtitle is present, the main line shrinks to
  // ~45% of bar height (was 55%) to leave a ~22% strip for the
  // subtitle below it, plus breathing room. Without a subtitle, the
  // main line keeps its original ~55% so existing thumbnails render
  // pixel-identical.
  const subtitleText = titleBar.subtitle
    ? sanitizeUserText(titleBar.subtitle, 80)
    : '';
  const hasSubtitle = subtitleText.length > 0;
  const mainSizePx = Math.max(16, Math.round(titleBar.height * (hasSubtitle ? 0.45 : 0.55)));
  let mainBuf = await sharp({
    text: {
      text: escapePangoText(text),
      fontfile: font.path,
      font: `${font.family} ${mainSizePx}`,
      rgba: true,
      width: safeW,
      align: 'centre',
      wrap: 'none',
    },
  })
    .png()
    .toBuffer();
  mainBuf = await tintPngTo(mainBuf, titleBar.color);
  // Phase 4.31: apply the optional title-text drop shadow BEFORE the
  // safe-area clamp so the clamp considers the shadow halo too.
  if (titleBar.textShadow) {
    mainBuf = await wrapTextWithShadow(mainBuf, titleBar.textShadow);
  }
  let mainMeta = await sharp(mainBuf).metadata();
  let mainBw = mainMeta.width ?? safeW;
  let mainBh = mainMeta.height ?? mainSizePx;
  // Phase 4.11.1: if Pango's natural render width exceeds the safe
  // area (long title, large font, narrow canvas), scale the buffer
  // to fit. `fit: 'inside'` preserves aspect so the text shrinks
  // proportionally rather than getting squashed.
  if (mainBw > maxRenderedW) {
    mainBuf = await sharp(mainBuf)
      .resize({ width: maxRenderedW, fit: 'inside' })
      .png()
      .toBuffer();
    mainMeta = await sharp(mainBuf).metadata();
    mainBw = mainMeta.width ?? maxRenderedW;
    mainBh = mainMeta.height ?? mainBh;
  }

  // Vertical layout
  //  - bar top in canvas-y: barTop
  //  - main centered vertically when there's no subtitle
  //  - main shifted up + subtitle below it when there is one
  // Phase 4.33: same overlay handling as the background.
  const barTop =
    titleBar.position === 'top' || titleBar.position === 'overlay-top'
      ? 0
      : height - titleBar.height;
  const overlays: sharp.OverlayOptions[] = [];

  // Phase 4.29 → 4.30: horizontal alignment. `center` (default)
  // keeps the pre-4.29 placement; `left` and `right` snap to the
  // safe-area edges. Phase 4.30 — `subtitleTextAlign` lets the
  // subtitle anchor independently (falls back to `textAlign`).
  const alignLeft = (align: 'left' | 'center' | 'right' | undefined, bw: number): number => {
    if (align === 'left') return titleSideMargin;
    if (align === 'right') return width - titleSideMargin - bw;
    return Math.round((width - bw) / 2);
  };
  const mainAlign = titleBar.textAlign;
  const subAlign = titleBar.subtitleTextAlign ?? titleBar.textAlign;

  if (!hasSubtitle) {
    const top = Math.round(barTop + (titleBar.height - mainBh) / 2);
    overlays.push({ input: mainBuf, top, left: Math.round(alignLeft(mainAlign, mainBw)) });
    return overlays;
  }

  // With subtitle: pre-render subtitle so we know its height, then
  // stack both centered around the bar's vertical middle. Phase 4.11
  // — subtitle can now use an independent font; falls back to the
  // main title's resolved font when `subtitleFont` is absent so
  // existing single-font subtitles keep working unchanged.
  const subSizePx = Math.max(12, Math.round(titleBar.height * 0.22));
  let subFont = font;
  if (titleBar.subtitleFont) {
    const subStyle: LabelStyle = {
      position: 'below',
      font: titleBar.subtitleFont,
      case: 'as-typed',
      color: titleBar.subtitleColor ?? titleBar.color,
      stroke: null,
      maxLines: 1,
      customFontUrl: titleBar.subtitleCustomFontUrl,
      customFontLabel: titleBar.subtitleCustomFontLabel,
    };
    const subFallback: Exclude<LabelFont, 'custom'> =
      titleBar.subtitleFont === 'custom' ? 'anton' : titleBar.subtitleFont;
    subFont = await resolveLabelFont(subStyle, fontResolver, subFallback);
  }
  let subBuf = await sharp({
    text: {
      text: escapePangoText(subtitleText),
      fontfile: subFont.path,
      font: `${subFont.family} ${subSizePx}`,
      rgba: true,
      width: safeW,
      align: 'centre',
      wrap: 'none',
    },
  })
    .png()
    .toBuffer();
  const subColor = titleBar.subtitleColor ?? titleBar.color;
  subBuf = await tintPngTo(subBuf, subColor);
  // Phase 4.31 → 4.32: subtitle resolves its own text shadow with
  // tristate cascade — explicit subtitleTextShadow wins; explicit
  // `null` opts out (no shadow even when main has one); undefined
  // inherits the main `textShadow`.
  const subShadow: NonNullable<ShadowStyle> | null =
    titleBar.subtitleTextShadow === null
      ? null
      : titleBar.subtitleTextShadow ?? titleBar.textShadow ?? null;
  if (subShadow) {
    subBuf = await wrapTextWithShadow(subBuf, subShadow);
  }
  let subMeta = await sharp(subBuf).metadata();
  let subBw = subMeta.width ?? safeW;
  let subBh = subMeta.height ?? subSizePx;
  // Phase 4.11.1: subtitle gets the same safe-area clamp as the main
  // line so a verbose secondary headline can't outgrow the safe area
  // while the main title sits well within it.
  if (subBw > maxRenderedW) {
    subBuf = await sharp(subBuf)
      .resize({ width: maxRenderedW, fit: 'inside' })
      .png()
      .toBuffer();
    subMeta = await sharp(subBuf).metadata();
    subBw = subMeta.width ?? maxRenderedW;
    subBh = subMeta.height ?? subBh;
  }

  // Gap between the two lines; small fraction of bar height keeps
  // the two lines visually paired without colliding.
  const lineGap = Math.round(titleBar.height * 0.05);
  const stackH = mainBh + lineGap + subBh;
  const stackTop = Math.round(barTop + (titleBar.height - stackH) / 2);

  overlays.push({
    input: mainBuf,
    top: stackTop,
    left: Math.round(alignLeft(mainAlign, mainBw)),
  });
  overlays.push({
    input: subBuf,
    top: stackTop + mainBh + lineGap,
    left: Math.round(alignLeft(subAlign, subBw)),
  });
  return overlays;
}

// ─── Overlay rotation helper (Phase 4.16) ───────────────────────────────────

/**
 * Phase 4.16: rotate a content overlay around a canvas-space pivot
 * (typically the shape centre). Sharp's `.rotate(angle)` rotates the
 * image around ITS OWN centre and expands the bounding box to fit,
 * so after rotation we re-position the overlay so its new centre
 * lands at the original pivot point.
 *
 * No-op when `degrees` is exactly 0 — overlays unchanged.
 */
async function maybeTransformOverlay(
  overlay: sharp.OverlayOptions,
  degrees: number,
  flipX: boolean,
  flipY: boolean,
  pivotX: number,
  pivotY: number,
): Promise<sharp.OverlayOptions> {
  // Phase 4.19: extended from the Phase-4.16 rotation-only helper to
  // also handle flipX/flipY. Sharp's `.flop()` is horizontal mirror,
  // `.flip()` is vertical mirror. Apply flips BEFORE rotation so the
  // overlay matches the SVG shape's `scale → rotate` order around
  // the shape pivot.
  if (degrees === 0 && !flipX && !flipY) return overlay;
  const inputBuf = overlay.input as Buffer;
  if (!Buffer.isBuffer(inputBuf)) return overlay;
  // Capture the original overlay's centre before rotation so we can
  // re-place the rotated buffer over the same pivot.
  const origTop = overlay.top ?? 0;
  const origLeft = overlay.left ?? 0;
  const origMeta = await sharp(inputBuf).metadata();
  const origCx = origLeft + (origMeta.width ?? 0) / 2;
  const origCy = origTop + (origMeta.height ?? 0) / 2;
  // Phase 4.19: chain flips before rotation. Sharp's `.flip()` is
  // vertical (mirror top↔bottom); `.flop()` is horizontal (mirror
  // left↔right). The Sharp pipeline is lazy until `.toBuffer()` so
  // chaining is cheap.
  let pipeline = sharp(inputBuf);
  if (flipY) pipeline = pipeline.flip();
  if (flipX) pipeline = pipeline.flop();
  if (degrees !== 0) {
    pipeline = pipeline.rotate(degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  const rotated = await pipeline.png().toBuffer();
  const rotatedMeta = await sharp(rotated).metadata();
  const newW = rotatedMeta.width ?? origMeta.width ?? 0;
  const newH = rotatedMeta.height ?? origMeta.height ?? 0;
  // Phase 4.17: rotate the (orig centre → pivot) offset vector by
  // the same angle so an off-pivot overlay's content rotates AROUND
  // the pivot while keeping its relative offset. The new centre
  // lands at `pivot + R(angle) * (origCentre - pivot)`.
  //
  // For an on-pivot overlay (origCx ≈ pivotX, origCy ≈ pivotY) the
  // offset vector is zero and the new centre stays exactly on the
  // pivot — byte-identical to Phase 4.16 for the common case.
  // For an off-pivot overlay (text-only positioned slightly low),
  // the content orbits around the pivot instead of snapping to it.
  const dx = origCx - pivotX;
  const dy = origCy - pivotY;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Standard 2D rotation matrix; SVG uses CW-positive degrees so we
  // mirror that here (sin's sign matches the SVG `rotate(N)` convention).
  const newCx = pivotX + dx * cos - dy * sin;
  const newCy = pivotY + dx * sin + dy * cos;
  return {
    input: rotated,
    top: Math.round(newCy - newH / 2),
    left: Math.round(newCx - newW / 2),
  };
}

// ─── Badge overlay (Phase 4.12) ─────────────────────────────────────────────

/**
 * Phase 4.12: render a corner-badge pill. Pipeline:
 *   1. Resolve the bundled Anton font (chunky, reads well at small
 *      sizes; badges are always short uppercase labels).
 *   2. Render the badge text via Sharp's Pango integration so we can
 *      precisely measure the rendered width before deciding the pill
 *      dimensions.
 *   3. Build a rounded-pill SVG matching the text width + horizontal
 *      padding, rasterise it to PNG.
 *   4. Composite the text on top of the pill.
 *   5. Position the composed pill at the configured cell corner with
 *      a small inset so it doesn't kiss the cell edge.
 *
 * Custom fonts are NOT supported here — badges are deliberately
 * uniform across the grid (the typical "1 2 3 4" rank treatment).
 * If a future request needs branded badge text we can revisit.
 */
async function buildBadgeOverlay(
  badge: {
    text: string;
    corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    background: string;
    color: string;
    font?: LabelFont;
    customFontUrl?: string;
    customFontLabel?: string;
  },
  cellRect: { x: number; y: number; w: number; h: number },
  fontResolver: CustomFontResolver,
): Promise<sharp.OverlayOptions | null> {
  const text = sanitizeUserText(badge.text, 8);
  if (!text) return null;

  // Sizing relative to the cell — keeps badges legible across grid
  // densities (a 6×6 grid still gets ≥24 px pill height).
  const cellMin = Math.min(cellRect.w, cellRect.h);
  const pillH = Math.max(24, Math.round(cellMin * 0.16));
  const fontSize = Math.round(pillH * 0.6);
  const padX = Math.round(pillH * 0.5);
  const inset = Math.max(6, Math.round(cellMin * 0.03));

  // Phase 4.13: badge font is optional. Anton is the default —
  // chunky, reads at small sizes; ideal for short rank/status
  // badges — but a workspace custom font lets a brand-aware badge
  // match the thumbnail's overall typography.
  const badgeFont: LabelFont = badge.font ?? 'anton';
  const fontStyle: LabelStyle = {
    position: 'below',
    font: badgeFont,
    case: 'upper',
    color: badge.color,
    stroke: null,
    maxLines: 1,
    customFontUrl: badge.customFontUrl,
    customFontLabel: badge.customFontLabel,
  };
  const fontFallback: Exclude<LabelFont, 'custom'> =
    badgeFont === 'custom' ? 'anton' : badgeFont;
  const font = await resolveLabelFont(fontStyle, fontResolver, fontFallback);

  // Render text via Pango.
  let textBuf = await sharp({
    text: {
      text: escapePangoText(text.toUpperCase()),
      fontfile: font.path,
      font: `${font.family} ${fontSize}`,
      rgba: true,
      width: Math.max(16, cellRect.w),
      align: 'centre',
      wrap: 'none',
    },
  })
    .png()
    .toBuffer();
  textBuf = await tintPngTo(textBuf, badge.color);
  const textMeta = await sharp(textBuf).metadata();
  const textW = textMeta.width ?? 16;
  const textH = textMeta.height ?? fontSize;

  const pillW = textW + 2 * padX;
  const pillRadius = pillH / 2;

  // Build the pill background as a tiny SVG so Sharp can rasterise it
  // with the right transparent corners.
  const pillSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="${pillH}">` +
    `<rect x="0" y="0" width="${pillW}" height="${pillH}" rx="${pillRadius}" ry="${pillRadius}" fill="${escapeSvgText(badge.background)}"/>` +
    `</svg>`;
  const pillBuf = await sharp(Buffer.from(pillSvg)).png().toBuffer();

  // Composite text centered on the pill.
  const composed = await sharp(pillBuf)
    .composite([
      {
        input: textBuf,
        top: Math.round((pillH - textH) / 2),
        left: Math.round((pillW - textW) / 2),
      },
    ])
    .png()
    .toBuffer();

  // Position at the configured corner with an inset.
  let top: number;
  let left: number;
  if (badge.corner === 'top-left') {
    top = cellRect.y + inset;
    left = cellRect.x + inset;
  } else if (badge.corner === 'top-right') {
    top = cellRect.y + inset;
    left = cellRect.x + cellRect.w - pillW - inset;
  } else if (badge.corner === 'bottom-left') {
    top = cellRect.y + cellRect.h - pillH - inset;
    left = cellRect.x + inset;
  } else {
    top = cellRect.y + cellRect.h - pillH - inset;
    left = cellRect.x + cellRect.w - pillW - inset;
  }
  return { input: composed, top: Math.round(top), left: Math.round(left) };
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
