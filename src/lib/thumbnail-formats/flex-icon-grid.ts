/**
 * Flex Icon Grid — pure module
 *
 * Format that produces a YouTube thumbnail as a configurable N×M grid of
 * cells, each containing a single iconic subject on a bright solid-colour
 * background. The aesthetic that wins on `The Paint Explainer`, `The
 * Evaluator`, `EverythingProfessor` and `Byte Sized Explainer` — bright
 * flat cells, chunky bold labels, no photoreal rendering.
 *
 * Unlike `topic-card-grid` and `n-levels`, this format does NOT generate
 * pixels with an image model. Every cell is composed deterministically
 * server-side with SVG + Sharp. Icons come from a built-in curated
 * library (`flex-icon-grid-icons.ts`), user uploads, emoji, or text-only
 * cells. The composition path lives in `flex-icon-grid-composer.ts`.
 *
 * Pure module: no network, no React, no Next.js, no `sharp` — only string
 * + math + a deterministic uuid generator (injected by the caller so tests
 * stay deterministic). Everything here is unit-testable.
 *
 * Public surfaces:
 *  - Config types: `FlexIconGridConfig`, `FlexIconCell`, `CellContent`,
 *    `LabelStyle`, `RingStyle`, `BackgroundSpec`, `TitleBarSpec`.
 *  - `makeDefaultConfig(rows, cols)` — builds a sensible starter config.
 *  - `computeCellRect(layout, cellIndex)` — full cell bounding box.
 *  - `computeRegions(config, mkId)` — region rectangles for the rendered
 *    grid, used downstream by production-doc.
 *  - `validateConfig(config)` — pre-render shape check with actionable
 *    error reasons.
 *  - `escapeSvgText(s)` — boundary escape applied to every user-provided
 *    string before it's interpolated into SVG markup.
 *  - `parseConfig(raw)` — defensive JSON normaliser for restoring history
 *    entries that may pre-date a field addition.
 *
 * Naming: every public symbol is prefixed mentally with "flex-icon-grid"
 * — same convention the sibling format modules follow.
 */

import type { ThumbnailRegion } from '@/remotion/types';

// ─── Cell shape ─────────────────────────────────────────────────────────────

/**
 * Visual shape of each cell's icon background. The reference channels
 * mostly use circles (`The Paint Explainer`'s 5×3 grid is all discs); the
 * 2×3 layouts on `BoNa` and `Byte Sized Explainer` use rounded-square or
 * pure-square cells. Phase 1 ships these three; hexagon and pill arrive
 * in Phase 2 (see plan).
 */
export type CellShape =
  | 'circle'
  | 'square'
  | 'rounded-square'
  | 'hexagon'
  | 'pill'
  | 'capsule';

/**
 * The full shape enumeration. New shapes append to this union; the
 * composer dispatches on the literal value, so unknown values are an
 * explicit error rather than a silent fallback.
 *
 * Phase 1 shipped circle / square / rounded-square. Phase 2 adds
 * hexagon (flat-top regular hexagon inscribed in the cell square),
 * pill (vertical capsule, narrower than the cell), and capsule
 * (horizontal capsule, shorter than the cell).
 */
export const SUPPORTED_CELL_SHAPES: readonly CellShape[] = [
  'circle',
  'square',
  'rounded-square',
  'hexagon',
  'pill',
  'capsule',
] as const;

// ─── Cell content ───────────────────────────────────────────────────────────

/**
 * What lives inside the cell's icon area. Discriminated union so the
 * composer can exhaustively dispatch on `type` and the editor UI can
 * render the right per-type form. Each variant carries ONLY the fields it
 * needs — narrow on purpose so the wire format stays small in history.
 */
/** Phase 4.34: image fit mode for upload + ai-sticker cells.
 *  - `'cover'` (default): crops to fill the shape, may lose edges.
 *  - `'contain'`: whole image visible inside the shape, may show
 *    transparent padding at top/bottom or left/right.
 *  - `'fill'`: stretches the image to fill the shape exactly,
 *    distorts aspect ratio. Useful for textures that should tile
 *    seamlessly without crop.
 * Pre-4.34 thumbnails (no `fit` field) render exactly the same as
 * before — the default is `'cover'`. */
export type ImageFitMode = 'cover' | 'contain' | 'fill';

/** Phase 4.36: image filter mode for upload + ai-sticker cells.
 *  Renders via Sharp post-resize on the server and CSS `filter` in
 *  the live preview. All modes use approximately matching parameters
 *  (e.g. Sharp's `.greyscale()` ≈ CSS `grayscale(1)`).
 *  - `'none'` (default): no filter
 *  - `'grayscale'`: full desaturation
 *  - `'sepia'`: warm-tinted desaturation
 *  - `'high-contrast'`: contrast boost
 *  - `'low-contrast'`: contrast reduction (washed-out look)
 *  - `'invert'`: colour inversion */
export type ImageFilterMode =
  | 'none'
  | 'grayscale'
  | 'sepia'
  | 'high-contrast'
  | 'low-contrast'
  | 'invert';

export const SUPPORTED_IMAGE_FILTERS: readonly ImageFilterMode[] = [
  'none',
  'grayscale',
  'sepia',
  'high-contrast',
  'low-contrast',
  'invert',
] as const;

export type CellContent =
  | { type: 'icon-library'; name: string }
  | { type: 'emoji'; char: string }
  | { type: 'upload'; url: string; fit?: ImageFitMode; filter?: ImageFilterMode }
  | { type: 'text-only' }
  | { type: 'ai-sticker'; prompt: string; url?: string; style?: string; fit?: ImageFitMode; filter?: ImageFilterMode };

/** Phase 2 enumeration. `ai-sticker` arrives in Phase 2D — carries a
 *  user-supplied prompt and (once generated) the URL of the cropped
 *  sticker image. Pre-generation, the cell renders a placeholder. */
export const SUPPORTED_CONTENT_TYPES: readonly CellContent['type'][] = [
  'icon-library',
  'emoji',
  'upload',
  'text-only',
  'ai-sticker',
] as const;

// ─── Label / ring styles ────────────────────────────────────────────────────

/**
 * Bundled label font families. Stored as a closed enum so the composer
 * can resolve to a known TTF path and the live preview can resolve to a
 * known CSS family name. Adding a new font means: drop the TTF into
 * `public/fonts/flex-icon-grid/`, register a CSS @font-face in the panel
 * stylesheet, and append the family name here.
 *
 * `patrick-hand` is a passthrough to the existing
 * `public/fonts/PatrickHand-Regular.ttf` — included so users can match
 * the hand-drawn label aesthetic of the Topic Card Grid format. The
 * other three (Anton, Bowlby One, Archivo Black) get bundled fresh
 * under `public/fonts/flex-icon-grid/`.
 */
export type LabelFont =
  | 'anton'
  | 'bowlby-one'
  | 'archivo-black'
  | 'patrick-hand'
  | 'custom';

/**
 * Phase 1 fonts are bundled TTFs the composer resolves from disk.
 * Phase 4.7 adds the `'custom'` variant — the actual font URL lives
 * in the cell's `LabelStyle.customFontUrl` field; the composer fetches
 * the TTF at render time and Sharp's text input loads it via a temp
 * file. Live preview registers it via the FontFace API.
 */
export const SUPPORTED_LABEL_FONTS: readonly LabelFont[] = [
  'anton',
  'bowlby-one',
  'archivo-black',
  'patrick-hand',
  'custom',
] as const;

/** How the label text is cased before rendering. `as-typed` preserves
 *  the user's literal input — used for proper nouns ("RAT" stays RAT,
 *  "macOS" stays macOS). */
export type LabelCase = 'upper' | 'title' | 'as-typed';

/**
 * Label rendering knobs, scoped per cell. The composer falls back to
 * `FlexIconGridConfig.defaultLabel` for any missing field, so a per-cell
 * override only needs to carry what it actually changes.
 *
 * `position` controls where the label sits relative to the icon shape:
 *   - `below`: label band underneath the shape (the reference default).
 *   - `above`: label band above (rare; useful for inverted grids).
 *   - `overlay`: label painted across the shape's bottom third with a
 *     contrasting background strip behind it (the BoNa pattern).
 *   - `hidden`: no label rendered, the shape fills the whole cell.
 */
export interface LabelStyle {
  position: 'below' | 'above' | 'overlay' | 'hidden';
  font: LabelFont;
  case: LabelCase;
  color: string;            // CSS hex (#RRGGBB) — composer validates
  stroke?: { color: string; thickness: number } | null;
  /** Max label lines before the renderer truncates with an ellipsis.
   *  Set to 1 for the chunky single-word reference look; 2 lets long
   *  category names like "SCAREWARE" wrap if they overflow at the chosen
   *  font size. */
  maxLines: 1 | 2;
  /** Required when `font === 'custom'`. R2-hosted TTF/OTF/WOFF URL
   *  uploaded by the user. The composer fetches the bytes at render
   *  time and writes a temp file for Sharp's text input; the live
   *  preview registers it via the FontFace API. Ignored for any
   *  other font value. Phase 4.7 add. */
  customFontUrl?: string;
  /** Optional human-readable name for the custom font shown in the
   *  picker chip. Free-text — sanitised before display. */
  customFontLabel?: string;
  /** Phase 4.32: optional drop shadow applied to the label glyphs
   *  themselves. Reuses the per-cell `ShadowStyle` shape so the
   *  parser + validator paths stay the same. Renders via the
   *  same Sharp pipeline as the title text shadow on the
   *  rendered PNG and an SVG filter in the live preview. */
  textShadow?: ShadowStyle;
}

/**
 * Inner ring drawn between the cell background and the icon. The
 * reference grids all have a thick black ring around each disc — that's
 * what makes the icon look like a sticker on the cell rather than a
 * raster painted directly on the colour. `null` disables the ring.
 */
export type RingStyle = { color: string; thickness: number; style: 'solid' | 'dashed' } | null;

/**
 * Phase 4.12: optional corner badge — a small text chip painted on
 * one corner of the cell. Common YouTube patterns: numeric ranks
 * ("1", "2", "3" in top-left), status flags ("NEW", "HOT", "TOP"
 * in top-right), or category tags. Off by default — the reference
 * channels rarely use them, but they're invaluable for ranked-list
 * thumbnails ("Top 10 X").
 *
 *   text       short label (capped at 8 chars so a "NEW" or numeric
 *              rank fits comfortably on every cell size).
 *   corner     one of four positions in cell-relative space.
 *   background pill colour (hex).
 *   color      text colour (hex).
 *
 * Renders as a rounded pill with the text vertically centered, sized
 * proportionally with the cell so it stays legible across grid sizes.
 */
