/**
 * Shared overlay pipeline — post-render Sharp passes that any thumbnail
 * format can call after its image-model render returns.
 *
 * Four operations, applied in this order so visual semantics make sense:
 *   1. Filter   — recolours the whole image (grayscale / sepia / contrast /
 *                 invert). Runs first because every later step is layered
 *                 on top of the recoloured base.
 *   2. Vignette — radial darkening from edges inward. Layered over the
 *                 filtered base, before grain so grain particles aren't
 *                 swallowed by the vignette gradient.
 *   3. Grain    — Gaussian-style noise texture. Last of the post-process
 *                 trio so it sits visually on top of vignette and filter.
 *   4. Title bar — overlay text band at top/bottom of the canvas. Always
 *                 last so it stays sharp and crisp above everything else.
 *
 * Why these four together: post-process (1-3) and title bar (4) share the
 * same load-bearing seam — they run after the AI image is in hand. Putting
 * them in one pipeline means each format wires the pipeline in once and
 * gets all of them for free.
 *
 * Pure-ish module: uses `sharp` (a native binding), reads font files from
 * disk. No React, no Next.js, no network. Unit-testable directly via vitest.
 *
 * Logs every operation that runs with `console.info('[shared-overlay <op>]',
 * { ... })` so production debugging can grep one namespace and see exactly
 * what the pipeline applied per request.
 */

import sharp from 'sharp';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Same DoS-guard cap used by `topic-card-grid-composite.ts`. Matches that
 *  module's value (100M pixels) so a base image that passes one composite
 *  passes the other. */
const SHARP_INPUT_PIXEL_CAP = 100_000_000;

/** Title bar height is clamped to this fraction of canvas height at minimum.
 *  Smaller and the text Pango renders would be unreadable; smaller fractions
 *  also tend to be UI mistakes. */
const TITLE_BAR_MIN_HEIGHT_FRACTION = 0.05;

/** Maximum title-bar fraction. Above 50% the title bar swallows the actual
 *  thumbnail content. */
const TITLE_BAR_MAX_HEIGHT_FRACTION = 0.5;

/** Sepia colour matrix (ITU-R BT.601 derivation). Standard tone for the
 *  "old photo" sepia look. Identical to what every major image library uses. */
const SEPIA_MATRIX: [[number, number, number], [number, number, number], [number, number, number]] = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131],
];

// ─── Public types ───────────────────────────────────────────────────────────

export type ImageFilter =
  | 'grayscale'
  | 'sepia'
  | 'high-contrast'
  | 'low-contrast'
  | 'invert';

export interface VignetteConfig {
  /** Hex colour the vignette fades into. Typically `#000000` for the
   *  classic darkening vignette; `#ffffff` produces a hazy bright fade. */
  color: string;
  /** Edge opacity. 0 = no vignette, 1 = fully opaque colour at the corners. */
  intensity: number;
  /** Where the vignette starts (as fraction of canvas radius). Lower values
   *  = tighter vignette (begins closer to center). Range 0.3 - 1.0. */
  radius: number;
}

export interface GrainConfig {
  /** Overlay opacity. 0 = no grain, 1 = maximally visible grain. */
  intensity: number;
  /** Grain particle size in pixels. 1 = single-pixel noise (fine film grain);
   *  5 = chunky digital grain. Range 0.5 - 5. */
  size: number;
  /** Monochrome grain (same value across RGB) vs colour grain (independent
   *  per channel). Monochrome matches classic film; colour matches sensor
   *  noise. */
  monochrome: boolean;
}

// ─── New r2.8 finishing overlays — ported from flex-icon-grid-composer ──────

/** Blend modes shared by tint / light-leak / inner-glow. Maps 1:1 onto Sharp's
 *  `composite({ blend })` strings. */
export type ColorGradeBlend = 'multiply' | 'screen' | 'overlay' | 'soft-light';

/** Halftone has the same four mixing modes PLUS a `normal` (paint-flat)
 *  option for when the dots should sit ON TOP of the canvas rather than
 *  blending into it. */
export type HalftoneBlend = ColorGradeBlend | 'normal';

/** Light-leak anchor positions. Eight presets covering 4 corners + 4 edges
 *  — the gradient centre sits ON the named edge so half the colour bleeds
 *  off-canvas, mimicking real lens leaks. */
export type LightLeakPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right';

/** Frame stroke style. `solid` = one continuous stroke. `double` = two
 *  parallel strokes with a gap. `dashed` = solid stroke with stroke-dasharray. */
export type FrameStyle = 'solid' | 'double' | 'dashed';

export interface TintConfig {
  /** Tint colour hex. */
  color: string;
  /** Overlay alpha, 0-1. */
  intensity: number;
  /** Sharp blend mode for the tint composite. */
  blendMode: ColorGradeBlend;
  /** Optional split-tone shadows hex — composited with `multiply` at
   *  `intensity * splitToneStrength` so dark areas get tinted with this hue. */
  shadows?: string;
  /** Optional split-tone highlights hex — composited with `screen` at
   *  `intensity * splitToneStrength` so light areas get lifted with this hue. */
  highlights?: string;
  /** Strength of the split-tone layers. 0-1. Defaults to 0.5 when omitted. */
  splitToneStrength?: number;
}

export interface LightLeakConfig {
  color: string;
  intensity: number;
  /** Radius as a fraction of the canvas's SHORT half-axis. 0.2 - 1. */
  radius: number;
  position: LightLeakPosition;
  /** Defaults to `'screen'` when omitted. */
  blendMode?: ColorGradeBlend;
}

export interface InnerGlowConfig {
  color: string;
  intensity: number;
  /** Glow radius as a fraction of the canvas's SHORT half-axis. 0.3 - 1.5. */
  radius: number;
  /** Defaults to `'screen'` when omitted. */
  blendMode?: 'screen' | 'overlay' | 'soft-light';
}

export interface DustConfig {
  /** Speck colour. White = bright dust, black = dark scratches. */
  color: string;
  /** Speck alpha, 0-1. */
  intensity: number;
  /** Density 0-1. Higher = more specks per area. */
  density: number;
  /** Optional turbulence seed (0-9999) for deterministic output. Defaults
   *  to 41 when omitted. */
  seed?: number;
}

export interface HalftoneConfig {
  color: string;
  /** Dot alpha 0-1. */
  opacity: number;
  /** Dot radius in pixels. 0.5 - 10. */
  dotSize: number;
  /** Tile spacing in pixels. 2 - 40. Smaller = denser. */
  spacing: number;
  blendMode: HalftoneBlend;
  /** Pattern rotation in degrees. 0 - 90. Defaults to 0 when omitted. */
  angle?: number;
}

export interface LetterboxConfig {
  color: string;
  /** Bar thickness in pixels per side. 0 = no bar on that side. 0 - 240. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Optional bar opacity 0-1. Defaults to 1 (fully opaque). */
  opacity?: number;
}

export interface FrameConfig {
  color: string;
  /** Stroke thickness in pixels. 1 - 40. */
  thickness: number;
  /** Distance from canvas edge to the stroke's outer edge in pixels. 0 - 80. */
  inset: number;
  /** Defaults to `'solid'` when omitted. */
  style?: FrameStyle;
}

export interface PostProcessConfig {
  filter?: ImageFilter;
  vignette?: VignetteConfig;
  grain?: GrainConfig;
  /** r2.8 finishing overlays — colour grade + texture + framing. Applied in
   *  the order: tint → light leak → inner glow → dust → halftone → letterbox
   *  → frame. See `applySharedOverlays` for the rationale. */
  tint?: TintConfig;
  lightLeak?: LightLeakConfig;
  innerGlow?: InnerGlowConfig;
  dust?: DustConfig;
  halftone?: HalftoneConfig;
  letterbox?: LetterboxConfig;
  frame?: FrameConfig;
}

export type TitleBarPosition = 'top' | 'bottom' | 'overlay-top' | 'overlay-bottom';
export type TitleAlignment = 'left' | 'center' | 'right';

export interface TitleBarShadow {
  /** Drop-shadow offset (positive values move the shadow down and right). */
  offsetPx: number;
  /** Shadow blur radius in pixels. Sharp converts this to a sigma internally. */
  blurPx: number;
  /** Shadow alpha, 0-1. */
  opacity: number;
  /** Shadow colour. Hex. */
  color: string;
}

