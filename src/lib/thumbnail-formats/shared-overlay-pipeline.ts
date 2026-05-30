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

export interface PostProcessConfig {
  filter?: ImageFilter;
  vignette?: VignetteConfig;
  grain?: GrainConfig;
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

  // Empty out means none of the three operations would do anything visible.
  // Return null so the route layer can pass undefined down to the pipeline
  // and skip the post-process composite entirely.
  if (!out.filter && !out.vignette && !out.grain) return null;
  return out;
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
    grain: !!postProcess?.grain && clampUnit(postProcess.grain.intensity) > 0,
    title_bar: !!titleBar,
    total_elapsed_ms: Date.now() - t0,
  });

  return working;
}