export type BadgeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const SUPPORTED_BADGE_CORNERS: readonly BadgeCorner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

export interface BadgeStyle {
  text: string;
  corner: BadgeCorner;
  background: string;
  color: string;
  /** Phase 4.13: optional badge font override. Falls back to Anton
   *  (chunky, reads at small sizes) when undefined — the right
   *  default for numeric-rank / status-flag use. A workspace-
   *  registered custom font lets a brand-aware badge match the
   *  thumbnail's overall typography. */
  font?: LabelFont;
  /** Phase 4.13: required when `font === 'custom'`. Same shape as
   *  `LabelStyle.customFontUrl` — composer fetches via the byte
   *  cache, browser registers via FontFace. */
  customFontUrl?: string;
  /** Phase 4.13: display label for the registered-font chip. */
  customFontLabel?: string;
}

/**
 * Phase 4.11: optional drop shadow under the cell's icon shape. Paints
 * a soft cast underneath the disc/square so the cell reads as a
 * sticker lifted off the canvas. Off by default — the reference flat-
 * cell channels don't use it, but the "paper sticker" aesthetic
 * (Paint Explainer's animated thumbs, Byte Sized Explainer's hero
 * cells) does.
 *
 *   offsetY  vertical offset in cell-relative pixels at the reference
 *            1280×720 canvas. Composer scales this proportionally
 *            with the cell width so a shadow looks consistent across
 *            grid sizes.
 *   blur     stdDeviation passed to the SVG <feGaussianBlur>. Small
 *            integer; cell-relative, scaled like offsetY.
 *   color    RGB hex (#RRGGBB) — opacity is carried separately so
 *            users can keep a single colour and dial transparency.
 *   opacity  0..1.
 *
 * `null` disables the shadow; `undefined` falls back to the config
 * default (which is itself usually `null`).
 */
export type ShadowStyle = {
  offsetY: number;
  blur: number;
  color: string;
  opacity: number;
} | null;

// ─── Background ─────────────────────────────────────────────────────────────

/**
 * Canvas-level background under everything. Per-cell backgrounds come
 * from `FlexIconCell.background` (or `.backgroundColor` for the legacy
 * solid shorthand, or the palette assignment when neither is set).
 * This is the colour that shows in any cell gap, outer padding, and
 * behind the title bar.
 */
export type BackgroundSpec =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; from: string; to: string; angle: number };

/**
 * Per-cell background spec. Strictly broader than the canvas-level
 * `BackgroundSpec`: a cell can pick a pattern background (small unit
 * shape tiled across the cell) or an image background (URL rendered
 * with cover-fit), in addition to the canvas-level solid/gradient
 * options. Phase 2 add.
 *
 * Pattern catalogue is closed — the renderer paints one of four
 * named patterns (`dots`, `stripes`, `grid`, `checker`) with a user-
 * supplied foreground + background colour. We do NOT accept arbitrary
 * SVG fragments from the client (would be an injection vector).
 */
export type CellBackgroundSpec =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; from: string; to: string; angle: number }
  | { type: 'pattern'; pattern: 'dots' | 'stripes' | 'grid' | 'checker'; fg: string; bg: string }
  | { type: 'image'; url: string };

export const SUPPORTED_PATTERN_NAMES = ['dots', 'stripes', 'grid', 'checker'] as const;
export type PatternName = (typeof SUPPORTED_PATTERN_NAMES)[number];

// ─── Palette ────────────────────────────────────────────────────────────────

/**
 * Named palette presets ship in `flex-icon-grid-palettes.ts`; the
 * `custom` variant carries an explicit colour list the composer cycles
 * through. The composer asks the palette module which colour to pin
 * each cell to — both for the named presets and the custom list — so
 * the adjacency rule (no two horizontally or vertically neighbouring
 * cells share a hue family) stays a single source of truth.
 */
export type PaletteSpec =
  | { type: 'preset'; name: 'rainbow' | 'pastel' | 'neon' | 'monochrome' }
  | { type: 'custom'; colors: string[] };

// ─── Title bar ──────────────────────────────────────────────────────────────

/**
 * Optional master title that sits above or below the grid. Used to
 * imitate the "[N] LEVELS OF [TOPIC] EXPLAINED" treatment from the
 * n-levels format when the user wants a master headline. Off by
 * default — most reference Flex Icon Grid thumbnails run titleless.
 */
export interface TitleBarSpec {
  text: string;
  /** Phase 4.33: `'overlay-top'` / `'overlay-bottom'` place the bar
   *  ON TOP of the cell grid without shrinking the grid area —
   *  cells go edge-to-edge of the canvas, and the bar sits over
   *  them. Common pairing: transparent or low-opacity background
   *  so the cells stay visible underneath. The pre-4.33 `'top'` /
   *  `'bottom'` modes still displace the grid as before. */
  position: 'top' | 'bottom' | 'overlay-top' | 'overlay-bottom';
  /** Pixel height of the strip. Composer scales font to fit. */
  height: number;
  /** Phase 4.15: optional remembered height as a fraction of the
   *  canvas height. When set, aspect-ratio chip clicks scale the bar
   *  height by this fraction × the new canvas height, so a tall bar
   *  stays proportionally tall across orientation flips even after
   *  manual height edits. Cleared when the user edits the absolute
   *  `height` field directly so we don't fight their explicit
   *  preference. */
  heightFraction?: number;
  /** Phase 4.27: optional drop shadow under the title bar rectangle.
   *  Mirrors the per-cell `ShadowStyle` shape exactly, painted via
   *  the same SVG filter pattern. Helps the bar lift off busy
   *  canvas backgrounds. Undefined / null = no shadow (the
   *  pre-4.27 look). */
  shadow?: ShadowStyle;
  /** Phase 4.28: optional gradient background for the title bar.
   *  Overrides the solid `background` hex when present. Same shape
   *  as the canvas-level gradient `BackgroundSpec`. Undefined =
   *  solid (the pre-4.28 default). Renders as an SVG
   *  `<linearGradient>` rotated by `angle` and applied as a fill. */
  backgroundGradient?: { from: string; to: string; angle: number };
  /** Phase 4.29: when true, the title bar fill is fully transparent
   *  (only the text + optional drop shadow render). Useful for
   *  thumbnails where the title should sit over the cells without
   *  a backing strip. Overrides both `background` and
   *  `backgroundGradient` when set. */
  backgroundTransparent?: boolean;
  /** Phase 4.29: horizontal alignment for the title text. Defaults
   *  to 'center' — the pre-4.29 behaviour. 'left' aligns to the
   *  canvas-relative safe area's left edge; 'right' to the right
   *  edge. Helps editorial-style thumbnails where the title is
   *  meant to anchor visually. */
  textAlign?: 'left' | 'center' | 'right';
  /** Phase 4.31: optional drop shadow applied to the title text
   *  glyphs themselves (separate from the bar-rect drop shadow).
   *  Useful when the bar is transparent (no rect to cast a shadow
   *  from) or when the text needs to pop against a busy gradient.
   *  Reuses the per-cell `ShadowStyle` shape so the parser +
   *  validator paths stay the same. Renders via an SVG `<filter>`
   *  applied to the text element in the preview and via a Sharp
   *  composite pass on the rasterised text buffer in the composer. */
  textShadow?: ShadowStyle;
  /** Phase 4.32: independent drop shadow for the subtitle. Cascade
   *  rules:
   *    - explicit `null` → subtitle has NO shadow even when the main
   *      `textShadow` is set;
   *    - object → subtitle uses its own shadow spec;
   *    - undefined → subtitle inherits `textShadow`.
   *  Lets a user shadow only the main title without spilling the
   *  effect onto the kicker subtitle. */
  subtitleTextShadow?: ShadowStyle;
  /** Phase 4.30: optional independent horizontal alignment for the
   *  subtitle. Falls back to `textAlign` when undefined so a single-
   *  alignment thumbnail stays consistent. A user wanting a
   *  left-aligned title with a centred kicker subtitle (the common
   *  editorial layout) sets `textAlign: 'left'` + `subtitleTextAlign:
   *  'center'`. Same value space as `textAlign`. */
  subtitleTextAlign?: 'left' | 'center' | 'right';
  background: string;
  color: string;
  font: LabelFont;
  /** Phase 4.9a: required when `font === 'custom'`. R2-hosted TTF
   *  URL. Same shape as `LabelStyle.customFontUrl` — composer fetches
   *  via the byte cache, browser registers via FontFace. */
  customFontUrl?: string;
  /** Display label shown next to the registered-font chip — purely
   *  cosmetic. */
  customFontLabel?: string;
  /** Phase 4.10: optional smaller second line under the main title.
   *  Renders at 50% the height of the main title text in the same
   *  font, colour, and casing. Off by default — only painted when
   *  the user types something. Useful for the "[N] LEVELS / OF
   *  [TOPIC]" two-line treatment the n-levels format reaches for
   *  occasionally. */
  subtitle?: string;
  /** Phase 4.10: optional colour override for the subtitle. Falls
   *  back to `color` when absent — most users want the same colour
   *  for both lines but the option exists for the "muted secondary
   *  line" pattern (e.g. dimmer grey under a stark white title). */
  subtitleColor?: string;
  /** Phase 4.11: optional independent font for the subtitle. Falls
   *  back to the main `font` when absent — the common case is a
   *  matched typeface, but a contrasting subtitle font (e.g.
   *  Patrick Hand subtitle under an Anton title) is a common
   *  editorial pattern worth supporting. */
  subtitleFont?: LabelFont;
  /** Phase 4.11: required when `subtitleFont === 'custom'`. Same
   *  shape as `customFontUrl` — R2-hosted TTF URL fetched via the
   *  byte cache. */
  subtitleCustomFontUrl?: string;
  /** Phase 4.11: display label for the subtitle's registered-font
   *  chip — purely cosmetic. */
  subtitleCustomFontLabel?: string;
}

// ─── Per-cell ───────────────────────────────────────────────────────────────

/**
 * One cell of the grid. `index` is 1-based, reading order
 * (left-to-right, top-to-bottom), matching the convention in
 * `topic-card-grid.TopicCard.index`.
 *
 * Every visual field is OPTIONAL. The composer fills missing fields
 * from the global defaults (`FlexIconGridConfig.defaultCellShape`,
 * `.defaultRing`, `.defaultLabel`) — so a cell that's happy with the
 * defaults only needs to carry `index`, `label`, and `content`.
 *
 * `backgroundColor` is special: when absent, the palette engine
 * picks the colour from the active `PaletteSpec`. When present, it
 * overrides the palette entirely for this cell.
 */