export interface FontRef {
  /** Pango font-family name (e.g. "Patrick Hand"). Must match a family the
   *  bundled TTF declares; otherwise Pango falls back to its default and the
   *  result won't look like the requested font. */
  family: string;
  /** Absolute file path to the TTF/OTF on disk. Sharp's text input reads
   *  this directly via fontconfig. */
  filePath: string;
}

export interface TitleBarConfig {
  text: string;
  subtitle?: string;
  position: TitleBarPosition;
  /** Height of the title bar as a fraction of the canvas height. 0.05 - 0.5. */
  heightFraction: number;
  align: TitleAlignment;
  /** Defaults to `'match-title'`. */
  subtitleAlign?: TitleAlignment | 'match-title';
  backgroundColor: string;
  /** Opacity of the title bar background rectangle, 0-1. The "overlay-*"
   *  positions typically use 0.5-0.8; the non-overlay positions typically
   *  use 1.0. The pipeline does NOT enforce this — caller decides. */
  backgroundOpacity: number;
  textColor: string;
  /** Defaults to `textColor` if omitted. */
  subtitleColor?: string;
  font: FontRef;
  /** Defaults to `font` if omitted. */
  subtitleFont?: FontRef;
  shadow?: TitleBarShadow;
}

export interface SharedOverlayInput {
  baseImage: Buffer;
  canvas: { width: number; height: number };
  postProcess?: PostProcessConfig;
  titleBar?: TitleBarConfig;
}

// ─── Bounds + safety helpers ────────────────────────────────────────────────

/** Clamp a number to the 0-1 range. Used for opacity / intensity fields.
 *  NaN -> 0 (no sensible projection), +/-Infinity -> the relevant bound
 *  (matches conventional clamp semantics). */
export function clampUnit(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Clamp a number to an explicit range. NaN -> lo (defensive default);
 *  +/-Infinity -> the relevant bound. */
export function clampRange(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Test whether a string is a valid `#RRGGBB` or `#RRGGBBAA` hex colour.
 *  Strict on length + character set — invalid values fall back at the call
 *  site rather than being silently passed to Sharp (which would error). */
export function isHexColor(s: string): boolean {
  return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s);
}

/** Return the input hex if valid; otherwise the documented fallback. Used
 *  at every entry point that accepts a user-supplied colour so a malformed
 *  hex never reaches Sharp. */
export function safeHexColor(input: string, fallback: string): string {
  return isHexColor(input) ? input : fallback;
}

/** Escape Pango-markup control characters so a label like "AT&T" or "<3"
 *  renders as the literal text instead of triggering Pango's parser.
 *  Mirrors `escapePangoText` in `topic-card-grid-composite.ts` — kept here
 *  so this module has no cross-format dependency. */
export function escapePangoText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Request-body parsing ───────────────────────────────────────────────────

/** Allowlist of filter ids. Mirrors the `ImageFilter` union — kept as a
 *  runtime Set so we can guard the parser without listing the union
 *  members twice. */
const KNOWN_FILTERS: ReadonlySet<ImageFilter> = new Set<ImageFilter>([
  'grayscale',
  'sepia',
  'high-contrast',
  'low-contrast',
  'invert',
]);

/** Allowlist of title-bar positions. Runtime Set form of the
 *  `TitleBarPosition` union so the parser can guard without restating
 *  the union members. */
const KNOWN_TITLE_BAR_POSITIONS: ReadonlySet<TitleBarPosition> = new Set<TitleBarPosition>([
  'top',
  'bottom',
  'overlay-top',
  'overlay-bottom',
]);

/** Allowlist of title-bar alignments. Same shape as
 *  `KNOWN_TITLE_BAR_POSITIONS` — runtime guard for the parser. */
const KNOWN_TITLE_ALIGNMENTS: ReadonlySet<TitleAlignment> = new Set<TitleAlignment>([
  'left',
  'center',
  'right',
]);

/** Hard cap on title / subtitle text length. Protects against pathological
 *  long inputs from a stale client; Pango handles wrapping at the bar
 *  width regardless. Identical to the per-cell label cap so the user's
 *  mental model of "what fits" is the same across surfaces. */
const TITLE_BAR_TEXT_MAX_LENGTH = 200;

/**
 * Request-body shape for the title bar. Almost identical to
 * `TitleBarConfig` but carries font IDs (strings) instead of resolved
 * `FontRef` pairs — the routes own font registry resolution so this
 * shared module can stay pure (no disk reads, no registry lookups).
 *
 * Route layer pattern:
 *   const payload = parseTitleBarRequestPayload(body.titleBar);
 *   if (payload) {
 *     titleBar = {
 *       ...payload,
 *       font: resolveFont(payload.fontId),
 *       subtitleFont: payload.subtitleFontId ? resolveFont(payload.subtitleFontId) : undefined,
 *     };
 *   }
 */
export interface TitleBarRequestPayload {
  text: string;
  subtitle?: string;
  position: TitleBarPosition;
  heightFraction: number;
  align: TitleAlignment;
  subtitleAlign?: TitleAlignment | 'match-title';
  backgroundColor: string;
  backgroundOpacity: number;
  textColor: string;
  subtitleColor?: string;
  fontId: string;
  subtitleFontId?: string;
  shadow?: TitleBarShadow;
}

/**
 * Parse and validate a `TitleBarRequestPayload` from an untrusted request
 * body. Returns the normalised payload or `null` when the input is
 * absent, malformed, or trivially empty (no text → no overlay to draw).
 *
 * Validation is FORGIVING for malformed numerics + colour values
 * (clamping / falling back to documented defaults), but STRICT for
 * required structural fields:
 *   - Unknown / missing position → null (no sensible default; format
 *     panels MUST tell us where the bar goes)
 *   - Unknown / missing align → null (same reason)
 *   - Empty / non-string text → null (no overlay to draw)
 *   - Non-string fontId → null (we can't resolve a font without it)
 *
 * For shadow: the sub-object is dropped (not the whole payload) if
 * malformed, mirroring the same defensive shape `parsePostProcessConfig`
 * uses for vignette / grain.
 */
export function parseTitleBarRequestPayload(raw: unknown): TitleBarRequestPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text) return null;
  const position = r.position;
  if (typeof position !== 'string' || !KNOWN_TITLE_BAR_POSITIONS.has(position as TitleBarPosition)) {
    return null;
  }
  const align = r.align;
  if (typeof align !== 'string' || !KNOWN_TITLE_ALIGNMENTS.has(align as TitleAlignment)) {
    return null;
  }
  const fontId = typeof r.fontId === 'string' ? r.fontId : '';
  if (!fontId) return null;

  const subtitle = typeof r.subtitle === 'string' ? r.subtitle.trim() : '';
  const subtitleAlignRaw = r.subtitleAlign;
  let subtitleAlign: TitleAlignment | 'match-title' = 'match-title';
  if (typeof subtitleAlignRaw === 'string') {
    if (subtitleAlignRaw === 'match-title' || KNOWN_TITLE_ALIGNMENTS.has(subtitleAlignRaw as TitleAlignment)) {
      subtitleAlign = subtitleAlignRaw as TitleAlignment | 'match-title';
    }
  }

  const heightFractionRaw = typeof r.heightFraction === 'number' ? r.heightFraction : 0.2;
  const heightFraction = clampRange(heightFractionRaw, TITLE_BAR_MIN_HEIGHT_FRACTION, TITLE_BAR_MAX_HEIGHT_FRACTION);

  const backgroundColor = safeHexColor(
    typeof r.backgroundColor === 'string' ? r.backgroundColor : '#000000',
    '#000000',
  );
  const backgroundOpacityRaw = typeof r.backgroundOpacity === 'number' ? r.backgroundOpacity : 1;
  const backgroundOpacity = clampUnit(backgroundOpacityRaw);

  const textColor = safeHexColor(typeof r.textColor === 'string' ? r.textColor : '#ffffff', '#ffffff');
  const subtitleColor = typeof r.subtitleColor === 'string'
    ? safeHexColor(r.subtitleColor, textColor)
    : undefined;

  const subtitleFontId = typeof r.subtitleFontId === 'string' && r.subtitleFontId
    ? r.subtitleFontId
    : undefined;

  // Shadow sub-object — same forgiving shape vignette / grain use:
  // malformed shadow is dropped, the rest of the payload survives.
  let shadow: TitleBarShadow | undefined;
  if (r.shadow && typeof r.shadow === 'object') {
    const s = r.shadow as Record<string, unknown>;
    const shadowOpacityRaw = typeof s.opacity === 'number' ? s.opacity : 0;
    const shadowOpacity = clampUnit(shadowOpacityRaw);
    // Only emit shadow when its opacity > 0; an opacity of 0 would
    // short-circuit the renderer anyway.
    if (shadowOpacity > 0) {
      shadow = {
        offsetPx: clampRange(typeof s.offsetPx === 'number' ? s.offsetPx : 2, 0, 48),
        blurPx: clampRange(typeof s.blurPx === 'number' ? s.blurPx : 4, 0, 96),
        opacity: shadowOpacity,
        color: safeHexColor(typeof s.color === 'string' ? s.color : '#000000', '#000000'),
      };
    }
  }

  return {
    text: text.slice(0, TITLE_BAR_TEXT_MAX_LENGTH),
    subtitle: subtitle ? subtitle.slice(0, TITLE_BAR_TEXT_MAX_LENGTH) : undefined,
    position: position as TitleBarPosition,
    heightFraction,
    align: align as TitleAlignment,
    subtitleAlign,
    backgroundColor,
    backgroundOpacity,
    textColor,
    subtitleColor,
    fontId,
    subtitleFontId,
    shadow,
  };
}

