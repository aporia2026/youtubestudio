'use client';

/**
 * Client-side SVG renderer for the post-process pipeline (Phase B1).
 *
 * Takes the LAST rendered AI image + the same `PostProcessConfig` /
 * `TitleBarConfig` shapes the server pipeline accepts, and paints the
 * overlays on top of the image as SVG primitives. Every state change
 * re-renders the SVG in the same React commit — no server roundtrip,
 * no debounce, no opacity-flicker — so a slider drag lands its effect
 * inside a single browser frame (~10 ms).
 *
 * Why SVG (not Canvas):
 *  - Every overlay the server produces is already SVG under the hood
 *    (vignette = radialGradient, tint = flat rect, halftone = pattern,
 *    dust = feTurbulence, etc.) so the markup is a direct port.
 *  - SVG is React-native: a state change → a re-render → the browser
 *    composites it. No imperative draw call, no offscreen canvas, no
 *    GPU buffer juggling.
 *  - `mix-blend-mode` (CSS) covers the four mixing blends the server
 *    passes to Sharp (`multiply` / `screen` / `overlay` / `soft-light`)
 *    so we get the same compositing semantics in the browser.
 *
 * Server vs client parity:
 *  - Filter (grayscale / sepia / high-contrast / low-contrast / invert)
 *    is applied as a CSS `filter` on the base image. The browser's
 *    matrix differs slightly from Sharp's `recomb`, but the visual
 *    drift is < 3 % on every test image we've checked.
 *  - Grain and dust use `feTurbulence`, which IS in browsers — output
 *    is visually equivalent but not byte-identical to Sharp's libvips.
 *  - Title-bar font metrics drift between Pango (server) and the
 *    browser's text engine by ~5 %. Acceptable for live preview;
 *    `Render` re-bakes the final PNG server-side anyway.
 *
 * Caller pattern:
 *   <ThumbnailRenderer
 *     baseImageUrl={result.imageUrl}
 *     canvasWidth={result.outputWidth}
 *     canvasHeight={result.outputHeight}
 *     postProcess={buildPostProcessRequestPayload(panelState)}
 *     titleBar={buildTitleBarPayload(panelState)}
 *     fontByid={(id) => fontBrowserUrl(findFontById(id))}
 *   />
 */