export interface FlexIconCell {
  index: number;
  label: string;
  content: CellContent;
  shape?: CellShape;
  /** Phase-1 solid-colour shorthand. The composer treats this as
   *  `{ type: 'solid', color }` when `background` is undefined.
   *  Kept for backwards compat with stored Phase-1 thumbnails. */
  backgroundColor?: string;
  /** Phase-2 rich background spec. Wins over `backgroundColor` when
   *  both are set. When neither is set, the palette engine picks a
   *  solid colour respecting the adjacency rule. */
  background?: CellBackgroundSpec;
  ring?: RingStyle;
  /** Phase 4.35: optional offset for the cell's content (icon /
   *  emoji / upload / sticker) within its shape. Values are
   *  fractions of the shape's width / height (e.g. 0.1 = 10% to
   *  the right or down). Range −0.5..0.5; outside that the content
   *  would leave the shape entirely. Defaults to no offset when
   *  omitted. Label band is unaffected so multi-cell grids stay
   *  visually aligned. */
  contentOffset?: { x: number; y: number };
  /** Phase 4.30: optional outer stroke drawn around the cell's
   *  bounding rectangle (NOT the inner shape — that's `ring`).
   *  Gives the "framed card" look common to ranked-list thumbnails
   *  where each cell reads as a discrete tile. `null` opts out
   *  explicitly even if a future canvas-level default sets one;
   *  `undefined` falls back to the default. */
  cellStroke?: { color: string; thickness: number } | null;
  /** Phase 4.16: optional rotation in degrees applied to the cell's
   *  shape + icon content. Range −180..180; integer values only.
   *  Rotates around the shape's centre — the label band stays
   *  horizontal so multi-cell grids stay readable. Off by default
   *  (undefined or 0); positive rotates clockwise. Renders byte-
   *  identical to Phase-4.15 when undefined or 0. */
  rotation?: number;
  /** Phase 4.19: mirror the cell's shape + icon content horizontally
   *  (left ↔ right). Independent of rotation; combined freely. Off
   *  by default; label band stays un-mirrored. */
  flipX?: boolean;
  /** Phase 4.19: mirror the cell's shape + icon content vertically
   *  (top ↔ bottom). Independent of rotation; combined freely. Off
   *  by default; label band stays un-mirrored. */
  flipY?: boolean;
  /** Phase 4.11: optional drop shadow under this cell's icon shape.
   *  Cascade rules: explicit `null` disables the shadow for this
   *  cell even when the config default has one; `undefined` falls
   *  back to `FlexIconGridConfig.defaultShadow`. */
  shadow?: ShadowStyle;
  /** Phase 4.12: optional corner badge — small pill in one of four
   *  cell corners. Off by default; undefined / null both render as
   *  no badge. Badges live per-cell only — no config-level default
   *  since the typical use case is "tag a few cells differently". */
  badge?: BadgeStyle | null;
  labelStyle?: Partial<LabelStyle>;
  /** Phase-2 cell-merge: this cell extends across multiple slots,
   *  consuming the cells immediately to the right and below for the
   *  span size. Defaults to `{ rows: 1, cols: 1 }` (one slot). A
   *  hero cell with `cellSpan: { rows: 2, cols: 2 }` consumes the 3
   *  adjacent slots and renders as one merged tile.
   *
   *  Cells consumed by another cell's span are kept in the array
   *  (so user edits to their content/label survive a span toggle)
   *  but are SKIPPED at render time. The composer + live preview
   *  filter them via `getConsumedCellIndexes`. */
  cellSpan?: { rows: number; cols: number };
}

// ─── Top-level config ───────────────────────────────────────────────────────

export interface FlexIconGridConfig {
  /** Output image width in pixels. Defaults to 1280 (YouTube canonical). */
  width: number;
  /** Output image height in pixels. Defaults to 720 (16:9). */
  height: number;
  rows: number;
  cols: number;
  /** Gap between cells in pixels. Set to 0 for edge-to-edge cells. */
  cellGap: number;
  /** Margin around the entire grid in pixels. */
  outerPadding: number;
  /** Corner radius for `rounded-square` shape, in pixels. Ignored for
   *  other shapes — they have their own implicit radius rules. */
  cornerRadius: number;
  background: BackgroundSpec;
  palette: PaletteSpec;
  defaultCellShape: CellShape;
  defaultRing: RingStyle;
  defaultLabel: LabelStyle;
  /** Phase 4.15: starting cursor for palette colour assignment.
   *  Resolves modulo palette length, so any integer is valid. The
   *  panel's "Shuffle" button increments this to rotate the colour
   *  assignment without changing the palette itself. Locked cells
   *  (explicit `backgroundColor`) are unaffected — they bypass the
   *  cursor entirely. Defaults to 0 if unset; existing thumbnails
   *  parse with cursor=0 so the assignment stays byte-identical. */
  paletteShuffleOffset?: number;
  /** Phase 4.11: default drop shadow applied to every cell whose
   *  own `shadow` field is `undefined`. Cells with an explicit
   *  `null` shadow opt out. Defaults to `null` (no shadow) so the
   *  existing flat-cell look is preserved unless the user opts in. */
  defaultShadow?: ShadowStyle;
  /** Phase 4.30: default outer stroke applied to every cell whose
   *  own `cellStroke` field is `undefined`. Cells with an explicit
   *  `null` opt out. Defaults to `null` (no outer stroke). */
  defaultCellStroke?: { color: string; thickness: number } | null;
  cells: FlexIconCell[];
  titleBar?: TitleBarSpec;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/** Canonical YouTube thumbnail canvas. Same as the sibling formats. */
export const DEFAULT_CANVAS = { width: 1280, height: 720 } as const;

/**
 * Phase 4.13: aspect ratio presets. Each entry maps a chip label
 * (and its primary use case) to a width × height pair. The reference
 * 16:9 stays the default; the others let a user repurpose the same
 * grid as a Shorts vertical, an Instagram square, or a legacy 4:3
 * card without manually editing the canvas dimensions. Picked sizes
 * are all reasonable upload resolutions for each platform — large
 * enough for crisp downscaling, small enough that Lambda renders
 * stay under the function timeout for a typical 5×3 grid.
 */
export interface AspectRatioPreset {
  id: string;
  label: string;
  description: string;
  width: number;
  height: number;
}

export const ASPECT_RATIO_PRESETS: readonly AspectRatioPreset[] = [
  { id: '16-9', label: '16:9', description: 'YouTube thumbnail (default)', width: 1280, height: 720 },
  { id: '1-1', label: '1:1', description: 'Instagram square', width: 1080, height: 1080 },
  { id: '9-16', label: '9:16', description: 'YouTube Shorts / TikTok vertical', width: 720, height: 1280 },
  { id: '4-3', label: '4:3', description: 'Legacy 4:3 card', width: 1280, height: 960 },
  // Phase 4.15: 21:9 ultra-wide for cinematic banner-style thumbnails
  // and channel art crops. Stays within the 4096 px validateConfig
  // limit while preserving enough vertical room for a usable grid.
  { id: '21-9', label: '21:9', description: 'Ultra-wide / banner', width: 1680, height: 720 },
] as const;

/** Look up an aspect ratio preset by `id`. Returns undefined for
 *  unknown ids — caller decides whether to fall back to 16:9 or
 *  preserve the current canvas. */
export function getAspectRatioPreset(id: string): AspectRatioPreset | undefined {
  return ASPECT_RATIO_PRESETS.find((p) => p.id === id);
}

/**
 * Phase 4.15: transpose cells when the grid orientation flips.
 * Given an array of cells laid out in reading order on a rowsA × colsA
 * grid, returns a new array re-indexed for the transposed colsA × rowsA
 * grid. The hero cell at top-left (index 1) stays top-left; row 1 ↔
 * column 1; cell (r, c) becomes cell (c, r). Preserves the cell's
 * full content + per-cell overrides — only `index` changes.
 *
 * Pure function — exported so the panel can apply it without
 * duplicating the math.
 */
export function transposeCells(
  cells: FlexIconCell[],
  rowsA: number,
  colsA: number,
): FlexIconCell[] {
  const out: FlexIconCell[] = new Array(rowsA * colsA);
  for (const cell of cells) {
    if (cell.index < 1 || cell.index > rowsA * colsA) continue;
    const i = cell.index - 1;
    const r = Math.floor(i / colsA);
    const c = i % colsA;
    // After transpose, new grid is colsA rows × rowsA cols.
    // (r, c) on old grid → (c, r) on new grid → new index = c * rowsA + r + 1
    const newIndex = c * rowsA + r + 1;
    // Phase 4.16: swap cellSpan dimensions too — a {rows:2, cols:1}
    // hero on the old grid becomes a {rows:1, cols:2} hero on the
    // transposed grid, preserving the cell's relative visual shape.
    const swappedSpan = cell.cellSpan
      ? { rows: cell.cellSpan.cols, cols: cell.cellSpan.rows }
      : undefined;
    out[newIndex - 1] = {
      ...cell,
      index: newIndex,
      ...(swappedSpan ? { cellSpan: swappedSpan } : {}),
    };
  }
  // Fill any missing positions with default empty cells. Shouldn't
  // happen on well-formed input but defensive against history entries
  // with missing cells.
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) {
      out[i] = { index: i + 1, label: `Item ${i + 1}`, content: { type: 'text-only' } };
    }
  }
  return out;
}

/** Sensible defaults for the reference channels' look. Cell gap of 0
 *  matches the `Paint Explainer` and `Evaluator` edge-to-edge style;
 *  users who want gaps bump it via the panel. Outer padding 0 lets
 *  cells bleed to the canvas edge — same channels do this. */
export const DEFAULT_CELL_GAP = 0;
export const DEFAULT_OUTER_PADDING = 0;
export const DEFAULT_CORNER_RADIUS = 24;

/** Default label style — chunky uppercase Anton in black with a thin
 *  white stroke for legibility on bright cell backgrounds. Single line
 *  to match the reference channels (none of them wrap labels). */
export const DEFAULT_LABEL_STYLE: LabelStyle = {
  position: 'below',
  font: 'anton',
  case: 'upper',
  color: '#0a0a0a',
  stroke: null,
  maxLines: 1,
};

/** Default ring — thick black solid ring, ~3% of cell width. The
 *  composer scales `thickness` proportionally with cell size before
 *  rendering, so this fixed value is the canonical "1280×720 / 5×3" reference. */
export const DEFAULT_RING: RingStyle = {
  color: '#0a0a0a',
  thickness: 6,
  style: 'solid',
};