/**
 * Parse and validate a `PostProcessConfig` from an untrusted request body
 * payload. Returns the normalised config or `null` when the input is
 * absent, malformed, or fully empty (no fields would have any visible
 * effect).
 *
 * Validation is FORGIVING — unknown filter ids drop the filter field
 * rather than failing the whole request, malformed sub-objects (vignette
 * or grain that aren't objects) drop just that sub-object, and out-of-
 * range numerics get clamped by the operation itself. Same shape as the
 * `brightness` / `detail` / `labelSize` validation in the Topic Card Grid
 * route: input that almost-works degrades gracefully to the default.
 *
 * Caller pattern at the route entry:
 *   const postProcess = parsePostProcessConfig(body.postProcess);
 *
 * Then pass `postProcess ?? undefined` through to `applySharedOverlays`
 * (or `applyCellUploads` / `applyNLevelsOverlays` once those grow the
 * field). `null` means "no overlay needed" so the pipeline can short-
 * circuit and skip the entire post-process composite call.
 */
export function parsePostProcessConfig(raw: unknown): PostProcessConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: PostProcessConfig = {};

  if (typeof r.filter === 'string' && KNOWN_FILTERS.has(r.filter as ImageFilter)) {
    out.filter = r.filter as ImageFilter;
  }

  if (r.vignette && typeof r.vignette === 'object') {
    const v = r.vignette as Record<string, unknown>;
    const color = typeof v.color === 'string' ? v.color : '#000000';
    const intensity = typeof v.intensity === 'number' ? v.intensity : 0;
    const radius = typeof v.radius === 'number' ? v.radius : 0.5;
    // Only emit the vignette field when intensity > 0; an intensity of 0
    // would short-circuit the pipeline anyway, so dropping it here keeps
    // the config minimal.
    if (clampUnit(intensity) > 0) {
      out.vignette = {
        color: safeHexColor(color, '#000000'),
        intensity: clampUnit(intensity),
        radius: clampRange(radius, 0.3, 1),
      };
    }
  }

  if (r.grain && typeof r.grain === 'object') {
    const g = r.grain as Record<string, unknown>;
    const intensity = typeof g.intensity === 'number' ? g.intensity : 0;
    const size = typeof g.size === 'number' ? g.size : 1;
    const monochrome = g.monochrome === true;
    if (clampUnit(intensity) > 0) {
      out.grain = {
        intensity: clampUnit(intensity),
        size: clampRange(size, 0.5, 5),
        monochrome,
      };
    }
  }

  // r2.8: tint / light-leak / inner-glow / dust / halftone / letterbox /
  // frame. Each parser follows the same tolerant shape: malformed sub-
  // object → drop the field (rest of postProcess survives); out-of-range
  // numerics → clamp; zero intensity / dropping a required key → drop.
  const tint = parseTintField(r.tint);
  if (tint) out.tint = tint;
  const lightLeak = parseLightLeakField(r.lightLeak);
  if (lightLeak) out.lightLeak = lightLeak;
  const innerGlow = parseInnerGlowField(r.innerGlow);
  if (innerGlow) out.innerGlow = innerGlow;
  const dust = parseDustField(r.dust);
  if (dust) out.dust = dust;
  const halftone = parseHalftoneField(r.halftone);
  if (halftone) out.halftone = halftone;
  const letterbox = parseLetterboxField(r.letterbox);
  if (letterbox) out.letterbox = letterbox;
  const frame = parseFrameField(r.frame);
  if (frame) out.frame = frame;

  // Empty out means none of the operations would do anything visible.
  // Return null so the route layer can pass undefined down to the pipeline
  // and skip the post-process composite entirely.
  if (
    !out.filter &&
    !out.vignette &&
    !out.grain &&
    !out.tint &&
    !out.lightLeak &&
    !out.innerGlow &&
    !out.dust &&
    !out.halftone &&
    !out.letterbox &&
    !out.frame
  ) {
    return null;
  }
  return out;
}

// ─── r2.8 sub-parsers ──────────────────────────────────────────────────────

const TINT_BLEND_MODES: ReadonlySet<ColorGradeBlend> = new Set<ColorGradeBlend>([
  'multiply',
  'screen',
  'overlay',
  'soft-light',
]);

const HALFTONE_BLEND_MODES: ReadonlySet<HalftoneBlend> = new Set<HalftoneBlend>([
  'multiply',
  'screen',
  'overlay',
  'soft-light',
  'normal',
]);

const INNER_GLOW_BLEND_MODES: ReadonlySet<'screen' | 'overlay' | 'soft-light'> = new Set<
  'screen' | 'overlay' | 'soft-light'
>(['screen', 'overlay', 'soft-light']);

const LIGHT_LEAK_POSITIONS: ReadonlySet<LightLeakPosition> = new Set<LightLeakPosition>([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'top',
  'bottom',
  'left',
  'right',
]);

const FRAME_STYLES: ReadonlySet<FrameStyle> = new Set<FrameStyle>(['solid', 'double', 'dashed']);

function parseTintField(raw: unknown): TintConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const intensity = clampUnit(typeof o.intensity === 'number' ? o.intensity : 0);
  if (intensity === 0) return undefined;
  if (typeof o.blendMode !== 'string' || !TINT_BLEND_MODES.has(o.blendMode as ColorGradeBlend)) {
    return undefined;
  }
  const shadows = typeof o.shadows === 'string' && isHexColor(o.shadows) ? o.shadows : undefined;
  const highlights =
    typeof o.highlights === 'string' && isHexColor(o.highlights) ? o.highlights : undefined;
  const splitToneStrength =
    typeof o.splitToneStrength === 'number' ? clampUnit(o.splitToneStrength) : undefined;
  return {
    color: safeHexColor(typeof o.color === 'string' ? o.color : '#ffb27a', '#ffb27a'),
    intensity,
    blendMode: o.blendMode as ColorGradeBlend,
    ...(shadows !== undefined ? { shadows } : {}),
    ...(highlights !== undefined ? { highlights } : {}),
    ...(splitToneStrength !== undefined ? { splitToneStrength } : {}),
  };
}

function parseLightLeakField(raw: unknown): LightLeakConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const intensity = clampUnit(typeof o.intensity === 'number' ? o.intensity : 0);
  if (intensity === 0) return undefined;
  if (typeof o.position !== 'string' || !LIGHT_LEAK_POSITIONS.has(o.position as LightLeakPosition)) {
    return undefined;
  }
  const radius = typeof o.radius === 'number' ? clampRange(o.radius, 0.2, 1) : 0.6;
  const blendMode =
    typeof o.blendMode === 'string' && TINT_BLEND_MODES.has(o.blendMode as ColorGradeBlend)
      ? (o.blendMode as ColorGradeBlend)
      : undefined;
  return {
    color: safeHexColor(typeof o.color === 'string' ? o.color : '#ffd28a', '#ffd28a'),
    intensity,
    radius,
    position: o.position as LightLeakPosition,
    ...(blendMode !== undefined ? { blendMode } : {}),
  };
}