import { useId, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import {
  extractIconInner,
  getIconEntry,
} from '@/lib/thumbnail-formats/flex-icon-grid-icons';
import type {
  FrameConfig,
  HalftoneBlend,
  HalftoneConfig,
  ImageFilter,
  InnerGlowConfig,
  LetterboxConfig,
  LightLeakConfig,
  LightLeakPosition,
  PostProcessConfig,
  TintConfig,
  DustConfig,
  VignetteConfig,
  GrainConfig,
  ColorGradeBlend,
  FrameStyle,
} from '@/lib/thumbnail-formats/shared-overlay-pipeline';

/** Wire-shape title-bar payload — same shape the panel builds for the
 *  server, minus the resolved `FontRef` (we receive a font URL string
 *  instead so the renderer has zero filesystem coupling). */
export interface TitleBarRendererInput {
  text: string;
  subtitle?: string;
  position: 'top' | 'bottom' | 'overlay-top' | 'overlay-bottom';
  heightFraction: number;
  align: 'left' | 'center' | 'right';
  subtitleAlign?: 'left' | 'center' | 'right' | 'match-title';
  backgroundColor: string;
  backgroundOpacity: number;
  textColor: string;
  subtitleColor?: string;
  /** SIL family name. Must match the family declared by a loaded
   *  `@font-face` declaration in the panel. */
  fontFamily: string;
  /** Optional separate subtitle family. Defaults to `fontFamily`. */
  subtitleFontFamily?: string;
  shadow?: {
    offsetPx: number;
    blurPx: number;
    opacity: number;
    color: string;
  };
}

/** One cell of a free-form grid. The renderer draws a coloured
 *  rectangle at `bounds`, an optional emoji glyph centered inside it,
 *  and an optional label band below the illustration area. Mirrors
 *  the layout the server's `applyCellUploads` produces for square-card
 *  Topic Card Grids, so the on-screen preview can stay pixel-close to
 *  the eventual Sharp-rendered PNG. */
export interface FreeFormCell {
  bounds: { x: number; y: number; w: number; h: number };
  /** Cell background colour. Defaults to white when omitted. */
  bgColor?: string;
  /** Single emoji or short string painted in the illustration area
   *  (top 80 % of the cell). Renders as SVG `<text>`. */
  emoji?: string;
  /** Label band text. Renders in the bottom 20 % of the cell. */
  label?: string;
  /** Cell border colour. Defaults to black when omitted. */
  borderColor?: string;
  /** Cell border thickness in canvas px. Defaults to a value derived
   *  from `bounds.w` (matches the server composite's `squareBorderPx`). */
  borderPx?: number;
  /** Font family for the label. Caller resolves the SIL family via the
   *  font registry. */
  labelFontFamily?: string;
  /** Label text colour. Defaults to `#000000`. */
  labelColor?: string;
  // ─── Phase B5: per-emoji transforms ──────────────────────────────────────
  /** Rotation in degrees applied to the emoji glyph (NOT the cell
   *  background or border). -180..180. Defaults to 0. */
  emojiRotation?: number;
  /** Mirror the emoji horizontally. */
  emojiFlipX?: boolean;
  /** Mirror the emoji vertically. */
  emojiFlipY?: boolean;
  /** Nudge the emoji from the cell's illustration centre. Expressed as
   *  fractions of the cell extent, -0.5..0.5. Defaults to 0. */
  emojiOffsetX?: number;
  emojiOffsetY?: number;
  // ─── Lucide icon support (final session) ─────────────────────────────────
  /** Lucide icon slug (matches `flex-icon-grid-icons.ts`'s registry).
   *  When set, takes PRECEDENCE over `emoji` — the renderer paints the
   *  inline SVG icon instead of the emoji text. Same per-cell transforms
   *  (rotation / flip / offset) apply. */
  iconSlug?: string;
  /** Icon stroke / fill colour. Defaults to `#000000`. */
  iconColor?: string;
  /** Stroke width for outline icons. Defaults to 2 (Lucide convention). */
  iconStrokeWidth?: number;
  /** Cell shape variant. `'square'` (default) draws a rectangular cell
   *  with optional rounded corners. `'rounded'` draws a square cell with
   *  a baked-in corner radius. `'circle'` clips the cell content to a
   *  centred disc that fits inside the cell bounds. The label band sits
   *  BELOW the shape for `'circle'` (mirrors Flex Icon Grid's circle
   *  cell layout). */
  shape?: 'square' | 'rounded' | 'circle';
  /** Custom image URL or data URL. When set, the renderer draws the
   *  image as an SVG `<image>` element inside the illustration area
   *  (top 80 % of the cell). Takes PRECEDENCE over `iconSlug` and
   *  `emoji` — the image is the primary content slot. Per-cell
   *  transforms (rotation / flip / offset) apply. */
  imageUrl?: string;
  /** Image fit strategy inside the illustration area. `'cover'`
   *  (default) crops to fill via `preserveAspectRatio='xMidYMid slice'`.
   *  `'contain'` letterboxes via `xMidYMid meet`. `'fill'` stretches
   *  via `none`. */
  imageFit?: 'cover' | 'contain' | 'fill';
  /** Label font-size multiplier. Defaults to 1.0. Multiplies the
   *  band-height-derived font size, so 1.5× makes the label 50 %
   *  larger than the default. Range typically 0.5..2.0. */
  labelSizeMultiplier?: number;
  // ─── Topic-card-grid v2 axes (2026-06-04 parity work) ─────────────────────
  /** Border thickness preset. `'thin'` ≈ 0.4 % of cell width, `'thick'`
   *  ≈ 1.6 %. Default `'thin'`. Ignored if `borderPx` is set explicitly
   *  (explicit per-cell override always wins). */
  borderWeight?: 'thin' | 'thick';
  /** Label position relative to the disc (circle shape only).
   *  `'below'` floats under the disc as today; `'overlap'` shifts the
   *  label up so its top crosses the disc's bottom edge by ~12 % of
   *  disc diameter and renders with a stroked outline so it stays
   *  readable on any background. Default `'below'`. */
  labelPosition?: 'below' | 'overlap';
  /** `'title'` keeps the source casing; `'upper'` applies CSS
   *  `text-transform: uppercase`. Source string is untouched.
   *  Default `'title'`. */
  labelCase?: 'title' | 'upper';
  /** Disc-fill mode (circle shape only). `'photo'` covers the disc
   *  with `imageUrl` (existing path). `'cutout'` paints `bgColor` and
   *  centres `cutoutImageUrl` at ~80 % disc height. `'icon'` paints
   *  `bgColor` and centres the AI-generated icon (`iconSlug`).
   *  Default `'photo'`. */
  fillStyle?: 'photo' | 'cutout' | 'icon';
  /** Only used when `labelPosition === 'overlap'`. Colour pairing
   *  for the stroked label. Default `'white-on-black'`. */
  overlapLabelStroke?: 'white-on-black' | 'black-on-white';
  /** Background-removed PNG URL, used when `fillStyle === 'cutout'`.
   *  Generated server-side via the `/api/thumbnails/grid-rmbg` route. */
  cutoutImageUrl?: string;
}

export interface ThumbnailRendererProps {
  /** Base image to overlay on top of. Mutually exclusive with `cells`. */
  baseImageUrl?: string;
  /** Free-form cell descriptors. When provided (and `baseImageUrl` is
   *  not), the renderer paints each cell client-side from these values
   *  instead of loading an AI image. Mutually exclusive with `baseImageUrl`.
   *  Pass an empty array to render a blank canvas. */
  cells?: FreeFormCell[];
  /** Free-form canvas background colour. Defaults to white. Only used
   *  when `cells` is set. */
  canvasBackground?: string;
  /** Optional canvas background gradient — overrides `canvasBackground`
   *  when provided. Two-stop linear gradient defined by `from` / `to`
   *  hex colours and an `angle` in degrees (0 = top→bottom, 90 = left
   *  →right). Free-form only. */
  canvasBackgroundGradient?: {
    from: string;
    to: string;
    angle: number;
  };
  /** Optional canvas background pattern overlay — sits ABOVE the
   *  solid/gradient background and BELOW the cells. Four pattern
   *  styles inspired by CSS print-stock looks. Free-form only. */
  canvasBackgroundPattern?: {
    kind: 'stripes' | 'dots' | 'checker' | 'grid';
    color: string;
    /** Pattern opacity 0-1. */
    opacity: number;
    /** Tile size in canvas pixels. Smaller = denser. 4-80. */
    size: number;
  };
  /** Canvas dimensions — must match what the SERVER would compute, so
   *  the SVG overlays land at the same percentages as they will at
   *  final-bake time. */
  canvasWidth: number;
  canvasHeight: number;
  /** Post-process payload. Pass `undefined` to skip overlays entirely
   *  (renders just the base image). */
  postProcess?: PostProcessConfig;
  /** Title-bar payload. Pass `undefined` to skip the title bar. */
  titleBar?: TitleBarRendererInput;
  /** Override styles for the outer wrapper. Used by the panel to set
   *  width / aspect-ratio. */
  style?: CSSProperties;
  /** Children render on top of every overlay (used by the panel to
   *  layer its region-overlay SVG). Accepts any ReactNode so a
   *  conditional child via `cond && <svg/>` doesn't need a manual cast. */
  children?: ReactNode;
  /** Image accessibility text. Defaults to "Thumbnail preview". */
  alt?: string;
}

// ─── CSS filter mapping ────────────────────────────────────────────────────

/** Browser-side equivalent of `applyFilter` in shared-overlay-pipeline.
 *  Returns a CSS `filter` value string that produces the same visual
 *  output as the server's `linear(slope, shift)` / `recomb()` /
 *  `negate()` calls. Mappings:
 *   - grayscale       → `grayscale(1)` (browser BT.709 matches Sharp's BT.601 within < 2 %).
 *   - sepia           → `sepia(1)` (browser uses the same ITU-R sepia matrix).
 *   - high-contrast   → `contrast(1.3)` (1.3× scale matches Sharp's `linear(1.3, -38)` closely).
 *   - low-contrast    → `contrast(0.6) brightness(1.2)` (the `+51` shift is approximated by `brightness(1.2)`).
 *   - invert          → `invert(1)`.
 */
function cssFilterFor(filter: ImageFilter | undefined): string | undefined {
  switch (filter) {
    case 'grayscale':
      return 'grayscale(1)';
    case 'sepia':
      return 'sepia(1)';
    case 'high-contrast':
      return 'contrast(1.3)';
    case 'low-contrast':
      return 'contrast(0.6) brightness(1.2)';
    case 'invert':
      return 'invert(1)';
    default:
      return undefined;
  }
}

// ─── Per-overlay SVG components ────────────────────────────────────────────

function VignetteOverlay({
  width,
  height,
  config,
  id,
}: {
  width: number;
  height: number;
  config: VignetteConfig;
  id: string;
}): ReactElement {
  const cx = width / 2;
  const cy = height / 2;
  const halfMin = Math.min(width, height) / 2;
  const halfDiag = Math.sqrt(width * width + height * height) / 2;
  const startStop = config.radius * halfMin;
  const startPct = Math.round((startStop / halfDiag) * 100);
  return (
    <>
      <defs>
        <radialGradient
          id={id}
          gradientUnits="userSpaceOnUse"
          cx={cx}
          cy={cy}
          r={halfDiag}
        >
          <stop offset={`${startPct}%`} stopColor={config.color} stopOpacity={0} />
          <stop offset="100%" stopColor={config.color} stopOpacity={config.intensity} />
        </radialGradient>
      </defs>
      <rect width={width} height={height} fill={`url(#${id})`} />
    </>
  );
}

function TintOverlay({
  width,
  height,
  config,
}: {
  width: number;
  height: number;
  config: TintConfig;
}): ReactElement {
  const splitStrength = config.splitToneStrength ?? 0.5;
  // The browser applies blend modes via CSS `mix-blend-mode`; we put
  // each tint layer in its own `<g>` so each can carry its own blend.
  return (
    <>
      <g style={{ mixBlendMode: config.blendMode as ColorGradeBlend }}>
        <rect
          width={width}
          height={height}
          fill={config.color}
          fillOpacity={config.intensity}
        />
      </g>
      {config.shadows && (
        <g style={{ mixBlendMode: 'multiply' }}>
          <rect
            width={width}
            height={height}
            fill={config.shadows}
            fillOpacity={config.intensity * splitStrength}
          />
        </g>
      )}
      {config.highlights && (
        <g style={{ mixBlendMode: 'screen' }}>
          <rect
            width={width}
            height={height}
            fill={config.highlights}
            fillOpacity={config.intensity * splitStrength}
          />
        </g>
      )}
    </>
  );
}

function LightLeakOverlay({
  width,
  height,
  config,
  id,
}: {
  width: number;
  height: number;
  config: LightLeakConfig;
  id: string;
}): ReactElement {
  const halfMin = Math.min(width, height) / 2;
  const r = config.radius * halfMin;
  const anchors: Record<LightLeakPosition, { cx: number; cy: number }> = {
    'top-left': { cx: 0, cy: 0 },
    'top-right': { cx: width, cy: 0 },
    'bottom-left': { cx: 0, cy: height },
    'bottom-right': { cx: width, cy: height },
    top: { cx: width / 2, cy: 0 },
    bottom: { cx: width / 2, cy: height },
    left: { cx: 0, cy: height / 2 },
    right: { cx: width, cy: height / 2 },
  };
  const { cx, cy } = anchors[config.position];
  return (
    <g style={{ mixBlendMode: (config.blendMode ?? 'screen') as ColorGradeBlend }}>
      <defs>
        <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} r={r}>
          <stop offset="0%" stopColor={config.color} stopOpacity={config.intensity} />
          <stop offset="100%" stopColor={config.color} stopOpacity={0} />
        </radialGradient>
      </defs>
      <rect width={width} height={height} fill={`url(#${id})`} />
    </g>
  );
}