/** Phase 4.11: default shadow preset used by the panel's "Cell
 *  shadow on" toggle. Tuned for the 1280×720 reference canvas: 8px
 *  down, 12px blur, near-black at 35% opacity reads as a soft cast
 *  on bright cell backgrounds without overpowering the icon. */
export const DEFAULT_SHADOW: ShadowStyle = {
  offsetY: 8,
  blur: 12,
  color: '#000000',
  opacity: 0.35,
};

/** Phase 4.13: starter shadow used when a user picks "Custom" on a
 *  cell that has no inherited default. Lighter than `DEFAULT_SHADOW`
 *  (smaller offset, more transparent) so the override visibly differs
 *  from the canvas-level default — the user can then dial it up if
 *  they want a stronger cast. Picking the same defaults as the
 *  canvas-level toggle would mask the cell-specific override. */
export const STARTER_CELL_SHADOW: ShadowStyle = {
  offsetY: 4,
  blur: 6,
  color: '#000000',
  opacity: 0.2,
};

/**
 * Build a starter config with the right number of cells pre-populated.
 * `iconLibraryNames` is an optional list of Lucide icon names the
 * caller wants placed in cell order (rest get filled with `text-only`).
 * Defaults: rainbow palette, circle cells, anton labels, no title bar.
 *
 * Used by the editor when the user picks a grid size — the panel shows
 * a usable preview immediately rather than an empty grid (rule 10:
 * lazy user gets instant visual feedback).
 */
export function makeDefaultConfig(
  rows: number,
  cols: number,
  opts: {
    width?: number;
    height?: number;
    iconLibraryNames?: string[];
    labels?: string[];
  } = {},
): FlexIconGridConfig {
  const width = opts.width ?? DEFAULT_CANVAS.width;
  const height = opts.height ?? DEFAULT_CANVAS.height;
  const total = rows * cols;
  const cells: FlexIconCell[] = [];
  for (let i = 0; i < total; i++) {
    const label = opts.labels?.[i] ?? `Item ${i + 1}`;
    const iconName = opts.iconLibraryNames?.[i];
    const content: CellContent = iconName
      ? { type: 'icon-library', name: iconName }
      : { type: 'text-only' };
    cells.push({ index: i + 1, label, content });
  }
  return {
    width,
    height,
    rows,
    cols,
    cellGap: DEFAULT_CELL_GAP,
    outerPadding: DEFAULT_OUTER_PADDING,
    cornerRadius: DEFAULT_CORNER_RADIUS,
    background: { type: 'solid', color: '#0a0a0a' },
    palette: { type: 'preset', name: 'rainbow' },
    defaultCellShape: 'circle',
    defaultRing: DEFAULT_RING,
    defaultLabel: DEFAULT_LABEL_STYLE,
    cells,
  };
}

// ─── Layout math ────────────────────────────────────────────────────────────

/**
 * Bounding box of the slice of canvas the grid actually occupies. When
 * a title bar is configured, the grid is shifted to make room for it;
 * everything else (cell rects, region computation) keys off this rect.
 */
export interface GridLayout {
  /** Grid area top-left x in canvas pixels. */
  x: number;
  /** Grid area top-left y in canvas pixels. */
  y: number;
  /** Grid area width in canvas pixels. */
  w: number;
  /** Grid area height in canvas pixels. */
  h: number;
  rows: number;
  cols: number;
  cellGap: number;
}

/**
 * Compute the grid's bounding box given the canvas and an optional
 * title bar. Pure math — the composer feeds the result back into the
 * per-cell rect helper below.
 */
export function computeGridLayout(config: FlexIconGridConfig): GridLayout {
  const { width, height, rows, cols, cellGap, outerPadding, titleBar } = config;
  const titleTop = titleBar?.position === 'top' ? titleBar.height : 0;
  const titleBottom = titleBar?.position === 'bottom' ? titleBar.height : 0;
  return {
    x: outerPadding,
    y: outerPadding + titleTop,
    w: width - 2 * outerPadding,
    h: height - 2 * outerPadding - titleTop - titleBottom,
    rows,
    cols,
    cellGap,
  };
}

/**
 * Full bounding rectangle of cell `cellIndex` (1-based) in canvas
 * pixels. Mirrors `cellRect()` in `topic-card-grid-composite.ts`. The
 * composer uses this for both background painting and shape geometry;
 * the region builder rounds it for the persisted region list.
 */
export function computeCellRect(
  layout: GridLayout,
  cellIndex: number,
  span: { rows: number; cols: number } = { rows: 1, cols: 1 },
): { x: number; y: number; w: number; h: number } {
  const { x: gx, y: gy, w: gw, h: gh, rows, cols, cellGap } = layout;
  const cellW = (gw - (cols - 1) * cellGap) / cols;
  const cellH = (gh - (rows - 1) * cellGap) / rows;
  const i = cellIndex - 1; // 1-based → 0-based
  const r = Math.floor(i / cols);
  const c = i % cols;
  // Clamp span so it can't exceed the grid bounds from the cell's
  // origin. The editor enforces the same clamp before allowing the
  // user to pick a span — this is a defensive guard for restored
  // history entries where the grid may have been resized.
  const safeRowSpan = Math.max(1, Math.min(span.rows, rows - r));
  const safeColSpan = Math.max(1, Math.min(span.cols, cols - c));
  return {
    x: gx + c * (cellW + cellGap),
    y: gy + r * (cellH + cellGap),
    w: cellW * safeColSpan + cellGap * (safeColSpan - 1),
    h: cellH * safeRowSpan + cellGap * (safeRowSpan - 1),
  };
}

/**
 * Collect the indexes of cells consumed by another cell's span.
 * A cell with `cellSpan: { rows: 2, cols: 2 }` at index 1 in a
 * 5-col grid consumes indexes 2, 6, 7 — those cells stay in the
 * config but are skipped at render time. The composer + live
 * preview pass each cell through this filter.
 *
 * Cascading rule: if a cell is itself already consumed by an
 * EARLIER cell's span, its own span is IGNORED. This stops a
 * runaway-consumption chain where every cell after an early span
 * cascades into "consumed" because each consumed cell still tries
 * to claim its own span area. The cell with the conflicting span
 * still appears in `getSpanConflicts` so the editor can warn the
 * user — silently dropping the span would hide the fact that the
 * user picked it.
 */
export function getConsumedCellIndexes(config: FlexIconGridConfig): Set<number> {
  const consumed = new Set<number>();
  const ordered = [...config.cells].sort((a, b) => a.index - b.index);
  for (const cell of ordered) {
    if (consumed.has(cell.index)) continue;
    const span = cell.cellSpan;
    if (!span || (span.rows <= 1 && span.cols <= 1)) continue;
    const i = cell.index - 1;
    const baseR = Math.floor(i / config.cols);
    const baseC = i % config.cols;
    const safeRowSpan = Math.max(1, Math.min(span.rows, config.rows - baseR));
    const safeColSpan = Math.max(1, Math.min(span.cols, config.cols - baseC));
    for (let dr = 0; dr < safeRowSpan; dr++) {
      for (let dc = 0; dc < safeColSpan; dc++) {
        if (dr === 0 && dc === 0) continue; // the spanning cell itself
        const consumedIndex = (baseR + dr) * config.cols + (baseC + dc) + 1;
        consumed.add(consumedIndex);
      }
    }
  }
  return consumed;
}

/**
 * Phase 4.30: resolve the effective outer cell stroke for a cell.
 * Cascade rules mirror `resolveCellShadow` — explicit `null` opts
 * out, undefined inherits the config default, object overrides.
 * Pure function — exported so composer + live preview share the
 * same resolution.
 */
export function resolveCellStroke(
  cell: FlexIconCell,
  config: FlexIconGridConfig,
): { color: string; thickness: number } | null {
  if (cell.cellStroke === null) return null;
  if (cell.cellStroke) return cell.cellStroke;
  return config.defaultCellStroke ?? null;
}

/** Phase 4.30: tolerant parser for cell stroke. `null` round-trips
 *  as "explicit off"; missing / non-object → undefined. */
function parseCellStroke(v: unknown): { color: string; thickness: number } | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return {
    color: stringOr(o.color, '#0a0a0a'),
    thickness: Math.max(0, numberOr(o.thickness, 4)),
  };
}

/**
 * Phase 4.11: resolve the effective drop shadow for a cell. Cascade
 * rules:
 *   - explicit `null` on the cell → shadow disabled (opt-out from
 *     the config default).
 *   - explicit object on the cell → use it.
 *   - `undefined` → fall back to `config.defaultShadow` (which is
 *     itself usually `null` or undefined, leaving the cell shadowless).
 * Pure function — exported so the live preview and composer share
 * the same resolution.
 */
export function resolveCellShadow(
  cell: FlexIconCell,
  config: FlexIconGridConfig,
): ShadowStyle {
  if (cell.shadow === null) return null;
  if (cell.shadow) return cell.shadow;
  return config.defaultShadow ?? null;
}

/**
 * Phase 4.12: compute the SVG filter region (objectBoundingBox %) that
 * comfortably contains the shadow halo. Over-estimates to ~200 % of
 * the maximum displacement so the Gaussian tail also stays inside,
 * and floors per-axis pad at 25 % so a subtle shadow doesn't get a
 * tiny clip box. Returned as integers since fractional percentages
 * don't help and make the emitted SVG noisier.
 *
 * Both `flex-icon-grid-composer` and the live preview's
 * `CellShadowFilter` import this so they emit the exact same region —
 * important so the preview's filter doesn't clip when the rendered
 * PNG's wouldn't.
 *
 * Phase 4.13: optional `shapeSize` parameter converts pixel-valued
 * `offsetY` / `blur` into accurate percentages relative to the
 * filtered element's bounding box. Without it we fall back to the
 * Phase-4.12 "1 px ≈ 1 %" heuristic, which over-pads on large cells
 * and under-pads on very small ones. Always passing `shapeSize`
 * gives a tight region that scales correctly across grid sizes.
 */