function parseInnerGlowField(raw: unknown): InnerGlowConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const intensity = clampUnit(typeof o.intensity === 'number' ? o.intensity : 0);
  if (intensity === 0) return undefined;
  const radius = typeof o.radius === 'number' ? clampRange(o.radius, 0.3, 1.5) : 0.8;
  const blendMode =
    typeof o.blendMode === 'string' &&
    INNER_GLOW_BLEND_MODES.has(o.blendMode as 'screen' | 'overlay' | 'soft-light')
      ? (o.blendMode as 'screen' | 'overlay' | 'soft-light')
      : undefined;
  return {
    color: safeHexColor(typeof o.color === 'string' ? o.color : '#ffffff', '#ffffff'),
    intensity,
    radius,
    ...(blendMode !== undefined ? { blendMode } : {}),
  };
}

function parseDustField(raw: unknown): DustConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const intensity = clampUnit(typeof o.intensity === 'number' ? o.intensity : 0);
  const density = clampUnit(typeof o.density === 'number' ? o.density : 0);
  if (intensity === 0 || density === 0) return undefined;
  const seed =
    typeof o.seed === 'number' && Number.isFinite(o.seed) && o.seed >= 0 && o.seed <= 9999
      ? Math.round(o.seed)
      : undefined;
  return {
    color: safeHexColor(typeof o.color === 'string' ? o.color : '#ffffff', '#ffffff'),
    intensity,
    density,
    ...(seed !== undefined ? { seed } : {}),
  };
}

function parseHalftoneField(raw: unknown): HalftoneConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const opacity = clampUnit(typeof o.opacity === 'number' ? o.opacity : 0);
  if (opacity === 0) return undefined;
  const dotSize = typeof o.dotSize === 'number' ? clampRange(o.dotSize, 0.5, 10) : 1.5;
  const spacing = typeof o.spacing === 'number' ? clampRange(o.spacing, 2, 40) : 6;
  const blendMode =
    typeof o.blendMode === 'string' && HALFTONE_BLEND_MODES.has(o.blendMode as HalftoneBlend)
      ? (o.blendMode as HalftoneBlend)
      : 'multiply';
  const angle =
    typeof o.angle === 'number' && Number.isFinite(o.angle) && o.angle >= 0 && o.angle <= 90
      ? o.angle
      : undefined;
  return {
    color: safeHexColor(typeof o.color === 'string' ? o.color : '#000000', '#000000'),
    opacity,
    dotSize,
    spacing,
    blendMode,
    ...(angle !== undefined ? { angle } : {}),
  };
}

function parseLetterboxField(raw: unknown): LetterboxConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const side = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? clampRange(v, 0, 240) : 0;
  const top = side(o.top);
  const bottom = side(o.bottom);
  const left = side(o.left);
  const right = side(o.right);
  if (top === 0 && bottom === 0 && left === 0 && right === 0) return undefined;
  const opacity =
    typeof o.opacity === 'number' && Number.isFinite(o.opacity) ? clampUnit(o.opacity) : undefined;
  return {
    color: safeHexColor(typeof o.color === 'string' ? o.color : '#000000', '#000000'),
    top,
    bottom,
    left,
    right,
    ...(opacity !== undefined ? { opacity } : {}),
  };
}

function parseFrameField(raw: unknown): FrameConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const thickness =
    typeof o.thickness === 'number' && Number.isFinite(o.thickness)
      ? clampRange(o.thickness, 0, 40)
      : 0;
  if (thickness < 1) return undefined;
  const inset =
    typeof o.inset === 'number' && Number.isFinite(o.inset) ? clampRange(o.inset, 0, 80) : 0;
  const style =
    typeof o.style === 'string' && FRAME_STYLES.has(o.style as FrameStyle)
      ? (o.style as FrameStyle)
      : undefined;
  return {
    color: safeHexColor(typeof o.color === 'string' ? o.color : '#ffffff', '#ffffff'),
    thickness,
    inset,
    ...(style !== undefined ? { style } : {}),
  };
}

// ─── Filter pipeline ────────────────────────────────────────────────────────

/**
 * Apply a single image-wide filter. Returns a new PNG buffer.
 *
 * Implementation notes per filter:
 *  - `grayscale`: Sharp's native `.grayscale()` (uses BT.601 luma weights
 *    internally, matches what every other library produces).
 *  - `sepia`: `.recomb(SEPIA_MATRIX)` — the canonical 3x3 ITU-R sepia matrix.
 *  - `high-contrast`: `.linear(1.3, -38)` — slope-up + shift-down keeps mid-
 *    tones near where they were while pushing darks darker and highlights
 *    brighter. Empirically calibrated for thumbnail content (large flat
 *    fields of colour); finer-grained tone curves would be over-engineering.
 *  - `low-contrast`: `.linear(0.6, 51)` — slope-down + shift-up flattens
 *    everything toward middle gray. Lifts the blacks so the image reads as
 *    softer / hazier.
 *  - `invert`: `.negate({ alpha: false })` — flip RGB channels, leave alpha
 *    intact so the canvas stays opaque.
 */
export async function applyFilter(input: Buffer, filter: ImageFilter): Promise<Buffer> {
  const t0 = Date.now();
  let pipe = sharp(input, { limitInputPixels: SHARP_INPUT_PIXEL_CAP });
  switch (filter) {
    case 'grayscale':
      pipe = pipe.grayscale();
      break;
    case 'sepia':
      pipe = pipe.recomb(SEPIA_MATRIX);
      break;
    case 'high-contrast':
      pipe = pipe.linear(1.3, -38);
      break;
    case 'low-contrast':
      pipe = pipe.linear(0.6, 51);
      break;
    case 'invert':
      pipe = pipe.negate({ alpha: false });
      break;
  }
  const out = await pipe.png().toBuffer();
  console.info('[shared-overlay filter]', {
    filter,
    elapsed_ms: Date.now() - t0,
  });
  return out;
}

// ─── Vignette ───────────────────────────────────────────────────────────────

/**
 * Build the SVG markup for a radial vignette gradient.
 *
 * The gradient is centred on the canvas. From the center out to
 * `radius * 100%` of the canvas radius the fill is fully transparent (no
 * vignette effect). From `radius` to the corners the alpha ramps up
 * linearly to `intensity`.
 *
 * So `radius=0.5, intensity=0.5` means the inner half of the canvas is
 * untouched and the outer half fades to 50% colour at the corners.
 *
 * Exported for unit tests; production callers should go through
 * `applySharedOverlays`.
 */