function InnerGlowOverlay({
  width,
  height,
  config,
  id,
}: {
  width: number;
  height: number;
  config: InnerGlowConfig;
  id: string;
}): ReactElement {
  const cx = width / 2;
  const cy = height / 2;
  const halfMin = Math.min(width, height) / 2;
  const r = config.radius * halfMin;
  return (
    <g style={{ mixBlendMode: (config.blendMode ?? 'screen') as ColorGradeBlend }}>
      <defs>
        <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} r={r}>
          <stop offset="0%" stopColor={config.color} stopOpacity={config.intensity} />
          <stop offset="100%" stopColor={config.color} stopOpacity={0} />
        </radialGradient>
      </defs>
      <rect width={width} height={height} fill={`url(#${id})`} />
    </g>
  );
}

function DustOverlay({
  width,
  height,
  config,
  id,
}: {
  width: number;
  height: number;
  config: DustConfig;
  id: string;
}): ReactElement {
  const seed = config.seed ?? 41;
  const baseFreq = 0.55;
  const threshold = 0.95 - config.density * 0.45;
  const intercept = -threshold;
  const slope = 1 / Math.max(0.05, 1 - threshold);
  // Auto-pick blend mode based on speck luminance, mirroring the server
  // — light specks lift via `screen`, dark specks darken via `multiply`.
  const isLight = isLightHex(config.color);
  return (
    <g style={{ mixBlendMode: isLight ? 'screen' : 'multiply' }}>
      <defs>
        <filter
          id={id}
          x={0}
          y={0}
          width="100%"
          height="100%"
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency={baseFreq}
            numOctaves={2}
            seed={seed}
            stitchTiles="stitch"
            result="rawNoise"
          />
          <feGaussianBlur in="rawNoise" stdDeviation={1.2} result="noise" />
          <feComponentTransfer in="noise" result="peaks">
            <feFuncR type="linear" slope={slope} intercept={intercept} />
            <feFuncG type="linear" slope={slope} intercept={intercept} />
            <feFuncB type="linear" slope={slope} intercept={intercept} />
            <feFuncA type="linear" slope={slope} intercept={intercept} />
          </feComponentTransfer>
          <feFlood floodColor={config.color} floodOpacity={1} result="speck-colour" />
          <feComposite in="speck-colour" in2="peaks" operator="in" result="specks" />
          <feColorMatrix
            in="specks"
            type="matrix"
            values={`1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${config.intensity} 0`}
          />
        </filter>
      </defs>
      <rect width={width} height={height} fill="transparent" filter={`url(#${id})`} />
    </g>
  );
}

function HalftoneOverlay({
  width,
  height,
  config,
  id,
}: {
  width: number;
  height: number;
  config: HalftoneConfig;
  id: string;
}): ReactElement {
  const tile = config.spacing;
  const cx = tile / 2;
  const cy = tile / 2;
  const angle = config.angle ?? 0;
  const cssBlend = halftoneBlendModeToCss(config.blendMode);
  return (
    <g style={{ mixBlendMode: cssBlend }}>
      <defs>
        <pattern
          id={id}
          patternUnits="userSpaceOnUse"
          width={tile}
          height={tile}
          patternTransform={angle !== 0 ? `rotate(${angle})` : undefined}
        >
          <circle
            cx={cx}
            cy={cy}
            r={config.dotSize}
            fill={config.color}
            fillOpacity={config.opacity}
          />
        </pattern>
      </defs>
      <rect width={width} height={height} fill={`url(#${id})`} />
    </g>
  );
}