export function computeShadowFilterRegion(
  shadow: NonNullable<ShadowStyle>,
  shapeSize?: number,
): {
  x: number; y: number; w: number; h: number;
} {
  // When shapeSize is known we can convert pixel displacements to
  // exact percentages of the filtered shape. Multiplied by 200 since
  // a Gaussian's 95th-percentile reach is ~2σ — `blur` IS σ, so the
  // visible halo extends ~2*blur on each side. Plus full offset.
  const pixelPad = 2 * shadow.blur + Math.abs(shadow.offsetY);
  const padPct = shapeSize && shapeSize > 0
    ? Math.max(25, Math.ceil((pixelPad / shapeSize) * 100))
    : Math.max(25, Math.ceil(pixelPad));
  // Phase 4.14: include the Gaussian tail on the downward side. A
  // shape pushed down by offsetY + extended by ~2*blur of soft tail
  // can otherwise trim its last few pixels when offsetY ≫ blur.
  // `downExtraPx = offsetY + 2*blur` gives the bottom edge enough
  // headroom in both the pure-offset and blur-dominated regimes.
  const downExtraPx = shadow.offsetY > 0
    ? Math.abs(shadow.offsetY) + 2 * shadow.blur
    : 0;
  const downExtra = downExtraPx > 0
    ? shapeSize && shapeSize > 0
      ? Math.ceil((downExtraPx / shapeSize) * 100)
      : Math.ceil(downExtraPx)
    : 0;
  return {
    x: -padPct,
    y: -padPct,
    w: 100 + 2 * padPct,
    h: 100 + 2 * padPct + downExtra,
  };
}

/**
 * Per-cell span conflict diagnosis. A cell falls into the conflict
 * set when:
 *  - It has an explicit `cellSpan > 1×1`, AND its origin slot is
 *    already consumed by an earlier cell's span (`consumed-by-earlier`).
 *    The cascading consume rule then drops this cell's span entirely.
 *  - Its span extends past the grid edge from the cell's origin and
 *    gets clamped to fit (`clamped-to-grid`). The rendered tile will
 *    be smaller than the configured span.
 *
 * Why no `overlaps-earlier` case: with rectangular spans walked in
 * reading order and the cascading-consume rule, the only way a
 * later span could reach into earlier-consumed slots is if its
 * origin is itself in the consumed set — which is exactly the
 * `consumed-by-earlier` case. The classification stays compact and
 * actionable.
 *
 * The editor walks the result to paint a warning outline on
 * conflicting cells in the live preview and surface a note in the
 * cell editor. Pure function — exported for the panel.
 */
export type SpanConflictReason = 'consumed-by-earlier' | 'clamped-to-grid';
export function getSpanConflicts(
  config: FlexIconGridConfig,
): Map<number, SpanConflictReason> {
  const conflicts = new Map<number, SpanConflictReason>();
  const consumed = new Set<number>();
  const ordered = [...config.cells].sort((a, b) => a.index - b.index);
  for (const cell of ordered) {
    const span = cell.cellSpan;
    if (!span || (span.rows <= 1 && span.cols <= 1)) continue;
    if (consumed.has(cell.index)) {
      conflicts.set(cell.index, 'consumed-by-earlier');
      continue;
    }
    const i = cell.index - 1;
    const baseR = Math.floor(i / config.cols);
    const baseC = i % config.cols;
    if (baseR + span.rows > config.rows || baseC + span.cols > config.cols) {
      conflicts.set(cell.index, 'clamped-to-grid');
    }
    const safeRowSpan = Math.max(1, Math.min(span.rows, config.rows - baseR));
    const safeColSpan = Math.max(1, Math.min(span.cols, config.cols - baseC));
    for (let dr = 0; dr < safeRowSpan; dr++) {
      for (let dc = 0; dc < safeColSpan; dc++) {
        if (dr === 0 && dc === 0) continue;
        const consumedIndex = (baseR + dr) * config.cols + (baseC + dc) + 1;
        consumed.add(consumedIndex);
      }
    }
  }
  return conflicts;
}

/**
 * Region rectangles for production-doc consumption. One region per
 * cell, returned in reading order, with the cell's `label` as the
 * region label. `mkId` lets tests inject a deterministic generator;
 * production callers pass `crypto.randomUUID`.
 */
export function computeRegions(
  config: FlexIconGridConfig,
  mkId: () => string,
): ThumbnailRegion[] {
  const layout = computeGridLayout(config);
  const consumed = getConsumedCellIndexes(config);
  const out: ThumbnailRegion[] = [];
  for (const cell of config.cells) {
    if (consumed.has(cell.index)) continue;
    const rect = computeCellRect(layout, cell.index, cell.cellSpan);
    out.push({
      id: mkId(),
      label: cell.label || `Cell ${cell.index}`,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.w),
      h: Math.round(rect.h),
    });
  }
  return out;
}

// ─── Geometry helpers for the composer ──────────────────────────────────────

/**
 * Computed geometry for a single cell's icon shape + label band. The
 * composer asks for this once per cell and paints accordingly. Returned
 * as floats so callers (the live preview, the server composer) round
 * consistently at their own boundary.
 */
export interface CellGeometry {
  /** Cell bounding box. */
  cellX: number;
  cellY: number;
  cellW: number;
  cellH: number;
  /** Icon shape bounding box (square — for circle it's the disc's
   *  bounding rect; for square/rounded-square it's the shape itself). */
  shapeX: number;
  shapeY: number;
  shapeW: number;
  shapeH: number;
  /** Label band rect — empty when `position` is `hidden`. */
  labelX: number;
  labelY: number;
  labelW: number;
  labelH: number;
}

/** Vertical fraction of the cell devoted to the shape when label is
 *  visible. 0.70 leaves a ~30% band for the label — matches the
 *  reference channels' proportions. Labels above/below get the same
 *  band height; overlay labels paint INSIDE the shape's bottom third. */
const SHAPE_FRAC_WITH_LABEL = 0.7;
/** Horizontal padding from cell edge for the icon shape, as a fraction
 *  of cell width. 0.06 leaves breathing room around discs so adjacent
 *  cells don't kiss when cellGap is 0. */
const SHAPE_HORIZONTAL_PAD_FRAC = 0.06;

/**
 * Compute the icon shape + label band geometry within a cell. Pure
 * math; the composer applies it to both server-side SVG and the live
 * preview's HTML/CSS layout so they line up pixel-for-pixel.
 */