export function buildVignetteSvg(
  width: number,
  height: number,
  color: string,
  intensity: number,
  radius: number,
): string {
  const safeColor = safeHexColor(color, '#000000');
  const safeIntensity = clampUnit(intensity);
  const safeRadius = clampRange(radius, 0, 1);
  // Inner stop sits at the "untouched" radius; outer stop at 100% reaches
  // full intensity. We deliberately keep both stops opaque-color with
  // different alphas — using stop-opacity on the inner stop is the cleanest
  // way to express "no effect inside this radius".
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <radialGradient id="v" cx="50%" cy="50%" r="75%">
        <stop offset="${safeRadius}" stop-color="${safeColor}" stop-opacity="0"/>
        <stop offset="1" stop-color="${safeColor}" stop-opacity="${safeIntensity}"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#v)"/>
  </svg>`;
}

// ─── Grain ──────────────────────────────────────────────────────────────────

/**
 * Build a grain noise PNG buffer sized to the canvas.
 *
 * `size` controls the grain particle scale. Internally we generate noise at
 * (width/size, height/size) and then resize up with nearest-neighbour to
 * keep the chunky-pixel look. Size 1 = single-pixel noise; size 5 = 5x5
 * blocks of identical noise.
 *
 * `monochrome` = true gives one random value per pixel (same R, G, B).
 * `monochrome` = false gives independent random R/G/B per pixel.
 *
 * Noise is generated by a seeded LCG so the output is deterministic. The
 * seed is intentionally fixed — we don't expose it as a config because
 * deterministic grain is preferable for caching: the same input config
 * always produces the same noise pattern.
 *
 * Exported for unit tests.
 */
export async function buildGrainOverlay(
  width: number,
  height: number,
  intensity: number,
  size: number,
  monochrome: boolean,
): Promise<Buffer> {
  const safeIntensity = clampUnit(intensity);
  const safeSize = clampRange(size, 0.5, 5);
  const safeMono = monochrome === true;

  // Tile dimensions before scaling up. Floor at 1 px so very small canvases
  // (test cases, tiny thumbnails) don't produce a zero-sized noise buffer.
  const tileW = Math.max(1, Math.floor(width / safeSize));
  const tileH = Math.max(1, Math.floor(height / safeSize));

  // Seeded LCG. Constants are the same Numerical Recipes set used by glibc
  // — well-distributed for our purposes. Fixed seed = deterministic output.
  let s = 0x1234_5678 >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 16) & 0xff;
  };

  // Build the raw buffer. Channels: 4 (RGBA) so we can carry the intensity
  // as alpha. Monochrome: same value into R/G/B with full alpha scaled to
  // intensity. Colour: independent R/G/B with full alpha scaled to intensity.
  const pixelCount = tileW * tileH;
  const buf = Buffer.alloc(pixelCount * 4);
  // Cap the alpha at intensity * 255; even the "loudest" grain pixel only
  // appears at intensity-scaled visibility. The randomness is in the colour
  // value, not the alpha — keeping alpha constant is what makes grain look
  // uniform rather than blotchy.
  const alpha = Math.round(safeIntensity * 255);
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    if (safeMono) {
      const v = next();
      buf[offset] = v;
      buf[offset + 1] = v;
      buf[offset + 2] = v;
    } else {
      buf[offset] = next();
      buf[offset + 1] = next();
      buf[offset + 2] = next();
    }
    buf[offset + 3] = alpha;
  }

  // Convert the raw buffer to a PNG at the tile size, then nearest-resize
  // up to the canvas size to preserve the chunky-pixel grain. `kernel:
  // 'nearest'` is critical — Sharp's default lanczos blur would smooth the
  // noise into a soft fog.
  const tilePng = await sharp(buf, {
    raw: { width: tileW, height: tileH, channels: 4 },
  })
    .png()
    .toBuffer();
  if (tileW === width && tileH === height) return tilePng;
  return await sharp(tilePng)
    .resize(width, height, { kernel: 'nearest' })
    .png()
    .toBuffer();
}

// ─── Title bar ──────────────────────────────────────────────────────────────

/**
 * Resolve the title bar's pixel rectangle given the canvas and the position
 * + heightFraction config. Exported for unit tests so the layout math can
 * be verified independently of the rendering.
 */
export function titleBarRect(
  canvasWidth: number,
  canvasHeight: number,
  position: TitleBarPosition,
  heightFraction: number,
): { x: number; y: number; w: number; h: number } {
  const safeFraction = clampRange(heightFraction, TITLE_BAR_MIN_HEIGHT_FRACTION, TITLE_BAR_MAX_HEIGHT_FRACTION);
  const h = Math.max(1, Math.round(canvasHeight * safeFraction));
  const isTop = position === 'top' || position === 'overlay-top';
  const y = isTop ? 0 : Math.max(0, canvasHeight - h);
  return { x: 0, y, w: canvasWidth, h };
}

/**
 * Resolve the alignment to a Pango alignment string. Used by both the
 * text rendering and the layout math. Sharp / Pango accept `'centre'`
 * (British spelling) as the canonical form — `'center'` works too but
 * we normalise to `'centre'` for consistency with the rest of the codebase.
 */
function pangoAlign(a: TitleAlignment): 'left' | 'centre' | 'right' {
  if (a === 'left') return 'left';
  if (a === 'right') return 'right';
  return 'centre';
}

/**
 * Render a piece of text at a target width with a given font. Returns the
 * PNG buffer plus its actual rendered height (Pango decides the height
 * based on font metrics + wrapping; the caller needs the height to lay out
 * vertical stacking).
 *
 * Pango doesn't take a font SIZE in our config — we derive the size from
 * the band height to keep the title bar visually balanced. The caller
 * passes `fontPt` directly.
 */
async function renderTextBuffer(
  text: string,
  width: number,
  align: TitleAlignment,
  font: FontRef,
  fontPt: number,
  color: string,
): Promise<{ buffer: Buffer; renderedHeight: number }> {
  const safeText = escapePangoText(text);
  const safeColor = safeHexColor(color, '#ffffff');
  const safeWidth = Math.max(16, Math.round(width));
  const safePt = Math.max(8, Math.round(fontPt));
  // Pango's `rgba` input renders coloured text directly — no second
  // recoloring step needed. We pass the color via Pango markup since
  // Sharp's text input takes a single font string.
  const markup = `<span foreground="${safeColor}">${safeText}</span>`;
  const buffer = await sharp({
    text: {
      text: markup,
      fontfile: font.filePath,
      font: `${font.family} ${safePt}`,
      align: pangoAlign(align),
      width: safeWidth,
      rgba: true,
      wrap: 'word',
    },
  })
    .png()
    .toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, renderedHeight: meta.height ?? 1 };
}

/**
 * Build the title bar overlay PNG. Returns the buffer plus the canvas-
 * relative top-left corner where it should be composited.
 *
 * Layout inside the bar:
 *   1. Background rectangle (full width, configured colour + opacity).
 *   2. Optional shadow layer for the text (rendered in shadow colour,
 *      blurred, composited at offset under the main text).
 *   3. Main title text, vertically centred (or topped if a subtitle exists).
 *   4. Optional subtitle text below the main title.
 *
 * Pango handles wrapping at the bar width. The text font size scales with
 * the bar height — empirically calibrated so a 10% bar at 1280×720 fits a
 * single line of caps text comfortably.
 */