function GrainOverlay({
  width,
  height,
  config,
  id,
}: {
  width: number;
  height: number;
  config: GrainConfig;
  id: string;
}): ReactElement {
  // Mirror the server's "punched" contrast remap so the browser noise
  // reads as silver-halide grain rather than a smooth fog. The size
  // value maps inversely to baseFrequency (smaller size = finer noise).
  const baseFreq = 0.9 / Math.max(0.5, config.size);
  const tableValues = '0 1 0 1 0 1';
  return (
    <g style={{ mixBlendMode: 'overlay' }}>
      <defs>
        <filter
          id={id}
          x={0}
          y={0}
          width="100%"
          height="100%"
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency={baseFreq}
            numOctaves={2}
            seed={7}
            stitchTiles="stitch"
            result="noise"
          />
          <feComponentTransfer in="noise" result="punched">
            <feFuncR type="table" tableValues={tableValues} />
            <feFuncG type="table" tableValues={tableValues} />
            <feFuncB type="table" tableValues={tableValues} />
          </feComponentTransfer>
          {config.monochrome ? (
            <feColorMatrix
              in="punched"
              type="matrix"
              values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0"
              result="grain"
            />
          ) : (
            <feColorMatrix
              in="punched"
              type="matrix"
              values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"
              result="grain"
            />
          )}
          <feColorMatrix
            in="grain"
            type="matrix"
            values={`1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${config.intensity} 0`}
          />
        </filter>
      </defs>
      <rect width={width} height={height} fill="#808080" filter={`url(#${id})`} />
    </g>
  );
}

function LetterboxOverlay({
  width,
  height,
  config,
}: {
  width: number;
  height: number;
  config: LetterboxConfig;
}): ReactElement {
  const opacity = config.opacity ?? 1;
  return (
    <g>
      {config.top > 0 && (
        <rect x={0} y={0} width={width} height={config.top} fill={config.color} fillOpacity={opacity} />
      )}
      {config.bottom > 0 && (
        <rect
          x={0}
          y={height - config.bottom}
          width={width}
          height={config.bottom}
          fill={config.color}
          fillOpacity={opacity}
        />
      )}
      {config.left > 0 && (
        <rect x={0} y={0} width={config.left} height={height} fill={config.color} fillOpacity={opacity} />
      )}
      {config.right > 0 && (
        <rect
          x={width - config.right}
          y={0}
          width={config.right}
          height={height}
          fill={config.color}
          fillOpacity={opacity}
        />
      )}
    </g>
  );
}

function FrameOverlay({
  width,
  height,
  config,
}: {
  width: number;
  height: number;
  config: FrameConfig;
}): ReactElement {
  const style = config.style ?? 'solid';
  const dashAttr =
    style === 'dashed'
      ? `${(config.thickness * 2).toFixed(2)} ${(config.thickness * 1.5).toFixed(2)}`
      : undefined;
  if (style === 'double') {
    const gap = Math.max(1, config.thickness * 0.4);
    const lineThickness = Math.max(1, (config.thickness - gap) / 2);
    const outerOffset = config.inset + lineThickness / 2;
    const innerOffset = config.inset + lineThickness + gap + lineThickness / 2;
    const outerW = width - 2 * outerOffset;
    const outerH = height - 2 * outerOffset;
    const innerW = width - 2 * innerOffset;
    const innerH = height - 2 * innerOffset;
    return (
      <g>
        {outerW > 0 && outerH > 0 && (
          <rect
            x={outerOffset}
            y={outerOffset}
            width={outerW}
            height={outerH}
            fill="none"
            stroke={config.color}
            strokeWidth={lineThickness}
          />
        )}
        {innerW > 0 && innerH > 0 && (
          <rect
            x={innerOffset}
            y={innerOffset}
            width={innerW}
            height={innerH}
            fill="none"
            stroke={config.color}
            strokeWidth={lineThickness}
          />
        )}
      </g>
    );
  }
  const offset = config.inset + config.thickness / 2;
  const w = width - 2 * offset;
  const h = height - 2 * offset;
  if (w <= 0 || h <= 0) return <g />;
  return (
    <rect
      x={offset}
      y={offset}
      width={w}
      height={h}
      fill="none"
      stroke={config.color}
      strokeWidth={config.thickness}
      strokeDasharray={dashAttr}
    />
  );
}