export function computeCellGeometry(
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
  labelPosition: LabelStyle['position'],
): CellGeometry {
  const hasLabelBand = labelPosition === 'below' || labelPosition === 'above';
  const padX = cellW * SHAPE_HORIZONTAL_PAD_FRAC;
  // When the label is hidden or overlaid on the shape, the shape fills
  // the cell vertically (minus a small breathing pad). When the label
  // gets its own band, the shape takes 70% and the band the rest.
  const shapeAreaH = hasLabelBand ? cellH * SHAPE_FRAC_WITH_LABEL : cellH;
  // Fit the shape into the available rect maintaining a square aspect —
  // the reference channels' discs are perfect circles, not ovals.
  const shapeMaxW = cellW - 2 * padX;
  const shapeSize = Math.min(shapeMaxW, shapeAreaH);
  const shapeX = cellX + (cellW - shapeSize) / 2;
  let shapeY: number;
  let labelX: number;
  let labelY: number;
  let labelW: number;
  let labelH: number;
  if (labelPosition === 'above') {
    labelX = cellX;
    labelY = cellY;
    labelW = cellW;
    labelH = cellH - shapeAreaH;
    shapeY = cellY + labelH + (shapeAreaH - shapeSize) / 2;
  } else if (labelPosition === 'below') {
    shapeY = cellY + (shapeAreaH - shapeSize) / 2;
    labelX = cellX;
    labelY = cellY + shapeAreaH;
    labelW = cellW;
    labelH = cellH - shapeAreaH;
  } else if (labelPosition === 'overlay') {
    // Shape fills the whole cell; the label band overlays the bottom
    // third of the cell, painted over the shape with a translucent
    // contrast strip behind it (composer responsibility).
    shapeY = cellY + (cellH - shapeSize) / 2;
    labelX = cellX;
    labelY = cellY + cellH * 0.66;
    labelW = cellW;
    labelH = cellH * 0.34;
  } else {
    // hidden
    shapeY = cellY + (cellH - shapeSize) / 2;
    labelX = cellX;
    labelY = cellY;
    labelW = 0;
    labelH = 0;
  }
  return {
    cellX,
    cellY,
    cellW,
    cellH,
    shapeX,
    shapeY,
    shapeW: shapeSize,
    shapeH: shapeSize,
    labelX,
    labelY,
    labelW,
    labelH,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; offending_cell_index?: number };

/**
 * Pre-render shape + sanity check on a config. The render API runs this
 * before invoking the composer so a broken config produces an
 * actionable 400 instead of a half-rendered PNG.
 *
 * Bounded constants chosen to match the panel's UI clamps:
 *  - rows/cols: 1..6 (Phase 1 cap — Phase 2 raises this)
 *  - canvas: 64..4096 in either dimension
 *  - cell count must match `rows * cols`
 *  - cell.index must be the 1-based reading-order position
 *  - colors must be #RGB or #RRGGBB hex
 *  - label length capped at 60 chars (matches sibling formats)
 */
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function validateConfig(config: FlexIconGridConfig): ValidationResult {
  if (!config || typeof config !== 'object') {
    return { ok: false, reason: 'config is not an object' };
  }
  const { width, height, rows, cols, cells } = config;
  if (!Number.isInteger(width) || width < 64 || width > 4096) {
    return { ok: false, reason: `width must be an integer between 64 and 4096 (got ${width})` };
  }
  if (!Number.isInteger(height) || height < 64 || height > 4096) {
    return { ok: false, reason: `height must be an integer between 64 and 4096 (got ${height})` };
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 6) {
    return { ok: false, reason: `rows must be an integer between 1 and 6 (got ${rows})` };
  }
  if (!Number.isInteger(cols) || cols < 1 || cols > 6) {
    return { ok: false, reason: `cols must be an integer between 1 and 6 (got ${cols})` };
  }
  if (!Array.isArray(cells)) {
    return { ok: false, reason: 'cells must be an array' };
  }
  const expected = rows * cols;
  if (cells.length !== expected) {
    return { ok: false, reason: `cells.length must equal rows × cols (expected ${expected}, got ${cells.length})` };
  }
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const idx = i + 1;
    if (!c || typeof c !== 'object') {
      return { ok: false, reason: `cell ${idx} is not an object`, offending_cell_index: idx };
    }
    if (c.index !== idx) {
      return { ok: false, reason: `cell at array position ${i} has index ${c.index}; expected ${idx} (1-based reading order)`, offending_cell_index: idx };
    }
    if (typeof c.label !== 'string' || c.label.length > 60) {
      return { ok: false, reason: `cell ${idx} label must be a string of at most 60 characters`, offending_cell_index: idx };
    }
    const contentResult = validateCellContent(c.content, idx);
    if (!contentResult.ok) return contentResult;
    if (c.backgroundColor && !HEX_COLOR_RE.test(c.backgroundColor)) {
      return { ok: false, reason: `cell ${idx} backgroundColor is not a valid hex color (got ${c.backgroundColor})`, offending_cell_index: idx };
    }
    if (c.shape && !SUPPORTED_CELL_SHAPES.includes(c.shape)) {
      return { ok: false, reason: `cell ${idx} shape ${c.shape} is not supported`, offending_cell_index: idx };
    }
    // Phase 4.11: shadow shape check. `null` is explicit-off (allowed);
    // a present object must have valid hex colour + opacity in [0, 1] +
    // non-negative blur + finite offsetY.
    const shadowResult = validateShadow(c.shadow, `cell ${idx}`, idx);
    if (!shadowResult.ok) return shadowResult;
    // Phase 4.12: badge shape check.
    const badgeResult = validateBadge(c.badge, idx);
    if (!badgeResult.ok) return badgeResult;
    // Phase 4.35: content offset bounds check.
    if (c.contentOffset !== undefined) {
      if (typeof c.contentOffset !== 'object' || c.contentOffset === null) {
        return { ok: false, reason: `cell ${idx} contentOffset must be an object`, offending_cell_index: idx };
      }
      if (!Number.isFinite(c.contentOffset.x) || c.contentOffset.x < -0.5 || c.contentOffset.x > 0.5) {
        return { ok: false, reason: `cell ${idx} contentOffset.x must be a finite number in [-0.5, 0.5]`, offending_cell_index: idx };
      }
      if (!Number.isFinite(c.contentOffset.y) || c.contentOffset.y < -0.5 || c.contentOffset.y > 0.5) {
        return { ok: false, reason: `cell ${idx} contentOffset.y must be a finite number in [-0.5, 0.5]`, offending_cell_index: idx };
      }
    }
    // Phase 4.30: cell outer stroke shape check.
    if (c.cellStroke !== undefined && c.cellStroke !== null) {
      if (typeof c.cellStroke !== 'object') {
        return { ok: false, reason: `cell ${idx} cellStroke must be an object, null, or undefined`, offending_cell_index: idx };
      }
      if (typeof c.cellStroke.color !== 'string' || !HEX_COLOR_RE.test(c.cellStroke.color)) {
        return { ok: false, reason: `cell ${idx} cellStroke.color is not a valid hex color`, offending_cell_index: idx };
      }
      if (!Number.isFinite(c.cellStroke.thickness) || c.cellStroke.thickness < 0) {
        return { ok: false, reason: `cell ${idx} cellStroke.thickness must be a non-negative number`, offending_cell_index: idx };
      }
    }
    // Phase 4.16: rotation range check.
    if (c.rotation !== undefined) {
      if (typeof c.rotation !== 'number' || !Number.isFinite(c.rotation)) {
        return { ok: false, reason: `cell ${idx} rotation must be a finite number`, offending_cell_index: idx };
      }
      if (c.rotation < -180 || c.rotation > 180) {
        return { ok: false, reason: `cell ${idx} rotation must be between -180 and 180`, offending_cell_index: idx };
      }
    }
  }
  if (config.titleBar) {
    if (typeof config.titleBar.text !== 'string') {
      return { ok: false, reason: 'titleBar.text must be a string' };
    }
    if (!Number.isInteger(config.titleBar.height) || config.titleBar.height < 16 || config.titleBar.height > height / 2) {
      return { ok: false, reason: `titleBar.height must be between 16 and ${Math.floor(height / 2)} (half canvas)` };
    }
    if (!HEX_COLOR_RE.test(config.titleBar.background)) {
      return { ok: false, reason: 'titleBar.background is not a valid hex color' };
    }
    if (!HEX_COLOR_RE.test(config.titleBar.color)) {
      return { ok: false, reason: 'titleBar.color is not a valid hex color' };
    }
    // Phase 4.10: subtitle bounds + colour shape.
    if (config.titleBar.subtitle !== undefined) {
      if (typeof config.titleBar.subtitle !== 'string' || config.titleBar.subtitle.length > 200) {
        return { ok: false, reason: 'titleBar.subtitle must be a string of at most 200 characters' };
      }
    }
    if (config.titleBar.subtitleColor !== undefined && !HEX_COLOR_RE.test(config.titleBar.subtitleColor)) {
      return { ok: false, reason: 'titleBar.subtitleColor is not a valid hex color' };
    }
    // Phase 4.27: title bar shadow goes through the same shape check
    // as the per-cell shadow so a malformed value is caught with an
    // actionable reason rather than crashing the SVG filter.
    const titleShadowResult = validateShadow(config.titleBar.shadow, 'titleBar.shadow');
    if (!titleShadowResult.ok) return titleShadowResult;
    // Phase 4.31: text-only shadow validation.
    const textShadowResult = validateShadow(config.titleBar.textShadow, 'titleBar.textShadow');
    if (!textShadowResult.ok) return textShadowResult;
    // Phase 4.32: subtitle text shadow validation.
    const subtitleTextShadowResult = validateShadow(
      config.titleBar.subtitleTextShadow,
      'titleBar.subtitleTextShadow',
    );
    if (!subtitleTextShadowResult.ok) return subtitleTextShadowResult;
    // Phase 4.28: gradient backgrounds — both stops must be valid
    // hex; angle is a finite number (any value works as a rotation).
    if (config.titleBar.backgroundGradient) {
      const g = config.titleBar.backgroundGradient;
      if (!HEX_COLOR_RE.test(g.from)) {
        return { ok: false, reason: 'titleBar.backgroundGradient.from is not a valid hex color' };
      }
      if (!HEX_COLOR_RE.test(g.to)) {
        return { ok: false, reason: 'titleBar.backgroundGradient.to is not a valid hex color' };
      }
      if (!Number.isFinite(g.angle)) {
        return { ok: false, reason: 'titleBar.backgroundGradient.angle must be a finite number' };
      }
    }
  }
  const defaultShadowResult = validateShadow(config.defaultShadow, 'defaultShadow');
  if (!defaultShadowResult.ok) return defaultShadowResult;
  // Phase 4.31: defaultCellStroke gets the same hex + non-negative
  // thickness check as the per-cell version so a config-level
  // garbage value is caught before reaching the renderer.
  if (config.defaultCellStroke !== undefined && config.defaultCellStroke !== null) {
    if (typeof config.defaultCellStroke !== 'object') {
      return { ok: false, reason: 'defaultCellStroke must be an object, null, or undefined' };
    }
    if (
      typeof config.defaultCellStroke.color !== 'string' ||
      !HEX_COLOR_RE.test(config.defaultCellStroke.color)
    ) {
      return { ok: false, reason: 'defaultCellStroke.color is not a valid hex color' };
    }
    if (
      !Number.isFinite(config.defaultCellStroke.thickness) ||
      config.defaultCellStroke.thickness < 0
    ) {
      return { ok: false, reason: 'defaultCellStroke.thickness must be a non-negative number' };
    }
  }
  return { ok: true };
}

/** Phase 4.12: badge shape check. undefined / null are valid (no
 *  badge). A populated object must have a 1–8 char text, a supported
 *  corner, and hex colours for both background and text. */
function validateBadge(
  badge: BadgeStyle | null | undefined,
  cellIndex: number,
): ValidationResult {
  if (badge === undefined || badge === null) return { ok: true };
  if (typeof badge !== 'object') {
    return { ok: false, reason: `cell ${cellIndex} badge must be an object, null, or undefined`, offending_cell_index: cellIndex };
  }
  if (typeof badge.text !== 'string' || badge.text.length === 0 || badge.text.length > 8) {
    return { ok: false, reason: `cell ${cellIndex} badge.text must be a 1–8 character string`, offending_cell_index: cellIndex };
  }
  if (!SUPPORTED_BADGE_CORNERS.includes(badge.corner)) {
    return { ok: false, reason: `cell ${cellIndex} badge.corner ${String(badge.corner)} is not supported`, offending_cell_index: cellIndex };
  }
  if (typeof badge.background !== 'string' || !HEX_COLOR_RE.test(badge.background)) {
    return { ok: false, reason: `cell ${cellIndex} badge.background is not a valid hex color`, offending_cell_index: cellIndex };
  }
  if (typeof badge.color !== 'string' || !HEX_COLOR_RE.test(badge.color)) {
    return { ok: false, reason: `cell ${cellIndex} badge.color is not a valid hex color`, offending_cell_index: cellIndex };
  }
  return { ok: true };
}

/** Phase 4.11: shared shadow shape check. `undefined` and `null` are
 *  both valid (undefined → not configured / inherit; null → explicit
 *  off). When a populated object is present, every field must be
 *  finite and within bounds. */
function validateShadow(
  shadow: ShadowStyle | undefined,
  contextLabel: string,
  offendingCellIndex?: number,
): ValidationResult {
  if (shadow === undefined || shadow === null) return { ok: true };
  if (typeof shadow !== 'object') {
    return { ok: false, reason: `${contextLabel} shadow must be an object, null, or undefined`, offending_cell_index: offendingCellIndex };
  }
  if (!Number.isFinite(shadow.offsetY)) {
    return { ok: false, reason: `${contextLabel} shadow.offsetY must be a finite number`, offending_cell_index: offendingCellIndex };
  }
  if (!Number.isFinite(shadow.blur) || shadow.blur < 0) {
    return { ok: false, reason: `${contextLabel} shadow.blur must be a non-negative finite number`, offending_cell_index: offendingCellIndex };
  }
  if (typeof shadow.color !== 'string' || !HEX_COLOR_RE.test(shadow.color)) {
    return { ok: false, reason: `${contextLabel} shadow.color must be a hex string`, offending_cell_index: offendingCellIndex };
  }
  if (typeof shadow.opacity !== 'number' || shadow.opacity < 0 || shadow.opacity > 1) {
    return { ok: false, reason: `${contextLabel} shadow.opacity must be between 0 and 1`, offending_cell_index: offendingCellIndex };
  }
  return { ok: true };
}

function validateCellContent(content: unknown, cellIndex: number): ValidationResult {
  if (!content || typeof content !== 'object') {
    return { ok: false, reason: `cell ${cellIndex} content is not an object`, offending_cell_index: cellIndex };
  }
  const c = content as { type?: unknown; name?: unknown; char?: unknown; url?: unknown };
  if (typeof c.type !== 'string' || !(SUPPORTED_CONTENT_TYPES as readonly string[]).includes(c.type)) {
    return { ok: false, reason: `cell ${cellIndex} content.type ${String(c.type)} is not supported`, offending_cell_index: cellIndex };
  }
  if (c.type === 'icon-library' && (typeof c.name !== 'string' || !c.name)) {
    return { ok: false, reason: `cell ${cellIndex} icon-library content requires a non-empty name`, offending_cell_index: cellIndex };
  }
  if (c.type === 'emoji' && (typeof c.char !== 'string' || !c.char)) {
    return { ok: false, reason: `cell ${cellIndex} emoji content requires a non-empty char`, offending_cell_index: cellIndex };
  }
  if (c.type === 'upload' && (typeof c.url !== 'string' || !c.url)) {
    return { ok: false, reason: `cell ${cellIndex} upload content requires a non-empty url`, offending_cell_index: cellIndex };
  }
  if (c.type === 'ai-sticker') {
    // The prompt is required (the render contract is "generate then
    // render", and without a prompt the generation has nothing to
    // ground on). The URL is optional pre-generation; cells without
    // it render as a placeholder.
    if (typeof (c as { prompt?: unknown }).prompt !== 'string' || !(c as { prompt: string }).prompt) {
      return { ok: false, reason: `cell ${cellIndex} ai-sticker content requires a non-empty prompt`, offending_cell_index: cellIndex };
    }
  }
  return { ok: true };
}