export async function buildTitleBarOverlay(
  canvasWidth: number,
  canvasHeight: number,
  config: TitleBarConfig,
): Promise<{ buffer: Buffer; top: number; left: number }> {
  const t0 = Date.now();
  const rect = titleBarRect(canvasWidth, canvasHeight, config.position, config.heightFraction);

  // Padding inside the bar so text doesn't kiss the edges. ~3% of the bar
  // width keeps the layout breathable across canvas sizes.
  const padX = Math.max(8, Math.round(rect.w * 0.03));
  const padY = Math.max(4, Math.round(rect.h * 0.1));
  const textWidth = Math.max(16, rect.w - 2 * padX);

  // Font size proportional to bar height. The 0.45 fraction matches the
  // "comfortable single line" reading from the Topic Card Grid composite's
  // empirical calibration and gives the subtitle ~0.3 of the bar height.
  const hasSubtitle = !!config.subtitle && config.subtitle.trim().length > 0;
  const titlePt = hasSubtitle
    ? Math.max(10, Math.round(rect.h * 0.4))
    : Math.max(12, Math.round(rect.h * 0.45));
  const subtitlePt = hasSubtitle ? Math.max(8, Math.round(rect.h * 0.25)) : 0;

  const subtitleAlign: TitleAlignment =
    !config.subtitleAlign || config.subtitleAlign === 'match-title'
      ? config.align
      : config.subtitleAlign;

  const titleFont = config.font;
  const subtitleFont = config.subtitleFont ?? config.font;
  const subtitleColor = config.subtitleColor ?? config.textColor;

  // Build the background SVG. We deliberately use SVG over a Sharp-created
  // raw rect because SVG handles the colour + opacity declaratively and is
  // easier to verify in tests via XML inspection.
  const safeBg = safeHexColor(config.backgroundColor, '#000000');
  const safeBgOpacity = clampUnit(config.backgroundOpacity);
  const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.w}" height="${rect.h}"><rect width="${rect.w}" height="${rect.h}" fill="${safeBg}" fill-opacity="${safeBgOpacity}"/></svg>`;
  const bgPng = await sharp(Buffer.from(bgSvg)).png().toBuffer();

  // Render the title text.
  const title = await renderTextBuffer(
    config.text,
    textWidth,
    config.align,
    titleFont,
    titlePt,
    config.textColor,
  );

  // Render the subtitle text if any.
  let subtitle: { buffer: Buffer; renderedHeight: number } | null = null;
  if (hasSubtitle) {
    subtitle = await renderTextBuffer(
      config.subtitle!,
      textWidth,
      subtitleAlign,
      subtitleFont,
      subtitlePt,
      subtitleColor,
    );
  }

  // Vertical layout: if there's a subtitle, stack title above subtitle with
  // a small gap; otherwise center the title in the bar.
  const gap = hasSubtitle ? Math.max(2, Math.round(rect.h * 0.05)) : 0;
  const totalTextH = title.renderedHeight + (subtitle ? gap + subtitle.renderedHeight : 0);
  const titleTop = Math.max(padY, Math.round((rect.h - totalTextH) / 2));
  const subtitleTop = subtitle ? titleTop + title.renderedHeight + gap : 0;

  // Horizontal alignment offsets. Pango already aligns within its own
  // rendered buffer when we pass align + width, so the buffer's width is
  // exactly `textWidth`. We just composite at padX.
  const textLeft = padX;

  // Compose the final overlay PNG. Order: background -> shadow (if any) ->
  // title -> subtitle.
  const overlays: sharp.OverlayOptions[] = [
    { input: bgPng, top: 0, left: 0 },
  ];

  // Shadow handling. Render the title (and subtitle, if any) in the shadow
  // colour, blur, and composite at offset under the actual text. Skipped
  // entirely when opacity = 0 — saves a Pango render call.
  if (config.shadow && clampUnit(config.shadow.opacity) > 0) {
    const safeShadowColor = safeHexColor(config.shadow.color, '#000000');
    const safeShadowOpacity = clampUnit(config.shadow.opacity);
    const safeOffset = clampRange(config.shadow.offsetPx, 0, 48);
    // Sharp's blur takes a sigma value. Visual blur of N px ≈ sigma N/3
    // produces a Gaussian that fades over N pixels — empirically matches
    // CSS's `text-shadow: 0 0 Npx` look.
    const safeSigma = clampRange((config.shadow.blurPx || 0) / 3, 0.3, 32);

    const shadowTitle = await renderTextBuffer(
      config.text,
      textWidth,
      config.align,
      titleFont,
      titlePt,
      safeShadowColor,
    );
    // Apply alpha (multiplies the per-pixel alpha) before blurring so the
    // blur spreads the already-tinted-down shadow rather than a solid
    // colour that we then have to mask.
    const blurredTitle = await sharp(shadowTitle.buffer)
      .ensureAlpha()
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${textWidth}" height="${shadowTitle.renderedHeight}"><rect width="${textWidth}" height="${shadowTitle.renderedHeight}" fill="white" fill-opacity="${safeShadowOpacity}"/></svg>`,
          ),
          blend: 'dest-in',
        },
      ])
      .blur(safeSigma > 0.3 ? safeSigma : 0.3)
      .png()
      .toBuffer();
    overlays.push({
      input: blurredTitle,
      top: titleTop + safeOffset,
      left: textLeft + safeOffset,
    });

    if (subtitle) {
      const shadowSub = await renderTextBuffer(
        config.subtitle!,
        textWidth,
        subtitleAlign,
        subtitleFont,
        subtitlePt,
        safeShadowColor,
      );
      const blurredSub = await sharp(shadowSub.buffer)
        .ensureAlpha()
        .composite([
          {
            input: Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${textWidth}" height="${shadowSub.renderedHeight}"><rect width="${textWidth}" height="${shadowSub.renderedHeight}" fill="white" fill-opacity="${safeShadowOpacity}"/></svg>`,
            ),
            blend: 'dest-in',
          },
        ])
        .blur(safeSigma > 0.3 ? safeSigma : 0.3)
        .png()
        .toBuffer();
      overlays.push({
        input: blurredSub,
        top: subtitleTop + safeOffset,
        left: textLeft + safeOffset,
      });
    }
  }

  overlays.push({ input: title.buffer, top: titleTop, left: textLeft });
  if (subtitle) {
    overlays.push({ input: subtitle.buffer, top: subtitleTop, left: textLeft });
  }

  const finalOverlay = await sharp({
    create: { width: rect.w, height: rect.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(overlays)
    .png()
    .toBuffer();

  console.info('[shared-overlay title-bar]', {
    position: config.position,
    height_fraction: clampRange(config.heightFraction, TITLE_BAR_MIN_HEIGHT_FRACTION, TITLE_BAR_MAX_HEIGHT_FRACTION),
    text_length: config.text.length,
    subtitle_length: config.subtitle?.length ?? 0,
    align: config.align,
    font_family: titleFont.family,
    has_shadow: !!config.shadow,
    elapsed_ms: Date.now() - t0,
  });

  return { buffer: finalOverlay, top: rect.y, left: rect.x };
}

// ─── r2.8 finishing overlay builders ────────────────────────────────────────

/** Escape the same three XML control chars that would otherwise let a
 *  user-supplied colour string break out of the SVG attribute context.
 *  All r2.8 builders inline colour values into SVG attributes, so this
 *  is load-bearing for the validator's tolerance posture (malformed
 *  colours fall back via safeHexColor at parse time, but the escape is
 *  defense-in-depth). */
function escapeSvgText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Luminance check used by the dust overlay to auto-pick its blend mode.
 *  Light specks layer additively (`screen` lifts the underlying tone);
 *  dark specks layer subtractively (`multiply` darkens). Mirrors the
 *  flex-icon-grid implementation. */
function isLightHex(hex: string): boolean {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return true;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
}

/** Compute the rect stroke positions for the `frame` overlay. `solid` /
 *  `dashed` return one centred stroke; `double` returns two parallel
 *  strokes with a gap. Mirrored from `flex-icon-grid.ts`'s
 *  `computeFrameRects` so the visual is identical across formats. */
export function computeFrameRects(
  canvasW: number,
  canvasH: number,
  inset: number,
  thickness: number,
  style: FrameStyle,
): { x: number; y: number; w: number; h: number; strokeWidth: number }[] {
  if (style === 'double') {
    const gap = Math.max(1, thickness * 0.4);
    const lineThickness = Math.max(1, (thickness - gap) / 2);
    const out: { x: number; y: number; w: number; h: number; strokeWidth: number }[] = [];
    const outerOffset = inset + lineThickness / 2;
    const outerW = canvasW - 2 * outerOffset;
    const outerH = canvasH - 2 * outerOffset;
    if (outerW > 0 && outerH > 0) {
      out.push({ x: outerOffset, y: outerOffset, w: outerW, h: outerH, strokeWidth: lineThickness });
    }
    const innerOffset = inset + lineThickness + gap + lineThickness / 2;
    const innerW = canvasW - 2 * innerOffset;
    const innerH = canvasH - 2 * innerOffset;
    if (innerW > 0 && innerH > 0) {
      out.push({ x: innerOffset, y: innerOffset, w: innerW, h: innerH, strokeWidth: lineThickness });
    }
    return out;
  }
  const offset = inset + thickness / 2;
  const w = canvasW - 2 * offset;
  const h = canvasH - 2 * offset;
  if (w <= 0 || h <= 0) return [];
  return [{ x: offset, y: offset, w, h, strokeWidth: thickness }];
}

/** Build one or more flat-colour overlays for the tint pass. Returns the
 *  base wash plus optional split-tone shadows / highlights, each as a
 *  separate composite step with its own blend mode. The base wash always
 *  exists; the split-tone layers are gated on the config. */
export async function buildTintOverlays(
  canvasWidth: number,
  canvasHeight: number,
  config: TintConfig,
): Promise<sharp.OverlayOptions[]> {
  const overlays: sharp.OverlayOptions[] = [];
  const makeFlat = async (color: string, alpha: number): Promise<Buffer> => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}"><rect width="${canvasWidth}" height="${canvasHeight}" fill="${escapeSvgText(color)}" fill-opacity="${alpha}"/></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  };
  overlays.push({
    input: await makeFlat(config.color, config.intensity),
    top: 0,
    left: 0,
    blend: config.blendMode,
  });
  const splitStrength = config.splitToneStrength ?? 0.5;
  if (config.shadows) {
    overlays.push({
      input: await makeFlat(config.shadows, config.intensity * splitStrength),
      top: 0,
      left: 0,
      blend: 'multiply',
    });
  }
  if (config.highlights) {
    overlays.push({
      input: await makeFlat(config.highlights, config.intensity * splitStrength),
      top: 0,
      left: 0,
      blend: 'screen',
    });
  }
  return overlays;
}

/** Light leak — radial gradient anchored on one canvas edge so half the
 *  colour bleeds off-canvas, mirroring real lens leaks. Composited with
 *  the configured blend (default `screen`). */
export async function buildLightLeakOverlay(
  canvasWidth: number,
  canvasHeight: number,
  config: LightLeakConfig,
): Promise<sharp.OverlayOptions> {
  const halfMin = Math.min(canvasWidth, canvasHeight) / 2;
  const r = config.radius * halfMin;
  const anchors: Record<LightLeakPosition, { cx: number; cy: number }> = {
    'top-left': { cx: 0, cy: 0 },
    'top-right': { cx: canvasWidth, cy: 0 },
    'bottom-left': { cx: 0, cy: canvasHeight },
    'bottom-right': { cx: canvasWidth, cy: canvasHeight },
    top: { cx: canvasWidth / 2, cy: 0 },
    bottom: { cx: canvasWidth / 2, cy: canvasHeight },
    left: { cx: 0, cy: canvasHeight / 2 },
    right: { cx: canvasWidth, cy: canvasHeight / 2 },
  };
  const { cx, cy } = anchors[config.position];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}"><defs><radialGradient id="ll" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0%" stop-color="${escapeSvgText(config.color)}" stop-opacity="${config.intensity}"/><stop offset="100%" stop-color="${escapeSvgText(config.color)}" stop-opacity="0"/></radialGradient></defs><rect width="${canvasWidth}" height="${canvasHeight}" fill="url(#ll)"/></svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { input: buf, top: 0, left: 0, blend: config.blendMode ?? 'screen' };
}