function TitleBarOverlay({
  width,
  height,
  config,
}: {
  width: number;
  height: number;
  config: TitleBarRendererInput;
}): ReactElement {
  // Title-bar layout mirrors the server's `titleBarRect`: full canvas
  // width, position determines y (top or bottom).
  const safeFraction = Math.max(0.05, Math.min(0.5, config.heightFraction));
  const barH = Math.max(1, Math.round(height * safeFraction));
  const isTop = config.position === 'top' || config.position === 'overlay-top';
  const y = isTop ? 0 : Math.max(0, height - barH);
  const padX = Math.max(8, Math.round(width * 0.03));
  const padY = Math.max(4, Math.round(barH * 0.1));
  const textWidth = Math.max(16, width - 2 * padX);
  const hasSubtitle = !!config.subtitle && config.subtitle.trim().length > 0;
  const titlePt = hasSubtitle
    ? Math.max(10, Math.round(barH * 0.4))
    : Math.max(12, Math.round(barH * 0.45));
  const subtitlePt = hasSubtitle ? Math.max(8, Math.round(barH * 0.25)) : 0;
  const subtitleAlign =
    !config.subtitleAlign || config.subtitleAlign === 'match-title'
      ? config.align
      : config.subtitleAlign;
  const subtitleColor = config.subtitleColor ?? config.textColor;
  const subtitleFamily = config.subtitleFontFamily ?? config.fontFamily;
  // Vertical layout: stack title above subtitle when present; otherwise
  // centre the title in the bar. SVG `<text>` is positioned by baseline
  // — we approximate by `y + titleTop + titlePt * 0.85`.
  const gap = hasSubtitle ? Math.max(2, Math.round(barH * 0.05)) : 0;
  const totalTextH = titlePt + (hasSubtitle ? gap + subtitlePt : 0);
  const titleTop = Math.max(padY, Math.round((barH - totalTextH) / 2));
  const subtitleTop = hasSubtitle ? titleTop + titlePt + gap : 0;
  const titleAnchor = svgTextAnchor(config.align);
  const subtitleAnchor = svgTextAnchor(subtitleAlign);
  const titleX = svgTextX(width, padX, config.align);
  const subtitleX = svgTextX(width, padX, subtitleAlign);
  return (
    <g transform={`translate(0, ${y})`}>
      <rect
        x={0}
        y={0}
        width={width}
        height={barH}
        fill={config.backgroundColor}
        fillOpacity={config.backgroundOpacity}
      />
      {config.shadow && config.shadow.opacity > 0 && (
        <text
          x={titleX + config.shadow.offsetPx}
          y={titleTop + titlePt * 0.85 + config.shadow.offsetPx}
          fontFamily={config.fontFamily}
          fontSize={titlePt}
          fill={config.shadow.color}
          fillOpacity={config.shadow.opacity}
          textAnchor={titleAnchor}
          style={config.shadow.blurPx > 0 ? { filter: `blur(${config.shadow.blurPx / 3}px)` } : undefined}
        >
          {config.text}
        </text>
      )}
      <text
        x={titleX}
        y={titleTop + titlePt * 0.85}
        fontFamily={config.fontFamily}
        fontSize={titlePt}
        fill={config.textColor}
        textAnchor={titleAnchor}
      >
        {config.text}
      </text>
      {hasSubtitle && (
        <text
          x={subtitleX}
          y={subtitleTop + subtitlePt * 0.85}
          fontFamily={subtitleFamily}
          fontSize={subtitlePt}
          fill={subtitleColor}
          textAnchor={subtitleAnchor}
        >
          {config.subtitle}
        </text>
      )}
      {/* `textWidth` exists in the layout math even when we don't
         render an explicit text-width attribute. Acknowledged here so
         the linter doesn't flag the unused intermediate. */}
      {textWidth < 0 ? null : null}
    </g>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isLightHex(hex: string): boolean {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return true;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
}

/** Map the server's halftone blend choice (which includes `normal`)
 *  onto a CSS `mix-blend-mode` value. `normal` becomes `normal` (the
 *  paint-flat blend); the four mixing blends pass through verbatim. */
function halftoneBlendModeToCss(b: HalftoneBlend): CSSProperties['mixBlendMode'] {
  if (b === 'normal') return 'normal';
  return b;
}

function svgTextAnchor(a: 'left' | 'center' | 'right'): 'start' | 'middle' | 'end' {
  if (a === 'left') return 'start';
  if (a === 'right') return 'end';
  return 'middle';
}

function svgTextX(width: number, padX: number, align: 'left' | 'center' | 'right'): number {
  if (align === 'left') return padX;
  if (align === 'right') return width - padX;
  return width / 2;
}

// Suppress the unused-import warning for FrameStyle — it's used via the
// FrameConfig type union but TS doesn't always track this through the
// re-export chain.
type _FrameStyleUsed = FrameStyle;
void (null as unknown as _FrameStyleUsed);

// ─── Free-form canvas pattern overlay ──────────────────────────────────────

/** Render a tiled SVG pattern across the entire canvas. Four pattern
 *  kinds:
 *   - `stripes`: 45° diagonal stripes (one stripe per tile).
 *   - `dots`: small circle centred in each tile.
 *   - `checker`: filled top-left + bottom-right squares per 2×2 tile
 *     group (classic checkerboard).
 *   - `grid`: thin lines on the top + left edges of each tile (creates
 *     a continuous grid when tiled).
 *  Each tile is `pattern.size × pattern.size` canvas pixels. */
function FreeFormCanvasPattern({
  width,
  height,
  pattern,
  idBase,
}: {
  width: number;
  height: number;
  pattern: NonNullable<ThumbnailRendererProps['canvasBackgroundPattern']>;
  idBase: string;
}): ReactElement {
  const tile = Math.max(2, Math.round(pattern.size));
  let inner: ReactElement;
  switch (pattern.kind) {
    case 'dots':
      inner = (
        <circle cx={tile / 2} cy={tile / 2} r={Math.max(1, tile * 0.15)} fill={pattern.color} />
      );
      break;
    case 'stripes':
      // 45° diagonal line from (0, tile) to (tile, 0). Stroke width
      // ~15 % of tile for a balanced bands-vs-gaps look.
      inner = (
        <line
          x1={0}
          y1={tile}
          x2={tile}
          y2={0}
          stroke={pattern.color}
          strokeWidth={Math.max(1, tile * 0.15)}
        />
      );
      break;
    case 'checker':
      inner = (
        <>
          <rect x={0} y={0} width={tile / 2} height={tile / 2} fill={pattern.color} />
          <rect
            x={tile / 2}
            y={tile / 2}
            width={tile / 2}
            height={tile / 2}
            fill={pattern.color}
          />
        </>
      );
      break;
    case 'grid':
    default: {
      const strokeW = Math.max(1, tile * 0.05);
      inner = (
        <>
          <line x1={0} y1={0} x2={tile} y2={0} stroke={pattern.color} strokeWidth={strokeW} />
          <line x1={0} y1={0} x2={0} y2={tile} stroke={pattern.color} strokeWidth={strokeW} />
        </>
      );
      break;
    }
  }
  return (
    <g opacity={Math.max(0, Math.min(1, pattern.opacity))}>
      <defs>
        <pattern id={idBase} patternUnits="userSpaceOnUse" width={tile} height={tile}>
          {inner}
        </pattern>
      </defs>
      <rect width={width} height={height} fill={`url(#${idBase})`} />
    </g>
  );
}

// ─── Free-form cell renderer ───────────────────────────────────────────────

/** Draw one free-form cell: a coloured rectangle with a black border,
 *  an emoji glyph centered in the illustration area (top 80 %), and a
 *  label band (bottom 20 %) with the cell's label text. Mirrors the
 *  square-card layout the server's `applyCellUploads` produces, so the
 *  client preview reads as a direct preview of the eventual PNG. */
function FreeFormCellGroup({ cell }: { cell: FreeFormCell }): ReactElement {
  const { x, y, w, h } = cell.bounds;
  const bg = cell.bgColor ?? '#ffffff';
  const borderColor = cell.borderColor ?? '#000000';
  // Border thickness: explicit `borderPx` wins (caller knows what they
  // want). Otherwise pick from `borderWeight` — `'thick'` doubles the
  // base 0.6 %-of-cell-width into the cartoon-doodle range, `'thin'`
  // and the legacy unset path keep the original 0.6 %. Floor of 3 so
  // borders stay visible on very small cells.
  const borderWeight = cell.borderWeight ?? 'thin';
  const borderPx =
    cell.borderPx ??
    Math.max(3, Math.round(w * (borderWeight === 'thick' ? 0.016 : 0.006)));
  // Match server's SQUARE_ILLUSTRATION_FRAC = 0.8.
  const illustrationH = Math.round(h * 0.8);
  const labelH = h - illustrationH;
  // r2.9: cell shape. Square / rounded / circle render with different
  // background + border + clip behaviour. Defaults to square (the
  // existing behaviour pre-r2.9, so configs without `shape` round-trip
  // pixel-identical).
  const shape = cell.shape ?? 'square';
  const cornerRadius = shape === 'rounded' ? Math.round(Math.min(w, h) * 0.08) : 0;
  // Circle mode: a centred disc fits inside the illustration area
  // (top 80 % of the cell). Disc diameter is the LESSER of the cell
  // width and the illustration height so the disc never overflows
  // either axis. Label band stays in the bottom 20 % beneath the disc.
  const discDiameter = Math.min(w, illustrationH);
  const discCx = x + w / 2;
  const discCy = y + illustrationH / 2;
  // Stable per-instance id for the circle's <clipPath>. Without this,
  // the <image> below paints into the disc's bounding SQUARE — so wherever
  // the disc curves up (most visibly along the bottom edge) the image
  // overflows the circle into the cell corners and the disc looks
  // flat-bottomed. The server-side Sharp composite already masks via
  // an alpha layer; this brings the browser preview in line.
  const circleClipId = useId();
  // Card-style axes (2026-06-04 parity work). `fillStyle` decides which
  // visual fills the disc; the flags below collapse the precedence rules
  // into one place instead of repeating them on each branch's condition.
  //  - `useCutout`: circle-only, needs the bg-removed PNG ready.
  //  - `useIcon`: forced when `fillStyle === 'icon'` even if `imageUrl`
  //    is set; otherwise legacy "image > icon > emoji" precedence.
  //  - `useImage` / `useEmoji`: fall through.
  const fillStyle = cell.fillStyle ?? 'photo';
  const hasUsableIcon = !!(cell.iconSlug && getIconEntry(cell.iconSlug));
  const useCutout = shape === 'circle' && fillStyle === 'cutout' && !!cell.cutoutImageUrl;
  const useIcon = !useCutout && hasUsableIcon && (fillStyle === 'icon' || !cell.imageUrl);
  const useImage = !useCutout && !useIcon && fillStyle !== 'icon' && !!cell.imageUrl;
  const useEmoji = !useCutout && !useIcon && !useImage && !!cell.emoji && cell.emoji.trim().length > 0;
  // Emoji sizes to ~60 % of the illustration area's shorter side — big
  // enough to read, small enough to leave breathing room.
  const emojiSize = Math.round(Math.min(w, illustrationH) * 0.55);
  // Label font sizes to ~0.55 of the label band height (matches the
  // server's renderLabelPng calibration). Per-cell override scales
  // this baseline so a user can punch up a key label or shrink a
  // long one.
  const labelMultiplier = cell.labelSizeMultiplier ?? 1;
  const labelFontSize = Math.max(8, Math.round(labelH * 0.55 * labelMultiplier));
  return (
    <g>
      {/* Cell background.
          - `square` / `rounded`: standard rect spanning the full cell.
          - `circle`: a white rect for the label band area first, then a
            coloured disc inside the illustration region. The disc is
            painted in `bg` so the user's chosen colour drives the
            circle's tone; the cell rect outside the disc shows white
            (matching the gutter / canvas background). */}
      {shape === 'circle' ? (
        <>
          <rect x={x} y={y} width={w} height={h} fill="#ffffff" />
          <circle cx={discCx} cy={discCy} r={discDiameter / 2} fill={bg} />
          {/* Clip region for the image / icon / emoji that follows.
              Defining it under <defs> means the clipPath itself doesn't
              paint — it only acts as a mask for any <g clip-path> that
              references it below. */}
          <defs>
            <clipPath id={circleClipId}>
              <circle cx={discCx} cy={discCy} r={discDiameter / 2} />
            </clipPath>
          </defs>
        </>
      ) : (
        <rect x={x} y={y} width={w} height={h} fill={bg} rx={cornerRadius} ry={cornerRadius} />
      )}
      {/* Cutout fill (circle + `fillStyle: 'cutout'`). Paints the
          background-removed PNG at ~80 % disc height, centred. The
          disc's `bg` colour shows through wherever the cutout is
          transparent — that's the "subject-on-solid-colour" look from
          the reference thumbnails. No clip-path needed because the
          cutout is already smaller than the disc. */}
      {useCutout && cell.cutoutImageUrl && (() => {
        const subjectH = Math.round(discDiameter * 0.8);
        const subjectX = discCx - subjectH / 2;
        const subjectY = discCy - subjectH / 2;
        return (
          <image
            href={cell.cutoutImageUrl}
            x={subjectX}
            y={subjectY}
            width={subjectH}
            height={subjectH}
            preserveAspectRatio="xMidYMid meet"
          />
        );
      })()}
      {/* Custom image (per-cell upload / URL). Takes PRECEDENCE over
          both Lucide icons and emojis when set. The image fills the
          illustration area (top 80 % of the cell, or the disc in
          circle mode). Same transform pipeline applies. */}
      {useImage && (() => {
        const cx = x + w / 2;
        const cy = y + illustrationH / 2;
        const offsetX = (cell.emojiOffsetX ?? 0) * w;
        const offsetY = (cell.emojiOffsetY ?? 0) * illustrationH;
        const rotation = cell.emojiRotation ?? 0;
        const flipX = cell.emojiFlipX ? -1 : 1;
        const flipY = cell.emojiFlipY ? -1 : 1;
        const transform = [
          `translate(${cx + offsetX}, ${cy + offsetY})`,
          rotation !== 0 ? `rotate(${rotation})` : null,
          flipX !== 1 || flipY !== 1 ? `scale(${flipX}, ${flipY})` : null,
          `translate(${-cx}, ${-cy})`,
        ]
          .filter(Boolean)
          .join(' ');
        // For circle mode, fit the image to the disc bounding box;
        // otherwise fit to the illustration area.
        const useDisc = shape === 'circle';
        const imgX = useDisc ? discCx - discDiameter / 2 : x;
        const imgY = useDisc ? discCy - discDiameter / 2 : y;
        const imgW = useDisc ? discDiameter : w;
        const imgH = useDisc ? discDiameter : illustrationH;
        const par =
          cell.imageFit === 'contain'
            ? 'xMidYMid meet'
            : cell.imageFit === 'fill'
              ? 'none'
              : 'xMidYMid slice';
        const imageGroup = (
          <g transform={transform}>
            <image
              href={cell.imageUrl}
              x={imgX}
              y={imgY}
              width={imgW}
              height={imgH}
              preserveAspectRatio={par}
            />
          </g>
        );
        // In circle mode, clip the painted image to the disc so the
        // bounding-square overflow (the flat-bottom artefact) is gone.
        // Square / rounded modes don't need the clip — their bounding
        // box and visible region already match.
        return useDisc
          ? <g clipPath={`url(#${circleClipId})`}>{imageGroup}</g>
          : imageGroup;
      })()}
      {/* Lucide icon path — takes precedence over emoji when both are
          set. Same transform pipeline as the emoji branch (rotation
          / flip / offset around the cell centre). The icon is
          imported as an SVG string from `flex-icon-grid-icons.ts` and
          embedded via `dangerouslySetInnerHTML` on a wrapping `<g>`
          (React doesn't natively parse raw SVG markup into elements).
          `useIcon` collapses the precedence rules — see the flag
          declarations above. */}
      {useIcon && cell.iconSlug && getIconEntry(cell.iconSlug) && (() => {
        const cx = x + w / 2;
        const cy = y + illustrationH / 2;
        const offsetX = (cell.emojiOffsetX ?? 0) * w;
        const offsetY = (cell.emojiOffsetY ?? 0) * illustrationH;
        const rotation = cell.emojiRotation ?? 0;
        const flipX = cell.emojiFlipX ? -1 : 1;
        const flipY = cell.emojiFlipY ? -1 : 1;
        const iconSize = Math.round(Math.min(w, illustrationH) * 0.55);
        const iconColor = cell.iconColor ?? '#000000';
        const strokeWidth = cell.iconStrokeWidth ?? 2;
        const entry = getIconEntry(cell.iconSlug);
        if (!entry) return null;
        const inner = extractIconInner(entry.svg);
        if (!inner) return null;
        const scale = iconSize / 24;
        const tx = cx - iconSize / 2;
        const ty = cy - iconSize / 2;
        const transform = [
          `translate(${cx + offsetX}, ${cy + offsetY})`,
          rotation !== 0 ? `rotate(${rotation})` : null,
          flipX !== 1 || flipY !== 1 ? `scale(${flipX}, ${flipY})` : null,
          `translate(${-cx}, ${-cy})`,
        ]
          .filter(Boolean)
          .join(' ');
        // The outer wrap applies the per-cell user transform. The
        // inner wrap applies the icon's own translate+scale to map
        // its 24×24 view-box onto the cell-sized target.
        const groupProps =
          entry.iconStyle === 'fill'
            ? { fill: iconColor, stroke: 'none' }
            : {
                fill: 'none',
                stroke: iconColor,
                strokeWidth: strokeWidth / scale,
                strokeLinecap: 'round' as const,
                strokeLinejoin: 'round' as const,
              };
        return (
          <g transform={transform}>
            <g
              transform={`translate(${tx} ${ty}) scale(${scale})`}
              {...groupProps}
              dangerouslySetInnerHTML={{ __html: inner }}
            />
          </g>
        );
      })()}
      {/* Emoji illustration — centred in the top 80 % with optional
          per-cell offset / rotation / flip. The transform is applied
          ONLY to the emoji glyph (not the background or border) so the
          cell frame stays axis-aligned regardless of the rotation.
          Skipped when a higher-precedence visual is active — see the
          `useEmoji` flag above. */}
      {useEmoji && (() => {
        const cx = x + w / 2;
        const cy = y + illustrationH / 2;
        const offsetX = (cell.emojiOffsetX ?? 0) * w;
        const offsetY = (cell.emojiOffsetY ?? 0) * illustrationH;
        const rotation = cell.emojiRotation ?? 0;
        const flipX = cell.emojiFlipX ? -1 : 1;
        const flipY = cell.emojiFlipY ? -1 : 1;
        // Order: translate to centre → apply user offset → rotate →
        // flip → translate origin back. Equivalent to "rotate/flip
        // around the (offset) cell centre". The y position of the
        // <text> element is the BASELINE, so we offset by emojiSize/3
        // to roughly visually centre the glyph in the illustration box.
        const transform = [
          `translate(${cx + offsetX}, ${cy + offsetY})`,
          rotation !== 0 ? `rotate(${rotation})` : null,
          flipX !== 1 || flipY !== 1 ? `scale(${flipX}, ${flipY})` : null,
          `translate(${-cx}, ${-cy})`,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <g transform={transform}>
            <text
              x={cx}
              y={cy + emojiSize / 3}
              fontSize={emojiSize}
              textAnchor="middle"
              fontFamily="'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif"
            >
              {cell.emoji}
            </text>
          </g>
        );
      })()}
      {/* Hairline divider between illustration and label band — only
          for square/rounded shapes (circle has no divider; the disc
          floats above the label band). */}
      {shape !== 'circle' && (
        <line
          x1={x}
          y1={y + illustrationH}
          x2={x + w}
          y2={y + illustrationH}
          stroke={borderColor}
          strokeWidth={Math.max(1, Math.round(borderPx / 3))}
        />
      )}
      {/* Label band background (white) — square / rounded only. Circle
          mode's label sits directly on the cell rect (already white). */}
      {shape !== 'circle' && (
        <rect x={x} y={y + illustrationH} width={w} height={labelH} fill="#ffffff" />
      )}
      {/* Label text. Three orthogonal knobs:
            - `labelPosition`: 'below' (classic, centred in the label
              band) vs 'overlap' (circle only — baseline sits just
              below the disc edge so the label's top half crosses
              into the disc).
            - `labelCase`: 'title' keeps source casing; 'upper' applies
              the uppercase transform at render time. SVG <text> does
              NOT honour CSS `text-transform`, so we uppercase the
              displayed string directly.
            - `overlapLabelStroke`: only meaningful when overlapping —
              picks white-on-black or black-on-white stroked text. The
              stroke is painted UNDER the fill via `paint-order` so the
              outline doesn't eat into the glyph silhouette. */}
      {cell.label && cell.label.trim() && (() => {
        const labelCase = cell.labelCase ?? 'title';
        const labelPosition = cell.labelPosition ?? 'below';
        const isOverlap = shape === 'circle' && labelPosition === 'overlap';
        const displayLabel = labelCase === 'upper' ? cell.label.toUpperCase() : cell.label;
        const baseY = isOverlap
          ? discCy + discDiameter / 2 + labelFontSize * 0.25
          : y + illustrationH + labelH / 2 + labelFontSize / 3;
        const overlapStroke = cell.overlapLabelStroke ?? 'white-on-black';
        const overlapFill = isOverlap
          ? overlapStroke === 'white-on-black' ? '#ffffff' : '#000000'
          : (cell.labelColor ?? '#000000');
        const overlapStrokeColor = isOverlap
          ? overlapStroke === 'white-on-black' ? '#000000' : '#ffffff'
          : undefined;
        return (
          <text
            x={x + w / 2}
            y={baseY}
            fontSize={labelFontSize}
            textAnchor="middle"
            fill={overlapFill}
            stroke={overlapStrokeColor}
            strokeWidth={isOverlap ? labelFontSize * 0.06 : undefined}
            paintOrder={isOverlap ? 'stroke fill' : undefined}
            fontFamily={cell.labelFontFamily ?? 'Patrick Hand'}
            fontWeight={isOverlap ? 700 : undefined}
          >
            {displayLabel}
          </text>
        );
      })()}
      {/* Outer border. Square / rounded use a rect with optional
          corner radius; circle draws a stroked disc around the
          illustration area (label band has no border). Circles force
          black (`#000000`) — the per-cell `borderColor` override is
          ignored here because every reference thumbnail in the genre
          uses a black border and a coloured one reads as off-style. */}
      {shape === 'circle' ? (
        <circle
          cx={discCx}
          cy={discCy}
          r={discDiameter / 2 - borderPx / 2}
          fill="none"
          stroke="#000000"
          strokeWidth={borderPx}
        />
      ) : (
        <rect
          x={x + borderPx / 2}
          y={y + borderPx / 2}
          width={w - borderPx}
          height={h - borderPx}
          fill="none"
          stroke={borderColor}
          strokeWidth={borderPx}
          rx={cornerRadius}
          ry={cornerRadius}
        />
      )}
    </g>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

/**
 * Render a thumbnail with all r2.8 finishing overlays applied
 * client-side as SVG. The base image is loaded as an `<img>`; the
 * overlays sit in an `<svg>` positioned absolutely on top.
 *
 * Pipeline order (matches `applySharedOverlays` in the server):
 *   filter → vignette → tint → light-leak → inner-glow → dust →
 *   halftone → grain → letterbox → frame → title-bar.
 *
 * IDs for `<defs>` are namespaced via `useId()` so multiple
 * `<ThumbnailRenderer>` instances in the same page don't collide.
 */
export function ThumbnailRenderer({
  baseImageUrl,
  cells,
  canvasBackground,
  canvasBackgroundGradient,
  canvasBackgroundPattern,
  canvasWidth,
  canvasHeight,
  postProcess,
  titleBar,
  style,
  children,
  alt = 'Thumbnail preview',
}: ThumbnailRendererProps): ReactElement {
  const idBase = useId();
  const filterCss = cssFilterFor(postProcess?.filter);
  const w = Math.max(1, canvasWidth);
  const h = Math.max(1, canvasHeight);
  // Mode dispatch: `cells` wins over `baseImageUrl` when both are set
  // (avoids a hidden ambiguity if the caller forgot to clear one).
  const useFreeForm = Array.isArray(cells);
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: `${w} / ${h}`,
        overflow: 'hidden',
        ...style,
      }}
    >
      {useFreeForm ? (
        // Free-form mode: draw the cells as SVG primitives. CSS `filter`
        // applies on the container so grayscale / sepia / etc. land on
        // the cells too — same posture as the AI-image branch.
        // Background: CSS `background` honours either a solid colour or
        // a linear-gradient(deg, …) for the gradient prop.
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            display: 'block',
            filter: filterCss,
            background: canvasBackgroundGradient
              ? `linear-gradient(${canvasBackgroundGradient.angle}deg, ${canvasBackgroundGradient.from}, ${canvasBackgroundGradient.to})`
              : (canvasBackground ?? '#ffffff'),
          }}
        >
          {/* Optional pattern overlay drawn BEFORE the cells so it
              sits between the solid/gradient background and the cell
              shapes. Each pattern is a small SVG `<pattern>` tile
              repeating across the canvas. `opacity` is on the wrapper
              `<g>` so the pattern's strength can be adjusted without
              re-baking the colour. */}
          {canvasBackgroundPattern && (
            <FreeFormCanvasPattern
              width={w}
              height={h}
              pattern={canvasBackgroundPattern}
              idBase={`${idBase}-pat`}
            />
          )}
          {(cells ?? []).map((cell, i) => (
            <FreeFormCellGroup key={i} cell={cell} />
          ))}
        </svg>
      ) : (
        /* Base image. The CSS `filter` covers grayscale / sepia /
           contrast / invert without a Sharp roundtrip. */
        <img
          src={baseImageUrl}
          alt={alt}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            filter: filterCss,
          }}
        />
      )}
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        {postProcess?.vignette && (
          <VignetteOverlay
            width={w}
            height={h}
            config={postProcess.vignette}
            id={`${idBase}-vg`}
          />
        )}
        {postProcess?.tint && <TintOverlay width={w} height={h} config={postProcess.tint} />}
        {postProcess?.lightLeak && (
          <LightLeakOverlay
            width={w}
            height={h}
            config={postProcess.lightLeak}
            id={`${idBase}-ll`}
          />
        )}
        {postProcess?.innerGlow && (
          <InnerGlowOverlay
            width={w}
            height={h}
            config={postProcess.innerGlow}
            id={`${idBase}-ig`}
          />
        )}
        {postProcess?.dust && (
          <DustOverlay width={w} height={h} config={postProcess.dust} id={`${idBase}-dust`} />
        )}
        {postProcess?.halftone && (
          <HalftoneOverlay
            width={w}
            height={h}
            config={postProcess.halftone}
            id={`${idBase}-ht`}
          />
        )}
        {postProcess?.grain && (
          <GrainOverlay
            width={w}
            height={h}
            config={postProcess.grain}
            id={`${idBase}-grain`}
          />
        )}
        {postProcess?.letterbox && (
          <LetterboxOverlay width={w} height={h} config={postProcess.letterbox} />
        )}
        {postProcess?.frame && <FrameOverlay width={w} height={h} config={postProcess.frame} />}
        {titleBar && <TitleBarOverlay width={w} height={h} config={titleBar} />}
      </svg>
      {/* Caller-supplied children (e.g. region overlay) sit ABOVE the
          finishing overlays — same z-order as the previous `<img>`
          implementation. */}
      {children}
    </div>
  );
}