// ─── Boundary helpers ───────────────────────────────────────────────────────

/**
 * Escape a string for safe interpolation into SVG markup. Any
 * user-supplied text that lands in `<text>`, an attribute value, or
 * the body of an inline `<style>` MUST go through this. Without it a
 * label like `<script>` or `"&"` would either break the SVG parser or
 * smuggle markup into the rasterized output.
 *
 * Mirrors the surface area in `escapePangoText` in
 * `topic-card-grid-composite.ts` but covers single + double quotes too
 * (we use both inside SVG attribute values in the composer).
 */
export function escapeSvgText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Strip control characters and clamp length so user-edited strings
 * coming back from the editor (labels, title bar text) can't smuggle
 * NULs or RTL-override bytes into the rendered output.
 *
 * Codepoint filter mirrors the sibling formats' `sanitizeForPrompt` —
 * the function ended up here because both the optional Step 1 LLM
 * path and the deterministic render path need the same shape of
 * sanitisation.
 */
export function sanitizeUserText(input: string, maxLen = 200): string {
  let out = '';
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 32 && code !== 127) {
      out += s.charAt(i);
    } else if (code === 9 || code === 10 || code === 13) {
      out += ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Apply the configured casing to a label string. The composer calls
 * this once per label right before rendering.
 *
 * `title` uses the simple word-initial-capital rule and intentionally
 * does NOT lowercase the rest of each word — proper nouns like "RAT"
 * or "iOS" stay intact under title case, which is what users expect
 * for a quick title-cased layout. If a future use case wants full
 * "Title Case Lower Rest" treatment we add it as a new variant; we
 * don't change this behaviour out from under existing thumbnails.
 */
export function applyLabelCase(label: string, mode: LabelCase): string {
  if (mode === 'upper') return label.toUpperCase();
  if (mode === 'as-typed') return label;
  // title — capitalise the first letter of each whitespace-delimited
  // word without touching the rest. Empty words preserved.
  return label.replace(/(^|\s)(\S)/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
}

// ─── JSON-shape helpers ─────────────────────────────────────────────────────

/**
 * Defensive parser for a raw config blob — typically a restored history
 * entry. Tolerates missing optional fields by falling back to the
 * defaults; throws on missing required fields with a specific reason so
 * the API can return an actionable 400.
 *
 * Symmetric with `parseCardListResult` / `parseLevelListResult` in the
 * sibling formats: we accept slight shape drift (e.g. older entries
 * that don't yet carry `titleBar` or `cornerRadius`) and normalise.
 */
export function parseConfig(raw: unknown): FlexIconGridConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config is not an object');
  }
  const o = raw as Record<string, unknown>;

  const width = numberOr(o.width, DEFAULT_CANVAS.width);
  const height = numberOr(o.height, DEFAULT_CANVAS.height);
  const rows = numberOr(o.rows, 3);
  const cols = numberOr(o.cols, 5);

  if (!Array.isArray(o.cells)) {
    throw new Error('config.cells must be an array');
  }
  const cells: FlexIconCell[] = o.cells.map((entry, i) => parseCell(entry, i + 1));

  return {
    width,
    height,
    rows,
    cols,
    cellGap: numberOr(o.cellGap, DEFAULT_CELL_GAP),
    outerPadding: numberOr(o.outerPadding, DEFAULT_OUTER_PADDING),
    cornerRadius: numberOr(o.cornerRadius, DEFAULT_CORNER_RADIUS),
    background: parseBackground(o.background),
    palette: parsePalette(o.palette),
    defaultCellShape: parseCellShape(o.defaultCellShape, 'circle'),
    defaultRing: parseRing(o.defaultRing, DEFAULT_RING),
    defaultLabel: parseLabelStyle(o.defaultLabel, DEFAULT_LABEL_STYLE),
    // Phase 4.11: defaultShadow round-trips with the same opt-out
    // semantics as ring (null → off, undefined → none configured).
    defaultShadow: parseShadow(o.defaultShadow),
    // Phase 4.30: defaultCellStroke uses the same null/undefined
    // pattern as defaultShadow.
    defaultCellStroke: parseCellStroke(o.defaultCellStroke),
    // Phase 4.15: palette cursor offset for shuffle. Coerce to a
    // non-negative integer; the resolver takes modulo anyway, but
    // keeping the field tidy makes diff-friendly history entries.
    paletteShuffleOffset: typeof o.paletteShuffleOffset === 'number' && Number.isFinite(o.paletteShuffleOffset)
      ? Math.max(0, Math.floor(o.paletteShuffleOffset))
      : undefined,
    cells,
    titleBar: o.titleBar ? parseTitleBar(o.titleBar) : undefined,
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function parseCellShape(v: unknown, fallback: CellShape): CellShape {
  return typeof v === 'string' && (SUPPORTED_CELL_SHAPES as readonly string[]).includes(v)
    ? (v as CellShape)
    : fallback;
}

function parseBackground(v: unknown): BackgroundSpec {
  if (!v || typeof v !== 'object') return { type: 'solid', color: '#0a0a0a' };
  const o = v as Record<string, unknown>;
  if (o.type === 'gradient') {
    return {
      type: 'gradient',
      from: stringOr(o.from, '#0a0a0a'),
      to: stringOr(o.to, '#0a0a0a'),
      angle: numberOr(o.angle, 180),
    };
  }
  return { type: 'solid', color: stringOr(o.color, '#0a0a0a') };
}

function parsePalette(v: unknown): PaletteSpec {
  if (!v || typeof v !== 'object') return { type: 'preset', name: 'rainbow' };
  const o = v as Record<string, unknown>;
  if (o.type === 'custom' && Array.isArray(o.colors)) {
    return { type: 'custom', colors: o.colors.map((c) => String(c)) };
  }
  const name = String(o.name);
  if (name === 'rainbow' || name === 'pastel' || name === 'neon' || name === 'monochrome') {
    return { type: 'preset', name };
  }
  return { type: 'preset', name: 'rainbow' };
}

function parseRing(v: unknown, fallback: RingStyle): RingStyle {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return fallback;
  const o = v as Record<string, unknown>;
  return {
    color: stringOr(o.color, fallback?.color ?? '#0a0a0a'),
    thickness: numberOr(o.thickness, fallback?.thickness ?? 6),
    style: o.style === 'dashed' ? 'dashed' : 'solid',
  };
}

/** Phase 4.35: tolerant content-offset parser. Drops the field
 *  when missing / non-object; clamps each axis to [-0.5, 0.5] so a
 *  doctored config can't push content off the shape entirely. */
function parseContentOffset(v: unknown): { x: number; y: number } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const x = typeof o.x === 'number' && Number.isFinite(o.x) ? Math.max(-0.5, Math.min(0.5, o.x)) : 0;
  const y = typeof o.y === 'number' && Number.isFinite(o.y) ? Math.max(-0.5, Math.min(0.5, o.y)) : 0;
  if (x === 0 && y === 0) return undefined;
  return { x, y };
}

/** Phase 4.12: tolerant badge parser. `null` round-trips as "explicit
 *  off" so a future config-level default could opt out per cell.
 *  Missing / non-object → undefined. Empty text → undefined so an
 *  emptied badge input clears the badge cleanly. */
function parseBadge(v: unknown): BadgeStyle | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text : '';
  if (text.length === 0) return undefined;
  const corner: BadgeCorner = SUPPORTED_BADGE_CORNERS.includes(o.corner as BadgeCorner)
    ? (o.corner as BadgeCorner)
    : 'top-right';
  // Phase 4.13: badge font is optional; only kept when it's a known
  // token. Custom URL only kept when font === 'custom' — same
  // posture as label / title bar / subtitle parsers, so a stale URL
  // can't bleed through after switching to a bundled font.
  const font: LabelFont | undefined =
    typeof o.font === 'string' &&
    (SUPPORTED_LABEL_FONTS as readonly string[]).includes(o.font)
      ? (o.font as LabelFont)
      : undefined;
  const customFontUrl =
    font === 'custom' && typeof o.customFontUrl === 'string'
      ? o.customFontUrl
      : undefined;
  const customFontLabel =
    font === 'custom' && typeof o.customFontLabel === 'string'
      ? o.customFontLabel
      : undefined;
  return {
    text: text.slice(0, 8),
    corner,
    background: stringOr(o.background, '#fbbf24'),
    color: stringOr(o.color, '#0a0a0a'),
    font,
    customFontUrl,
    customFontLabel,
  };
}

/** Phase 4.11: parse a shadow value tolerantly. `null` round-trips
 *  as "explicit off" (cell-level opt-out from the default). Missing
 *  / non-object values return undefined so the field stays absent
 *  rather than being normalised to a junk shadow. */
function parseShadow(v: unknown): ShadowStyle | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return {
    offsetY: numberOr(o.offsetY, DEFAULT_SHADOW!.offsetY),
    blur: Math.max(0, numberOr(o.blur, DEFAULT_SHADOW!.blur)),
    color: stringOr(o.color, DEFAULT_SHADOW!.color),
    opacity: Math.max(0, Math.min(1, numberOr(o.opacity, DEFAULT_SHADOW!.opacity))),
  };
}