/** Inner glow — radial gradient centred on the canvas. Default blend
 *  `screen` lifts the centre rather than tinting it. */
export async function buildInnerGlowOverlay(
  canvasWidth: number,
  canvasHeight: number,
  config: InnerGlowConfig,
): Promise<sharp.OverlayOptions> {
  const cx = canvasWidth / 2;
  const cy = canvasHeight / 2;
  const halfMin = Math.min(canvasWidth, canvasHeight) / 2;
  const r = config.radius * halfMin;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}"><defs><radialGradient id="ig" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0%" stop-color="${escapeSvgText(config.color)}" stop-opacity="${config.intensity}"/><stop offset="100%" stop-color="${escapeSvgText(config.color)}" stop-opacity="0"/></radialGradient></defs><rect width="${canvasWidth}" height="${canvasHeight}" fill="url(#ig)"/></svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { input: buf, top: 0, left: 0, blend: config.blendMode ?? 'screen' };
}

/** Dust / scratches — feTurbulence + threshold + flood pipeline producing
 *  sparse, irregular specks. Auto-picks `screen` for light specks and
 *  `multiply` for dark, so the underlying tone is preserved instead of
 *  being flatly painted over. */
export async function buildDustOverlay(
  canvasWidth: number,
  canvasHeight: number,
  config: DustConfig,
): Promise<sharp.OverlayOptions> {
  const seed = config.seed ?? 41;
  const baseFreq = 0.55;
  const threshold = 0.95 - config.density * 0.45;
  const intercept = -threshold;
  const slope = 1 / Math.max(0.05, 1 - threshold);
  const turbulence = `<feTurbulence type="fractalNoise" baseFrequency="${baseFreq.toFixed(4)}" numOctaves="2" seed="${seed}" stitchTiles="stitch" result="rawNoise"/>`;
  const seamSoftener = `<feGaussianBlur in="rawNoise" stdDeviation="1.2" result="noise"/>`;
  const thresholded =
    `<feComponentTransfer in="noise" result="peaks">` +
    `<feFuncR type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>` +
    `<feFuncG type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>` +
    `<feFuncB type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>` +
    `<feFuncA type="linear" slope="${slope.toFixed(3)}" intercept="${intercept.toFixed(3)}"/>` +
    `</feComponentTransfer>`;
  const flood = `<feFlood flood-color="${escapeSvgText(config.color)}" flood-opacity="1" result="speck-colour"/>`;
  const composite = `<feComposite in="speck-colour" in2="peaks" operator="in" result="specks"/>`;
  const alphaMatrix = `<feColorMatrix in="specks" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${config.intensity.toFixed(3)} 0"/>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">`,
    `<defs><filter id="dust" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse">`,
    turbulence,
    seamSoftener,
    thresholded,
    flood,
    composite,
    alphaMatrix,
    `</filter></defs>`,
    `<rect width="${canvasWidth}" height="${canvasHeight}" fill="transparent" filter="url(#dust)"/>`,
    `</svg>`,
  ].join('');
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const blend: 'screen' | 'multiply' = isLightHex(config.color) ? 'screen' : 'multiply';
  return { input: buf, top: 0, left: 0, blend };
}

/** Halftone — uniform dot pattern via SVG `<pattern>`. `normal` blend
 *  paints flat (with the per-dot opacity); the other four blends layer
 *  with the canvas like the tint overlay does. */
export async function buildHalftoneOverlay(
  canvasWidth: number,
  canvasHeight: number,
  config: HalftoneConfig,
): Promise<sharp.OverlayOptions> {
  const tile = config.spacing;
  const cx = tile / 2;
  const cy = tile / 2;
  const angle = config.angle ?? 0;
  const transformAttr = angle !== 0 ? ` patternTransform="rotate(${angle.toFixed(2)})"` : '';
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">`,
    `<defs><pattern id="ht" patternUnits="userSpaceOnUse" width="${tile}" height="${tile}"${transformAttr}>`,
    `<circle cx="${cx}" cy="${cy}" r="${config.dotSize}" fill="${escapeSvgText(config.color)}" fill-opacity="${config.opacity}"/>`,
    `</pattern></defs>`,
    `<rect width="${canvasWidth}" height="${canvasHeight}" fill="url(#ht)"/>`,
    `</svg>`,
  ].join('');
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const blend: 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'over' =
    config.blendMode === 'normal' ? 'over' : config.blendMode;
  return { input: buf, top: 0, left: 0, blend };
}

/** Letterbox — up to four solid coloured bars on each canvas edge.
 *  Composited with the default blend so the bars sit ON TOP of
 *  everything beneath them (hides the underlying pixels). */
export async function buildLetterboxOverlay(
  canvasWidth: number,
  canvasHeight: number,
  config: LetterboxConfig,
): Promise<sharp.OverlayOptions | null> {
  const bars: string[] = [];
  const fill = escapeSvgText(config.color);
  const opacity = config.opacity ?? 1;
  const opacityAttr = opacity < 1 ? ` fill-opacity="${opacity}"` : '';
  if (config.top > 0)
    bars.push(`<rect x="0" y="0" width="${canvasWidth}" height="${config.top}" fill="${fill}"${opacityAttr}/>`);
  if (config.bottom > 0)
    bars.push(
      `<rect x="0" y="${canvasHeight - config.bottom}" width="${canvasWidth}" height="${config.bottom}" fill="${fill}"${opacityAttr}/>`,
    );
  if (config.left > 0)
    bars.push(`<rect x="0" y="0" width="${config.left}" height="${canvasHeight}" fill="${fill}"${opacityAttr}/>`);
  if (config.right > 0)
    bars.push(
      `<rect x="${canvasWidth - config.right}" y="0" width="${config.right}" height="${canvasHeight}" fill="${fill}"${opacityAttr}/>`,
    );
  if (bars.length === 0) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">${bars.join('')}</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { input: buf, top: 0, left: 0 };
}

/** Frame — single outer stroke (solid/dashed) or double parallel strokes.
 *  Composited with the default blend so the stroke sits on top. */
export async function buildFrameOverlay(
  canvasWidth: number,
  canvasHeight: number,
  config: FrameConfig,
): Promise<sharp.OverlayOptions | null> {
  const style = config.style ?? 'solid';
  const rects = computeFrameRects(canvasWidth, canvasHeight, config.inset, config.thickness, style);
  if (rects.length === 0) return null;
  const dashAttr =
    style === 'dashed'
      ? ` stroke-dasharray="${(config.thickness * 2).toFixed(2)} ${(config.thickness * 1.5).toFixed(2)}"`
      : '';
  const rectEls = rects
    .map(
      (r) =>
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="${escapeSvgText(config.color)}" stroke-width="${r.strokeWidth}"${dashAttr}/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">${rectEls}</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { input: buf, top: 0, left: 0 };
}

// ─── Pipeline entry ─────────────────────────────────────────────────────────

/**
 * Top-level pipeline entry. Runs the four operations in order: filter,
 * vignette, grain, title bar. Each step is skipped when its config is
 * absent or its intensity is 0, so an empty `SharedOverlayInput` returns
 * the base image re-encoded as PNG (no visual change).
 *
 * Output is always PNG. Re-encoding the base image once (even when no
 * overlays apply) keeps the return type predictable and means the caller
 * doesn't have to special-case "no-op" vs "applied".
 */
export async function applySharedOverlays(input: SharedOverlayInput): Promise<Buffer> {
  const { baseImage, canvas, postProcess, titleBar } = input;
  const t0 = Date.now();

  // Step 1: filter. Replaces the working buffer if applied; otherwise we
  // start from the raw base image.
  let working = baseImage;
  if (postProcess?.filter) {
    working = await applyFilter(working, postProcess.filter);
  }

  // Steps 2-3: vignette + grain. Both build overlay PNGs that get
  // composited onto the working buffer in one Sharp call. Accumulating
  // them in one composite (instead of two separate decode + encode steps)
  // saves one full image round-trip.
  const postOverlays: sharp.OverlayOptions[] = [];

  if (postProcess?.vignette && clampUnit(postProcess.vignette.intensity) > 0) {
    const t1 = Date.now();
    const svg = buildVignetteSvg(
      canvas.width,
      canvas.height,
      postProcess.vignette.color,
      postProcess.vignette.intensity,
      postProcess.vignette.radius,
    );
    const vignettePng = await sharp(Buffer.from(svg)).png().toBuffer();
    postOverlays.push({ input: vignettePng, top: 0, left: 0 });
    console.info('[shared-overlay vignette]', {
      color: postProcess.vignette.color,
      intensity: postProcess.vignette.intensity,
      radius: postProcess.vignette.radius,
      elapsed_ms: Date.now() - t1,
    });
  }

  // r2.8 finishing overlays — applied AFTER vignette and BEFORE grain so
  // the colour-grade layers (tint, light leak, inner glow) react to the
  // base colour AS IT WAS GRADED, and grain sits visually on top of the
  // graded image. Order WITHIN the colour-grade group: tint (flat wash)
  // → light leak (off-canvas radial) → inner glow (centred radial) →
  // dust (textured specks) → halftone (uniform dot pattern). Letterbox
  // + frame run LAST so they sit on top of grain too (they're framing,
  // not grading).
  if (postProcess?.tint) {
    const t1 = Date.now();
    const tintOverlays = await buildTintOverlays(canvas.width, canvas.height, postProcess.tint);
    for (const o of tintOverlays) postOverlays.push(o);
    console.info('[shared-overlay tint]', {
      color: postProcess.tint.color,
      intensity: postProcess.tint.intensity,
      blend: postProcess.tint.blendMode,
      has_shadows: !!postProcess.tint.shadows,
      has_highlights: !!postProcess.tint.highlights,
      elapsed_ms: Date.now() - t1,
    });
  }
  if (postProcess?.lightLeak) {
    const t1 = Date.now();
    postOverlays.push(
      await buildLightLeakOverlay(canvas.width, canvas.height, postProcess.lightLeak),
    );
    console.info('[shared-overlay light-leak]', {
      position: postProcess.lightLeak.position,
      color: postProcess.lightLeak.color,
      intensity: postProcess.lightLeak.intensity,
      blend: postProcess.lightLeak.blendMode ?? 'screen',
      elapsed_ms: Date.now() - t1,
    });
  }
  if (postProcess?.innerGlow) {
    const t1 = Date.now();
    postOverlays.push(
      await buildInnerGlowOverlay(canvas.width, canvas.height, postProcess.innerGlow),
    );
    console.info('[shared-overlay inner-glow]', {
      color: postProcess.innerGlow.color,
      intensity: postProcess.innerGlow.intensity,
      radius: postProcess.innerGlow.radius,
      blend: postProcess.innerGlow.blendMode ?? 'screen',
      elapsed_ms: Date.now() - t1,
    });
  }
  if (postProcess?.dust) {
    const t1 = Date.now();
    postOverlays.push(await buildDustOverlay(canvas.width, canvas.height, postProcess.dust));
    console.info('[shared-overlay dust]', {
      color: postProcess.dust.color,
      intensity: postProcess.dust.intensity,
      density: postProcess.dust.density,
      seed: postProcess.dust.seed ?? 41,
      elapsed_ms: Date.now() - t1,
    });
  }
  if (postProcess?.halftone) {
    const t1 = Date.now();
    postOverlays.push(
      await buildHalftoneOverlay(canvas.width, canvas.height, postProcess.halftone),
    );
    console.info('[shared-overlay halftone]', {
      color: postProcess.halftone.color,
      opacity: postProcess.halftone.opacity,
      dot_size: postProcess.halftone.dotSize,
      spacing: postProcess.halftone.spacing,
      blend: postProcess.halftone.blendMode,
      angle: postProcess.halftone.angle ?? 0,
      elapsed_ms: Date.now() - t1,
    });
  }

  if (postProcess?.grain && clampUnit(postProcess.grain.intensity) > 0) {
    const t1 = Date.now();
    const grainPng = await buildGrainOverlay(
      canvas.width,
      canvas.height,
      postProcess.grain.intensity,
      postProcess.grain.size,
      postProcess.grain.monochrome,
    );
    postOverlays.push({ input: grainPng, top: 0, left: 0, blend: 'overlay' });
    console.info('[shared-overlay grain]', {
      intensity: postProcess.grain.intensity,
      size: postProcess.grain.size,
      monochrome: postProcess.grain.monochrome,
      elapsed_ms: Date.now() - t1,
    });
  }

  if (postProcess?.letterbox) {
    const t1 = Date.now();
    const letterbox = await buildLetterboxOverlay(
      canvas.width,
      canvas.height,
      postProcess.letterbox,
    );
    if (letterbox) postOverlays.push(letterbox);
    console.info('[shared-overlay letterbox]', {
      color: postProcess.letterbox.color,
      top: postProcess.letterbox.top,
      bottom: postProcess.letterbox.bottom,
      left: postProcess.letterbox.left,
      right: postProcess.letterbox.right,
      opacity: postProcess.letterbox.opacity ?? 1,
      elapsed_ms: Date.now() - t1,
    });
  }
  if (postProcess?.frame) {
    const t1 = Date.now();
    const frame = await buildFrameOverlay(canvas.width, canvas.height, postProcess.frame);
    if (frame) postOverlays.push(frame);
    console.info('[shared-overlay frame]', {
      color: postProcess.frame.color,
      thickness: postProcess.frame.thickness,
      inset: postProcess.frame.inset,
      style: postProcess.frame.style ?? 'solid',
      elapsed_ms: Date.now() - t1,
    });
  }

  if (postOverlays.length > 0) {
    working = await sharp(working, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
      .composite(postOverlays)
      .png()
      .toBuffer();
  }

  // Step 4: title bar. Built as a separate composite call because it's
  // visually on top and we want it as a single overlay (not interleaved
  // with post-process).
  if (titleBar) {
    const overlay = await buildTitleBarOverlay(canvas.width, canvas.height, titleBar);
    working = await sharp(working, { limitInputPixels: SHARP_INPUT_PIXEL_CAP })
      .composite([{ input: overlay.buffer, top: overlay.top, left: overlay.left }])
      .png()
      .toBuffer();
  }

  // No overlays at all — re-encode to PNG so the caller's contract is
  // stable. This is a single decode + encode of the base image.
  if (!postProcess?.filter && postOverlays.length === 0 && !titleBar) {
    return await sharp(baseImage, { limitInputPixels: SHARP_INPUT_PIXEL_CAP }).png().toBuffer();
  }

  console.info('[shared-overlay applied]', {
    filter: postProcess?.filter ?? null,
    vignette: !!postProcess?.vignette && clampUnit(postProcess.vignette.intensity) > 0,
    tint: !!postProcess?.tint,
    light_leak: !!postProcess?.lightLeak,
    inner_glow: !!postProcess?.innerGlow,
    dust: !!postProcess?.dust,
    halftone: !!postProcess?.halftone,
    grain: !!postProcess?.grain && clampUnit(postProcess.grain.intensity) > 0,
    letterbox: !!postProcess?.letterbox,
    frame: !!postProcess?.frame,
    title_bar: !!titleBar,
    total_elapsed_ms: Date.now() - t0,
  });

  return working;
}