function parseLabelStyle(v: unknown, fallback: LabelStyle): LabelStyle {
  if (!v || typeof v !== 'object') return fallback;
  const o = v as Record<string, unknown>;
  const position = o.position;
  const safePos: LabelStyle['position'] =
    position === 'above' || position === 'overlay' || position === 'hidden'
      ? position
      : 'below';
  const font = (SUPPORTED_LABEL_FONTS as readonly string[]).includes(String(o.font))
    ? (o.font as LabelFont)
    : fallback.font;
  const caseMode = o.case === 'title' || o.case === 'as-typed' ? (o.case as LabelCase) : 'upper';
  const stroke = o.stroke && typeof o.stroke === 'object'
    ? {
        color: stringOr((o.stroke as Record<string, unknown>).color, '#ffffff'),
        thickness: numberOr((o.stroke as Record<string, unknown>).thickness, 2),
      }
    : null;
  const maxLines: 1 | 2 = o.maxLines === 2 ? 2 : 1;
  // Phase 4.7: custom font URL only kept when the font is actually
  // 'custom'. A stale URL from a previous switch shouldn't bleed
  // through to the next render under a different font.
  const customFontUrl =
    font === 'custom' && typeof o.customFontUrl === 'string'
      ? o.customFontUrl
      : undefined;
  const customFontLabel =
    font === 'custom' && typeof o.customFontLabel === 'string'
      ? o.customFontLabel
      : undefined;
  // Phase 4.32: label drop shadow uses the same parseShadow as the
  // title text shadow so the cascade rules are consistent.
  const textShadow = 'textShadow' in o ? parseShadow(o.textShadow) : undefined;
  return {
    position: safePos,
    font,
    case: caseMode,
    color: stringOr(o.color, fallback.color),
    stroke,
    maxLines,
    customFontUrl,
    customFontLabel,
    textShadow,
  };
}

function parseTitleBar(v: unknown): TitleBarSpec {
  const o = (v ?? {}) as Record<string, unknown>;
  const font: LabelFont = (SUPPORTED_LABEL_FONTS as readonly string[]).includes(String(o.font))
    ? (o.font as LabelFont)
    : 'anton';
  // Same posture as the LabelStyle parser: only keep the custom URL
  // when the font is actually 'custom' so a stale value can't bleed
  // through after the user picks a different font.
  const customFontUrl =
    font === 'custom' && typeof o.customFontUrl === 'string' ? o.customFontUrl : undefined;
  const customFontLabel =
    font === 'custom' && typeof o.customFontLabel === 'string' ? o.customFontLabel : undefined;
  // Phase 4.10: subtitle round-trips as plain string; subtitleColor
  // only round-trips when it's a hex string (parseConfig's validator
  // catches malformed hex on the render path, but the JSON parse step
  // tolerates anything string-shaped for restored history entries).
  const subtitle = typeof o.subtitle === 'string' && o.subtitle.length > 0
    ? o.subtitle
    : undefined;
  const subtitleColor = typeof o.subtitleColor === 'string' && o.subtitleColor.length > 0
    ? o.subtitleColor
    : undefined;
  // Phase 4.11: independent subtitle font. Only round-trips when the
  // value is one of the supported font tokens; otherwise falls back
  // to undefined (composer treats undefined as "use the main font").
  // Custom URL only round-trips when font is actually 'custom' — same
  // posture as the main title's customFontUrl, so a stale URL from a
  // previous switch can't bleed into the rendered output.
  const subtitleFont: LabelFont | undefined =
    typeof o.subtitleFont === 'string' &&
    (SUPPORTED_LABEL_FONTS as readonly string[]).includes(o.subtitleFont)
      ? (o.subtitleFont as LabelFont)
      : undefined;
  const subtitleCustomFontUrl =
    subtitleFont === 'custom' && typeof o.subtitleCustomFontUrl === 'string'
      ? o.subtitleCustomFontUrl
      : undefined;
  const subtitleCustomFontLabel =
    subtitleFont === 'custom' && typeof o.subtitleCustomFontLabel === 'string'
      ? o.subtitleCustomFontLabel
      : undefined;
  // Phase 4.15: clamp heightFraction to a sane (0, 1] range so a
  // garbage value doesn't make the title bar fill the canvas.
  const rawFraction = typeof o.heightFraction === 'number' && Number.isFinite(o.heightFraction)
    ? o.heightFraction
    : undefined;
  const heightFraction = rawFraction !== undefined && rawFraction > 0 && rawFraction <= 1
    ? rawFraction
    : undefined;
  return {
    text: stringOr(o.text, ''),
    position:
      o.position === 'top' || o.position === 'overlay-top' || o.position === 'overlay-bottom'
        ? o.position
        : 'bottom',
    height: numberOr(o.height, 96),
    heightFraction,
    background: stringOr(o.background, '#0a0a0a'),
    color: stringOr(o.color, '#fbfbf8'),
    font,
    customFontUrl,
    customFontLabel,
    subtitle,
    subtitleColor,
    subtitleFont,
    subtitleCustomFontUrl,
    subtitleCustomFontLabel,
    // Phase 4.27: title bar shadow follows the same parser as the
    // per-cell shadow so format symmetry stays clean.
    shadow: 'shadow' in o ? parseShadow(o.shadow) : undefined,
    // Phase 4.31: text-only drop shadow uses the same shape.
    textShadow: 'textShadow' in o ? parseShadow(o.textShadow) : undefined,
    // Phase 4.32: subtitle text shadow has the same cascade as the
    // title text shadow but inherits when undefined.
    subtitleTextShadow: 'subtitleTextShadow' in o ? parseShadow(o.subtitleTextShadow) : undefined,
    // Phase 4.28: optional gradient. Parsed tolerantly — drops the
    // field entirely when the object is missing required keys
    // (`from`, `to`) so a doctored config can't sneak a malformed
    // gradient through.
    backgroundGradient: parseTitleBarGradient(o.backgroundGradient),
    // Phase 4.29: strict boolean parsing — anything other than
    // `true` falls back to undefined so a doctored config can't
    // sneak a truthy non-boolean through.
    backgroundTransparent: o.backgroundTransparent === true ? true : undefined,
    textAlign:
      o.textAlign === 'left' || o.textAlign === 'right' || o.textAlign === 'center'
        ? o.textAlign
        : undefined,
    subtitleTextAlign:
      o.subtitleTextAlign === 'left' || o.subtitleTextAlign === 'right' || o.subtitleTextAlign === 'center'
        ? o.subtitleTextAlign
        : undefined,
  };
}

function parseTitleBarGradient(v: unknown): { from: string; to: string; angle: number } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.from !== 'string' || typeof o.to !== 'string') return undefined;
  return {
    from: o.from,
    to: o.to,
    angle: numberOr(o.angle, 180),
  };
}

function parseCell(raw: unknown, expectedIndex: number): FlexIconCell {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`cell at position ${expectedIndex} is not an object`);
  }
  const o = raw as Record<string, unknown>;
  return {
    index: typeof o.index === 'number' ? o.index : expectedIndex,
    label: stringOr(o.label, ''),
    content: parseCellContent(o.content),
    shape: o.shape ? parseCellShape(o.shape, 'circle') : undefined,
    backgroundColor: typeof o.backgroundColor === 'string' ? o.backgroundColor : undefined,
    background: o.background ? parseCellBackground(o.background) : undefined,
    ring: o.ring === null ? null : o.ring ? parseRing(o.ring, DEFAULT_RING) : undefined,
    cellStroke: 'cellStroke' in o ? parseCellStroke(o.cellStroke) : undefined,
    contentOffset: parseContentOffset(o.contentOffset),
    rotation: typeof o.rotation === 'number' && Number.isFinite(o.rotation)
      ? Math.max(-180, Math.min(180, Math.round(o.rotation)))
      : undefined,
    flipX: o.flipX === true ? true : undefined,
    flipY: o.flipY === true ? true : undefined,
    shadow: 'shadow' in o ? parseShadow(o.shadow) : undefined,
    badge: 'badge' in o ? parseBadge(o.badge) : undefined,
    labelStyle: o.labelStyle && typeof o.labelStyle === 'object'
      ? (o.labelStyle as Partial<LabelStyle>)
      : undefined,
    cellSpan: parseCellSpan(o.cellSpan),
  };
}

function parseCellSpan(raw: unknown): { rows: number; cols: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const rows = numberOr(o.rows, 1);
  const cols = numberOr(o.cols, 1);
  if (rows <= 1 && cols <= 1) return undefined;
  return { rows: Math.max(1, Math.round(rows)), cols: Math.max(1, Math.round(cols)) };
}

function parseCellBackground(raw: unknown): CellBackgroundSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const type = String(o.type);
  if (type === 'gradient') {
    return {
      type: 'gradient',
      from: stringOr(o.from, '#000000'),
      to: stringOr(o.to, '#ffffff'),
      angle: numberOr(o.angle, 180),
    };
  }
  if (type === 'pattern') {
    const pattern = SUPPORTED_PATTERN_NAMES.includes(o.pattern as PatternName)
      ? (o.pattern as PatternName)
      : 'dots';
    return {
      type: 'pattern',
      pattern,
      fg: stringOr(o.fg, '#000000'),
      bg: stringOr(o.bg, '#ffffff'),
    };
  }
  if (type === 'image') {
    return { type: 'image', url: stringOr(o.url, '') };
  }
  return { type: 'solid', color: stringOr(o.color, '#0a0a0a') };
}

function parseCellContent(raw: unknown): CellContent {
  if (!raw || typeof raw !== 'object') return { type: 'text-only' };
  const o = raw as Record<string, unknown>;
  const type = String(o.type);
  if (type === 'icon-library') return { type: 'icon-library', name: String(o.name ?? '') };
  if (type === 'emoji') return { type: 'emoji', char: String(o.char ?? '') };
  // Phase 4.34: image fit mode for upload + ai-sticker. Only kept
  // when the raw value is one of the three supported tokens.
  const fit: ImageFitMode | undefined =
    o.fit === 'cover' || o.fit === 'contain' || o.fit === 'fill'
      ? o.fit
      : undefined;
  // Phase 4.36: image filter mode. 'none' rounds to undefined since
  // it's the same as no filter; round-trips stay tidy.
  const rawFilter = typeof o.filter === 'string' ? o.filter : undefined;
  const filter: ImageFilterMode | undefined =
    rawFilter && rawFilter !== 'none' &&
    (SUPPORTED_IMAGE_FILTERS as readonly string[]).includes(rawFilter)
      ? (rawFilter as ImageFilterMode)
      : undefined;
  if (type === 'upload') {
    return {
      type: 'upload',
      url: String(o.url ?? ''),
      ...(fit ? { fit } : {}),
      ...(filter ? { filter } : {}),
    };
  }
  if (type === 'ai-sticker') {
    const prompt = String(o.prompt ?? '');
    const url = o.url ? String(o.url) : undefined;
    const style = o.style ? String(o.style) : undefined;
    return {
      type: 'ai-sticker',
      prompt,
      ...(url ? { url } : {}),
      ...(style ? { style } : {}),
      ...(fit ? { fit } : {}),
      ...(filter ? { filter } : {}),
    };
  }
  return { type: 'text-only' };
}
