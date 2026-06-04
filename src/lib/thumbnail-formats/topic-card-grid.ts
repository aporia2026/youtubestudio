/**
 * Topic Card Grid — pure module
 *
 * Format that produces a YouTube thumbnail as an N×M grid of cards. Each card
 * holds a single bold central icon on a dark illustration on top and a clean
 * white label strip with the card's title on the bottom. Reference grids in
 * the plan; see _plans/2026-05-19-thumbnail-format-topic-card-grid.md.
 *
 * Pure module: no network, no React, no Next.js — only string + math + a
 * deterministic uuid for region ids (injected by the caller so tests stay
 * deterministic). Everything here is unit-testable.
 *
 * Three public surfaces:
 *  - `topicCardGridLlmPrompt(...)` — Step 1 prompt builder (LLM card list).
 *  - `topicCardGridImagePrompt(...)` — Step 2 prompt builder (GPT Image 2).
 *  - `computeRegions(...)` — deterministic region rectangles for the rendered
 *    grid. Used in production-doc without a vision pass.
 *
 * Plus a validator and a server-side banlist that gates the LLM's card list
 * before it is interpolated into the image prompt — the mechanism that
 * enforces the "simple iconic cards, no embedded text, no busy scenes" rule
 * structurally rather than via prompt persuasion. The banlist is the most
 * important quality lever in this whole feature.
 */

import type { ThumbnailRegion } from '@/remotion/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TopicCard {
  /** Position in the grid, 1-based, reading order (left-to-right, top-to-bottom). */
  index: number;
  /** Short title shown in the white label strip. 1–4 words ideally. */
  label: string;
  /** Verbal description of the single central icon/symbol for this card.
   *  Must NOT contain banned phrases (text, screenshot, UI, person, face,
   *  scene). The LLM is instructed to produce this; the server validates it. */
  icon_concept: string;
  /** Optional per-card accent color. Falls back to the global palette accent. */
  accent_color?: string;
  /** Original uploaded photo URL (R2-mirrored). Persists across `fillStyle`
   *  toggles so re-applying a cutout doesn't require a fresh upload. Only
   *  populated when the user uploads a photo for this card. */
  sourceImageUrl?: string;
  /** Background-removed PNG URL (R2-mirrored). Populated by the
   *  `/api/thumbnails/grid-rmbg` route the first time the user picks the
   *  `cutout` fill style on this card. Cached so toggling fillStyle is free
   *  after the first call. */
  cutoutImageUrl?: string;
  /** Optional Lucide-icon slug from the shared `ICON_REGISTRY` (see
   *  `flex-icon-grid-icons.ts`). When set AND the layout's
   *  `fillStyle === 'icon'`, the composite paints a flat accent disc
   *  plus the inline icon SVG at ~50 % disc diameter. When unset and
   *  `fillStyle === 'icon'`, the composite degrades to a plain accent
   *  disc with a console warning so the gap surfaces in logs. */
  iconSlug?: string;
}

/**
 * Optional palette guidance. Pre-1.5 this was hard-required and we forced it
 * into every card; that produced uniform red/amber-on-black grids regardless
 * of subject and stopped the model from rendering brand-accurate visuals
 * (Sony in real Sony blue, Yahoo in real Yahoo purple, etc.). The new shape:
 * the LLM may suggest a palette as a soft hint, but the image prompt does
 * NOT enforce it — each card uses whatever colors fit the subject naturally.
 *
 * Keep the field on the type for backwards compatibility with stored history
 * entries; new generations may emit a default `#000000 / inherit / inherit`
 * shape if the LLM doesn't supply one. Consumers should treat it as
 * informational, not load-bearing.
 */
export interface GlobalPalette {
  background: string;
  primary_accent: string;
  secondary_accent: string;
}

export interface CardListResult {
  cards: TopicCard[];
  /** Optional. See `GlobalPalette` — informational only post-1.5. */
  global_palette: GlobalPalette;
  /** Optional free-form note from the LLM that we forward to the image prompt
   *  (e.g. "rim-lit treatment across all cards"). Sanitised before use. */
  notes_for_image_model?: string;
}

export interface GridLayout {
  /** Output image width in pixels. */
  width: number;
  /** Output image height in pixels. */
  height: number;
  rows: number;
  cols: number;
  /** White outer margin in pixels (top/right/bottom/left, uniform). */
  outerMargin: number;
  /** White gutter between cards in pixels. Used for horizontal spacing
   *  between columns, and as the vertical spacing fallback when
   *  `rowGutter` is not set. */
  gutter: number;
  /** Optional override for the vertical gap between rows. When omitted,
   *  circle cards get `gutter * 1.8` automatically (otherwise labels visually
   *  butt against the next row's discs), and square cards stay at `gutter`.
   *  Set explicitly to dial it tighter or airier. Pixels. */
  rowGutter?: number;
  /** Visual card shape. `'square'` keeps the original layout: a black-bordered
   *  rectangle split into an illustration region (top) and a white label
   *  strip (bottom). `'circle'` renders each card as a borderless disc with
   *  the label centred in the gutter below. Defaults to `'square'` when
   *  omitted so older history entries hydrate cleanly. */
  cardShape?: CardShape;
  /** Cartoon-outline thickness. `'thin'` ≈ 0.6% of cell width (matches the
   *  legacy default), `'thick'` ≈ 1.6% (bold doodle stroke). Default
   *  `'thin'`. Per-cell `borderPx` overrides this if explicitly set. */
  borderWeight?: BorderWeight;
  /** Where the card's label sits relative to the disc. `'below'` is the
   *  classic floating label; `'overlap'` places the label so its top crosses
   *  the disc's bottom edge by ~12 % of disc diameter, rendered with a
   *  stroked outline so it stays readable. Default `'below'`. */
  labelPosition?: LabelPosition;
  /** `'title'` keeps the source string casing; `'upper'` applies
   *  `text-transform: uppercase`. Source string is never mutated.
   *  Default `'title'`. */
  labelCase?: LabelCase;
  /** How the disc is filled. `'photo'` (default) covers the disc with the
   *  uploaded image. `'cutout'` paints `accent_color` and overlays the
   *  background-removed subject. `'icon'` paints `accent_color` and centres
   *  the AI-generated flat icon (existing `icon_concept` path). */
  fillStyle?: FillStyle;
  /** Only used when `labelPosition === 'overlap'`. Picks the colour pairing
   *  for the stroked label. Default `'white-on-black'`. */
  overlapLabelStroke?: OverlapLabelStroke;
}

/** Visual shape of each card. See `GridLayout.cardShape` for the contract. */
export type CardShape = 'square' | 'circle';

/** See `GridLayout.borderWeight`. */
export type BorderWeight = 'thin' | 'thick';
/** See `GridLayout.labelPosition`. */
export type LabelPosition = 'below' | 'overlap';
/** See `GridLayout.labelCase`. */
export type LabelCase = 'title' | 'upper';
/** See `GridLayout.fillStyle`. */
export type FillStyle = 'photo' | 'cutout' | 'icon';
/** See `GridLayout.overlapLabelStroke`. */
export type OverlapLabelStroke = 'white-on-black' | 'black-on-white';

/**
 * Six named card-style presets that map to all 5 axes at once. The preset
 * picker in the editor flips every axis when the user clicks one; per-axis
 * controls remain editable below so users can fine-tune. The source of
 * truth for the rendered state is the six axis fields themselves, not the
 * preset name — clicking a preset is a one-shot writer.
 *
 * Each preset is named after the competitor reference style it produces.
 */
export type CardStylePreset =
  | 'photo-tile'
  | 'cutout-pop'
  | 'icon-grid'
  | 'caps-overlay'
  | 'mystery-doc'
  | 'cartoon-bold';

/** Resolve a preset name to the six axis values it sets. The
 *  `cardShape` is always `'circle'` for these presets — the parity work
 *  is all about the circle genre. */
export function cardStylePresetAxes(preset: CardStylePreset): {
  cardShape: CardShape;
  borderWeight: BorderWeight;
  labelPosition: LabelPosition;
  labelCase: LabelCase;
  fillStyle: FillStyle;
  overlapLabelStroke: OverlapLabelStroke;
} {
  switch (preset) {
    case 'photo-tile':
      return {
        cardShape: 'circle',
        borderWeight: 'thin',
        labelPosition: 'below',
        labelCase: 'title',
        fillStyle: 'photo',
        overlapLabelStroke: 'white-on-black',
      };
    case 'cutout-pop':
      return {
        cardShape: 'circle',
        borderWeight: 'thick',
        labelPosition: 'below',
        labelCase: 'title',
        fillStyle: 'cutout',
        overlapLabelStroke: 'white-on-black',
      };
    case 'icon-grid':
      return {
        cardShape: 'circle',
        borderWeight: 'thick',
        labelPosition: 'below',
        labelCase: 'title',
        fillStyle: 'icon',
        overlapLabelStroke: 'white-on-black',
      };
    case 'caps-overlay':
      return {
        cardShape: 'circle',
        borderWeight: 'thin',
        labelPosition: 'overlap',
        labelCase: 'upper',
        fillStyle: 'photo',
        overlapLabelStroke: 'white-on-black',
      };
    case 'mystery-doc':
      // Visually distinct from `'caps-overlay'` (its sibling overlap+
      // upper preset) by inverting the stroke pairing. caps-overlay
      // = white fill on black outline (pops on coloured photos);
      // mystery-doc = black fill on white outline (reads like a
      // document caption stamped on the thumb, matches the doc-style
      // reference the preset is named after). QA review #13 — before
      // this change both presets produced byte-identical renders.
      return {
        cardShape: 'circle',
        borderWeight: 'thin',
        labelPosition: 'overlap',
        labelCase: 'upper',
        fillStyle: 'photo',
        overlapLabelStroke: 'black-on-white',
      };
    case 'cartoon-bold':
      return {
        cardShape: 'circle',
        borderWeight: 'thick',
        labelPosition: 'below',
        labelCase: 'title',
        fillStyle: 'photo',
        overlapLabelStroke: 'white-on-black',
      };
  }
}

/** UI-display metadata for each preset — used by the preset row in
 *  `TopicCardGridPanel`. Stays alongside `cardStylePresetAxes` so the
 *  two never drift out of sync. */
export const CARD_STYLE_PRESETS: Array<{
  id: CardStylePreset;
  label: string;
  description: string;
}> = [
  { id: 'photo-tile', label: 'Photo Tile', description: 'Thin border, photo fill, label below.' },
  { id: 'cutout-pop', label: 'Cutout Pop', description: 'Thick border, subject on solid colour.' },
  { id: 'icon-grid', label: 'Icon Grid', description: 'Thick border, flat icon on solid colour.' },
  { id: 'caps-overlay', label: 'Caps Overlay', description: 'White-on-black uppercase label overlapping the disc.' },
  { id: 'mystery-doc', label: 'Mystery Doc', description: 'Black-on-white uppercase label overlapping the disc; pair with a B&W filter.' },
  { id: 'cartoon-bold', label: 'Cartoon Bold', description: 'Heavy cartoon outline, photo fill, title-case.' },
];

// ─── Layout math ────────────────────────────────────────────────────────────

/** Default canvas size. 16:9, comfortable for YouTube; the resolution
 *  GPT Image 2 reliably renders at via Kie's 1K aspect ratio bucket. */
export const DEFAULT_CANVAS = { width: 1280, height: 720 } as const;

/**
 * Derive the outer-margin / gutter widths for a given canvas width.
 * The references the user shared have margin and gutter visually equal — we
 * standardise on that. Width is ~1.1% of canvas width (≈14 px at 1280, ≈21 px
 * at 1920); minimum 8 px so very small canvases still show borders.
 */
export function defaultGutter(width: number): number {
  return Math.max(8, Math.round(width * 0.011));
}

/**
 * Resolve the effective vertical gap between rows. Explicit `rowGutter`
 * wins; otherwise circle layouts get `gutter * 1.8` because the label
 * sits below the disc and would visually crowd the next row's disc on
 * a uniform gutter (see the reference SCP / Mystery Doc thumbnails for
 * what comfortable spacing looks like). Square layouts stay at `gutter`
 * — their cells share borders / dividers and a tight gutter reads fine.
 */
export function effectiveRowGutter(layout: GridLayout): number {
  if (typeof layout.rowGutter === 'number') return Math.max(0, Math.round(layout.rowGutter));
  return layout.cardShape === 'circle'
    ? Math.round(layout.gutter * 1.8)
    : layout.gutter;
}

export function makeDefaultLayout(
  rows: number,
  cols: number,
  width: number = DEFAULT_CANVAS.width,
  height: number = DEFAULT_CANVAS.height,
  cardShape: CardShape = 'square',
): GridLayout {
  const g = defaultGutter(width);
  return { width, height, rows, cols, outerMargin: g, gutter: g, cardShape };
}

/**
 * Compute the rectangle of every card in the grid. Cards are returned in
 * reading order (left-to-right, top-to-bottom) so callers can pair them up
 * with the `TopicCard.index` 1-based numbering directly.
 *
 * `mkId` lets tests inject a deterministic id generator; production callers
 * pass `crypto.randomUUID`. We don't import crypto here to keep this module
 * runtime-agnostic.
 */
export function computeRegions(
  layout: GridLayout,
  labels: string[],
  mkId: () => string,
): ThumbnailRegion[] {
  const { width, height, rows, cols, outerMargin: om, gutter: g } = layout;
  const rg = effectiveRowGutter(layout);
  const cardW = (width - 2 * om - (cols - 1) * g) / cols;
  const cardH = (height - 2 * om - (rows - 1) * rg) / rows;
  const regions: ThumbnailRegion[] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = om + c * (cardW + g);
      const y = om + r * (cardH + rg);
      regions.push({
        id: mkId(),
        label: labels[i] ?? `Card ${i + 1}`,
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(cardW),
        h: Math.round(cardH),
      });
      i++;
    }
  }
  return regions;
}

// ─── Circle-mode geometry ───────────────────────────────────────────────────

/**
 * Geometry for a single circular card. The disc occupies the top portion of
 * the cell rectangle; the label band sits beneath it inside the same cell.
 *
 * Returned values are floats so callers (the composite module, the region
 * builder) can decide where rounding lands — rounding too eagerly here would
 * leave the disc subtly off-centre.
 */
export interface CircleCellGeometry {
  /** Cell bounding box — left edge x in canvas pixels. */
  cellX: number;
  /** Cell bounding box — top edge y in canvas pixels. */
  cellY: number;
  /** Cell width in canvas pixels. */
  cellW: number;
  /** Cell height in canvas pixels. */
  cellH: number;
  /** Disc centre x in canvas pixels. */
  discCx: number;
  /** Disc centre y in canvas pixels. */
  discCy: number;
  /** Disc diameter in canvas pixels. */
  discD: number;
  /** Label band left edge x in canvas pixels. */
  labelX: number;
  /** Label band top edge y in canvas pixels. */
  labelY: number;
  /** Label band width in canvas pixels. */
  labelW: number;
  /** Label band height in canvas pixels. */
  labelH: number;
}

/** Fraction of the smaller cell dimension the disc diameter targets.
 *  `cardW * 0.9` and `cardH * 0.7` together leave a small breathing margin
 *  around the disc and a ~25% strip below for the label. The plan calls these
 *  out explicitly — see `_plans/2026-05-19-topic-card-grid-circles-and-uploads.md`. */
const DISC_W_FRAC = 0.9;
const DISC_H_FRAC = 0.7;
const DISC_TOP_PAD_FRAC = 0.04; // 4% of cellH between the cell top and the disc top.

/**
 * Compute the disc + label band geometry for a single cell. Exported so the
 * composite module can paint discs / labels at exactly the positions
 * `computeCircleRegions` reports.
 */
export function circleCellGeometry(
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
): CircleCellGeometry {
  const discD = Math.min(cellW * DISC_W_FRAC, cellH * DISC_H_FRAC);
  const topPad = cellH * DISC_TOP_PAD_FRAC;
  const discCx = cellX + cellW / 2;
  const discCy = cellY + topPad + discD / 2;
  const labelY = cellY + topPad + discD;
  const labelH = cellH - (topPad + discD);
  const labelX = cellX + cellW * 0.025;
  const labelW = cellW * 0.95;
  return {
    cellX,
    cellY,
    cellW,
    cellH,
    discCx,
    discCy,
    discD,
    labelX,
    labelY,
    labelW,
    labelH,
  };
}

/**
 * Circle-mode region rectangles. Each region's `x/y/w/h` is the disc's
 * bounding box — production-doc consumes rect regions and doesn't need to
 * know the visual is circular. Label band is intentionally not in the
 * region (consistent with the square-mode behaviour where the label strip
 * is also excluded).
 */
export function computeCircleRegions(
  layout: GridLayout,
  labels: string[],
  mkId: () => string,
): ThumbnailRegion[] {
  const { width, height, rows, cols, outerMargin: om, gutter: g } = layout;
  const rg = effectiveRowGutter(layout);
  const cardW = (width - 2 * om - (cols - 1) * g) / cols;
  const cardH = (height - 2 * om - (rows - 1) * rg) / rows;
  const regions: ThumbnailRegion[] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellX = om + c * (cardW + g);
      const cellY = om + r * (cardH + rg);
      const geom = circleCellGeometry(cellX, cellY, cardW, cardH);
      const discLeft = geom.discCx - geom.discD / 2;
      const discTop = geom.discCy - geom.discD / 2;
      regions.push({
        id: mkId(),
        label: labels[i] ?? `Card ${i + 1}`,
        x: Math.round(discLeft),
        y: Math.round(discTop),
        w: Math.round(geom.discD),
        h: Math.round(geom.discD),
      });
      i++;
    }
  }
  return regions;
}

/**
 * Shape-aware region builder. Dispatches to the rectangle math
 * (`computeRegions`) for square cards and the disc bounding-box math
 * (`computeCircleRegions`) for circle cards. Callers should prefer this
 * over the per-shape helpers so adding new shapes later stays a one-line
 * change at the dispatch site.
 */
export function computeRegionsFor(
  layout: GridLayout,
  labels: string[],
  mkId: () => string,
  shape: CardShape = layout.cardShape ?? 'square',
): ThumbnailRegion[] {
  if (shape === 'circle') return computeCircleRegions(layout, labels, mkId);
  return computeRegions(layout, labels, mkId);
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Card concepts the model should NOT produce. r2 re-introduces a narrow
 * set of regexes after a real GPT-4o run on the Cybersecurity niche
 * produced exactly the multi-element UI mockups the prompt told it not
 * to make ("a browser window with a bold red warning overlay...", "an
 * email inbox with a highlighted message...", "an installer wizard with
 * a tiny checkbox..."). These were the dominant failure mode the empty
 * r1.5 banlist's comment predicted: "Add a narrow regex here if a
 * specific failure mode... starts dominating outputs."
 *
 * The regexes are deliberately narrow. They catch the specific phrase
 * patterns that signal "I'm describing a multi-element UI mockup as the
 * icon" without false-positiving on legitimate uses:
 * - "a [browser/dialog] window with..." — catches the multi-element
 *   dialog description; doesn't catch "Microsoft Windows logo".
 * - "an [email inbox/email client] with..." — catches the inbox mockup;
 *   doesn't catch "an envelope" or "a fishing hook through an envelope".
 * - "an [installer/setup] wizard with..." — catches the wizard mockup;
 *   doesn't catch "a wizard hat" or "Bonzi Buddy" descriptions.
 * - "scanner [results/ui/table]" — catches the scanner mockup.
 * - 'showing/displaying/containing "..."' — catches "showing 'VIRUS
 *   ALERT!'" embedded-text descriptions. Specific named subjects whose
 *   icon IS text (a brand wordmark) describe it as "the YAHOO! wordmark"
 *   or "the Microsoft logotype", not "containing 'Microsoft'".
 * - "with a/multiple [button/checkbox/...]" — catches multi-control UI
 *   descriptions; the singular permitted form ("a button-shaped icon")
 *   is unaffected.
 *
 * Authentic-to-subject embedded text (the actual WannaCry ransom screen,
 * the actual ILOVEYOU file extension) is still fine — those describe the
 * canonical visual identity of a SPECIFIC named entity and use phrases
 * like "the WannaCry ransom screen" or "the ILOVEYOU email", not the
 * banned multi-element shapes above.
 */
export const ICON_CONCEPT_BANLIST: readonly { match: RegExp; reason: string }[] = [
  {
    match: /\b(?:a |an )?(?:browser|dialog) window with\b/i,
    reason: 'multi-element browser/dialog mockup — use a single iconic symbol (e.g. a giant warning shield) instead',
  },
  {
    match: /\b(?:an? )?(?:email inbox|email client) with\b/i,
    reason: 'multi-element email-client mockup — use a single iconic symbol (e.g. a fishing hook through an envelope) instead',
  },
  {
    match: /\b(?:an? )?(?:installer|setup) wizard with\b/i,
    reason: 'multi-element installer-wizard mockup — use a single iconic symbol (e.g. a wrapped gift box with a skull) instead',
  },
  {
    match: /\bscanner\s+(?:results|ui|table)\b/i,
    reason: 'scanner-results-table mockup — use a single iconic symbol (e.g. a magnifying glass over a skull) instead',
  },
  {
    match: /\b(?:showing|displaying|containing)\s+['"]/i,
    reason: 'embedded-text description (e.g. showing \'VIRUS ALERT!\') — describe the visual itself, not the text inside it',
  },
  {
    match: /\bwith\s+(?:a|an|multiple|several|two|three|four)\s+(?:buttons?|checkboxes?|progress\s+bars?|tabs?|panels?|fields?|menus?|toolbars?|sidebars?)\b/i,
    reason: 'multi-control UI description — pick one bold iconic visual, not a UI mockup',
  },
];

/** Hard caps the validator enforces on the LLM's output. Sized to fit a
 *  single line in the 20%-height label band at the deterministic font
 *  size — anything past these caps wraps to two lines and the layout
 *  starts to crowd.
 *
 *  22 chars / 3 words was picked by measuring the band capacity at the
 *  default 1280×720 canvas with the bundled Patrick Hand font: "Fake
 *  Virus Warnings" (19 chars, 3 words) fits comfortably; "Phishing
 *  Emails and Tech Support Scams" (38 chars, 6 words) wraps. The cap
 *  catches anything over the safe line. */
export const MAX_LABEL_CHARS = 22;
export const MAX_LABEL_WORDS = 3;

/** Hard cap on `icon_concept` length. 80 chars fits a single sentence
 *  describing one bold central symbol. The previous effective cap (250
 *  chars via `sanitizeForPrompt`) was large enough to fit a multi-
 *  element UI mockup description, which is exactly what GPT-4o produced
 *  when told not to. Structural concision forces iconic descriptions. */
export const MAX_ICON_CONCEPT_CHARS = 80;

/** Words that signal a "negative" subject (scam, attack, threat) where a
 *  green or pure-blue accent color reads semantically wrong (green = safe
 *  / trusted, blue = corporate / brand). Used by the validator to reject
 *  the specific color/meaning mismatch seen in real runs ("Fake Online
 *  Scanners" with a green shield reads as legitimate antivirus, not as
 *  the scam it labels). */
const NEGATIVE_CONCEPT_RE = /\b(?:fake|scam|phish(?:ing)?|malicious|malware|ransomware|breach|attack|threat|fraud|exploit|hack(?:ing|er)?|virus|trojan|worm|spyware|rogue)\b/i;

/** Hex colors that read as safe/trusted/legit. Tight list, not a fuzzy
 *  range — false positives here would block legitimate cards. Picked by
 *  sampling the LLM's typical "wrong" choices (#00FF00 lime, #4CAF50
 *  Material green, #2196F3 Material blue, etc.) and rounding to nearest
 *  named ranges. We don't enforce a regex over the full hex space —
 *  too risky. */
const SAFE_READING_COLOR_RES: readonly RegExp[] = [
  // Pure greens
  /^#(?:0[0-9a-f]|1[0-9a-f]|2[0-9a-f]|3[0-9a-f])(?:[8-9a-f][0-9a-f])(?:0[0-9a-f]|1[0-9a-f]|2[0-9a-f]|3[0-9a-f])$/i,
  // Common named green/blue palette entries
  /^#(?:00ff00|00e676|4caf50|2e7d32|66bb6a|81c784|a5d6a7|c8e6c9|388e3c|43a047|2196f3|1976d2|0d47a1|03a9f4|00bcd4)$/i,
];

/** Check whether a hex color reads as safe/trusted (green/blue family).
 *  Exported for tests. Returns false for any non-hex input so the
 *  validator is permissive on shapes it doesn't understand. */
export function readsAsSafeColor(hex: string | undefined): boolean {
  if (!hex || typeof hex !== 'string') return false;
  const trimmed = hex.trim();
  if (!/^#[0-9a-f]{6}$/i.test(trimmed)) return false;
  return SAFE_READING_COLOR_RES.some((re) => re.test(trimmed));
}

/** Count words in a label. Splits on runs of whitespace, ignoring empty
 *  fragments. Hyphenated tokens ("anti-virus") count as one word — the
 *  visual line cost is one token's worth. */
export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; offending_card_index?: number };

/**
 * Validate a card list against the grid count + the banlist. Caller chooses
 * what to do on `ok: false` — typically: one retry with a tightened prompt
 * citing the specific offending card and reason, then surface to the user.
 */
export function validateCardList(
  cards: TopicCard[],
  expectedCount: number,
): ValidationResult {
  if (!Array.isArray(cards)) return { ok: false, reason: 'cards is not an array' };
  if (cards.length !== expectedCount) {
    return {
      ok: false,
      reason: `Expected exactly ${expectedCount} cards but got ${cards.length}.`,
    };
  }
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (!c || typeof c !== 'object') {
      return { ok: false, reason: `Card ${i + 1} is not an object.`, offending_card_index: i };
    }
    const label = (c.label || '').toString().trim();
    const icon = (c.icon_concept || '').toString().trim();
    if (!label) return { ok: false, reason: `Card ${i + 1} has no label.`, offending_card_index: i };
    if (!icon) return { ok: false, reason: `Card ${i + 1} has no icon_concept.`, offending_card_index: i };
    if (label.length > MAX_LABEL_CHARS) {
      return {
        ok: false,
        reason: `Card ${i + 1} label "${label}" is too long (${label.length} chars; max ${MAX_LABEL_CHARS}). Shorten it so it fits one line in the label band.`,
        offending_card_index: i,
      };
    }
    const wordCount = countWords(label);
    if (wordCount > MAX_LABEL_WORDS) {
      return {
        ok: false,
        reason: `Card ${i + 1} label "${label}" has too many words (${wordCount}; max ${MAX_LABEL_WORDS}). Shorten it so it fits one line in the label band.`,
        offending_card_index: i,
      };
    }
    if (icon.length > MAX_ICON_CONCEPT_CHARS) {
      return {
        ok: false,
        reason: `Card ${i + 1} icon_concept is too long (${icon.length} chars; max ${MAX_ICON_CONCEPT_CHARS}). Describe ONE bold central symbol in a single short sentence.`,
        offending_card_index: i,
      };
    }
    for (const banned of ICON_CONCEPT_BANLIST) {
      if (banned.match.test(icon)) {
        return {
          ok: false,
          reason: `Card ${i + 1} icon_concept describes a ${banned.reason}.`,
          offending_card_index: i,
        };
      }
    }
    // Semantic color guard: scam / attack / threat labels paired with a
    // green or pure-blue accent read as "safe / trusted antivirus" — the
    // opposite of the card's meaning. Reject so the LLM picks again. This
    // only fires when BOTH the label is clearly negative AND the accent
    // is in the tight safe-reading palette; neutral labels and other
    // colors pass through untouched.
    if (c.accent_color && NEGATIVE_CONCEPT_RE.test(label) && readsAsSafeColor(c.accent_color)) {
      return {
        ok: false,
        reason: `Card ${i + 1} label "${label}" is a negative concept (scam/attack/threat) but its accent_color "${c.accent_color}" reads as safe/trusted. Pick a red, orange, or warning-yellow accent instead.`,
        offending_card_index: i,
      };
    }
    // iconSlug is sanitised lazily by `sanitizeCardIconSlug` from the
    // route layer (only when the request's `fillStyle === 'icon'`).
    // We deliberately do NOT reject malformed slugs here because the
    // editor's icon-slug input is conditional on fillStyle, so a user
    // can leave a malformed slug attached to a card after toggling
    // fillStyle off — the render shouldn't fail in that case.
  }
  return { ok: true };
}

/**
 * Sanitise a single `iconSlug` value to the canonical kebab-case shape
 * the renderer expects. Returns the trimmed slug when valid, or the
 * empty string when not. Empty / undefined / malformed input all
 * collapse to the empty string, which the composite treats as
 * "no icon, fall back to plain accent disc".
 *
 * Called from the `/image` route only when `fillStyle === 'icon'`, so
 * a stale slug attached to a card whose fillStyle was toggled off
 * can't fail the render with a 400.
 *
 * Kebab-case (`[a-z0-9-]+`) ≤ 64 chars matches the shape Lucide's
 * registry uses. We can't validate against `ICON_REGISTRY` here
 * without a circular import (the registry pulls in lucide-static),
 * so the composite's icon branch handles unknown-but-well-formed
 * slugs by falling back to a plain accent disc + console warning.
 */
export function sanitizeCardIconSlug(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  const slug = String(raw).trim();
  if (!slug) return '';
  if (slug.length > 64) return '';
  if (!/^[a-z0-9-]+$/.test(slug)) return '';
  return slug;
}

/**
 * Strip control chars + clip length so user-edited or LLM-generated text
 * can't smuggle prompt-injection payloads into the image prompt. Applied at
 * the boundary right before interpolation.
 *
 * Uses a codepoint filter (not a regex character class) because the source
 * file kept getting written with embedded control bytes when this was
 * implemented as a regex range.
 */
export function sanitizeForPrompt(input: string, maxLen = 200): string {
  let out = '';
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // Drop C0 controls (0..31) and DEL (127). Keep printable ASCII + all
    // Unicode beyond. Whitespace runs are collapsed below.
    if (code >= 32 && code !== 127) {
      out += s.charAt(i);
    } else if (code === 9 || code === 10 || code === 13) {
      // Tabs and line breaks become a single space.
      out += ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// ─── Prompt builders ────────────────────────────────────────────────────────

export interface LlmPromptInput {
  title: string;
  niche: string;
  script?: string;
  description?: string;
  gridRows: number;
  gridCols: number;
  /** Pre-filled labels for "Pre-fill" mode. If present, the LLM only fills in
   *  the `icon_concept` per provided label and keeps the labels verbatim. */
  prefilledLabels?: string[];
  /** Visual card shape. Defaults to `'square'` if omitted. Influences the
   *  prompt's stylistic guidance — circles tend to suit simpler, single-
   *  subject icons that read cleanly inside a disc. */
  cardShape?: CardShape;
  /** 1-based cell indexes the user has already uploaded an image for. For
   *  each listed cell, the LLM is told to emit a `USER_UPLOADED_IMAGE`
   *  sentinel as the icon_concept and produce a label only. The composite
   *  step (server-side, post-image-gen) paints the user's image into the
   *  cell deterministically, so the AI's rendering of that cell doesn't
   *  matter — the prompt nudge just keeps the model from wasting tokens
   *  inventing an icon that will be overpainted. */
  uploadedCellIndexes?: number[];
}

/**
 * Step 1 prompt. The LLM produces an ordered card list + a global palette.
 * Multimodal: the reference image is attached by the caller via
 * `generateText({ image })`; this prompt just refers to it.
 */
export function topicCardGridLlmPrompt(input: LlmPromptInput): { system: string; user: string } {
  const {
    title,
    niche,
    script,
    description,
    gridRows,
    gridCols,
    prefilledLabels,
    cardShape = 'square',
    uploadedCellIndexes,
  } = input;
  const total = gridRows * gridCols;
  const usingPrefilled = !!prefilledLabels && prefilledLabels.length === total;
  // Dedup + clamp uploaded indexes server-side. The route also validates,
  // but defending against a stale client is cheap here and keeps the prompt
  // builder useful in tests.
  const uploadedIdxSet = new Set<number>();
  if (uploadedCellIndexes) {
    for (const n of uploadedCellIndexes) {
      if (Number.isInteger(n) && n >= 1 && n <= total) uploadedIdxSet.add(n);
    }
  }
  const uploadedIdxList = [...uploadedIdxSet].sort((a, b) => a - b);

  const system = `You are designing a YouTube thumbnail in the "Topic Card Grid" format. The thumbnail is an N×M grid of cards. Each card has an illustration region on top and a white label strip on the bottom. The grid is informational: it previews the video's content at a glance with each card showing one of the things the video covers.

YOUR JOB: produce exactly ${total} card entries (the user has chosen a ${gridRows}×${gridCols} grid).

HARD STRUCTURAL CAPS (the server rejects card lists that violate these — no second chance after the retry):
- Each \`label\` is **at most ${MAX_LABEL_CHARS} characters** AND **at most ${MAX_LABEL_WORDS} words**. The label band can hold ONE line at the deterministic font size; anything longer wraps and looks crowded. Examples that fit: "Fake Virus Warnings" (19 chars / 3 words), "Phishing Emails" (15 chars / 2 words). Examples that DON'T fit and get rejected: "400 Million Dollars Every Year" (5 words), "Phishing Emails and Tech Support Scams" (6 words).
- Each \`icon_concept\` is **at most ${MAX_ICON_CONCEPT_CHARS} characters** and describes ONE bold central symbol in a single short sentence. If you find yourself writing more than one clause, you're describing a multi-element scene — stop and pick a single iconic symbol instead.

FORBIDDEN icon_concept PATTERNS (server-rejected, picked from real failure modes — DO NOT produce these):
- "a browser window with..." / "a dialog window with..."
- "an email inbox with..." / "an email client with..."
- "an installer wizard with..." / "a setup wizard with..."
- "scanner results / scanner UI / scanner table"
- "...showing 'X'" / "...displaying 'X'" / "...containing 'X'" (embedded-text descriptions — describe the visual itself, not the literal text inside it)
- "with multiple/several buttons / checkboxes / progress bars / tabs / panels / fields / menus" (multi-control UI mockups)

These patterns are HOW you describe a UI mockup. The user wants a single iconic symbol per card, not a UI mockup. If your subject genuinely IS a UI (a specific named software product's real interface), name it directly ("the WannaCry ransom screen", "the Bonzi Buddy purple monkey") — that does NOT match the forbidden patterns above.

THE GOAL FOR EACH CARD: depict the subject in the most IMMEDIATELY RECOGNISABLE way possible. The viewer should be able to look at a card and know what it represents in under a second — even at 168×94 px (YouTube mobile size).

The most recognisable depictions are usually NOT abstract icons. They are:
- The subject's REAL BRAND LOGO when it's a company or product (Sony, Yahoo, Microsoft, MGM, Kaseya, etc.). Brand logos rendered on a clean background are encouraged — this is fair use under YouTube's policy.
- The subject's REAL VISUAL IDENTITY when it's a piece of software, malware, or media (the WannaCry ransom screen, the ILOVEYOU pixel-mail icon, the Bonzi Buddy purple monkey, the Petya skull, a Minecraft Herobrine frame, a Pokémon Lavender Town screenshot).
- A REAL PRODUCT PHOTO when it's a physical product or toy (Buckyballs, Easy Bake Oven, an Aqua Dots box).
- A REAL NEWS/HISTORICAL PHOTO when it's a public event or incident (Mars Climate Orbiter, Cambridge Analytica hearing, a Boeing 737 MAX crash site, Stuxnet centrifuges).
- A REAL FACE/PHOTO when it's a named person (criminals, historical figures, executives).

Use an abstract symbol/icon ONLY when none of the above apply — when the subject genuinely has no canonical visual identity.

Each card stands on its own:
- Background, colors, and visual treatment should fit the subject naturally. A logo on white. A virus screen on dark. A product photo on its natural backdrop. DO NOT force a uniform colour palette across all cards. Visual variety across the grid is a feature, not a bug — different cards naturally have different palettes.
- One focal subject per card. No collages of three unrelated things on a single card.
- Mobile-readable: the subject must be recognisable when the card is small. If you can't tell what it is at thumbnail size, simplify the framing (closer crop on the logo, the most iconic frame of the screen, etc.) but DON'T strip out the recognisability.

VISUAL DOMINANCE — TEXT MUST BE MINIMAL:
- The illustration is primarily VISUAL. Text inside it is the EXCEPTION, not the norm.
- Hard rule: at most ONE short text element per card illustration, and only when it is intrinsic to the subject's recognisable identity. Examples of allowed in-card text:
  • The subject's BRAND WORDMARK as part of its logo (e.g. "YAHOO!", "Sony Pictures", the Microsoft logotype). These are not "captions" — they ARE the logo.
  • A single iconic header from a recognised screen (e.g. WannaCry's "Ooops, your files have been encrypted!" — and nothing else from that screen).
  • An iconic date/timestamp when the date itself is the recognisable moment AND it is the only thing on the card (no map, no stats, no extra lines underneath).
- DO NOT add stat captions ("75,000+ servers infected", "3,000,000,000 accounts compromised", "thousands of organisations affected"). Even if the stat is true.
- DO NOT add explanatory subtitles, descriptive sub-lines, or factoid bullet points beneath the main visual.
- DO NOT add badges that say things like "ZERO-DAY EXPLOITED", "OPERATIONS HALTED", "DATA STOLEN", "SYSTEM WIPED". The subject's authentic visual identity carries the meaning — the label band below the card carries the rest.
- DO NOT compose multi-element diagrams with labels for each box (e.g. "SERVER" → "COMPROMISED UPDATE" → "CUSTOMERS"). Pick ONE iconic visual instead.
- DO NOT pad the illustration with ASCII art, code lines, or screen text just to fill space.

When in doubt: pick a TIGHTER FRAMING with NO supplementary text. The label below the card is where words go.

SPECIFIC NAMED ENTITY vs. ABSTRACT CATEGORY — TWO VERY DIFFERENT TREATMENTS:

The "real recognisable visual" rule applies ONLY to SPECIFIC NAMED entities (e.g. "Sony Pictures", "WannaCry", "Microsoft Exchange", "Bonzi Buddy", "Stuxnet", "Cambridge Analytica"). These have a canonical visual identity — a logo, a famous screen, a known character — so the real visual works perfectly at thumbnail size.

ABSTRACT CATEGORIES are different. Examples of category-style labels:
- "Fake Virus Warnings", "Phishing Emails", "Fake Online Scanners",
  "Malicious Ads", "Bundled Software", "SEO Poisoning",
  "Ransomware Protection", "Password Manager", "Web Protection",
  "Real-Time Scanning", "Tech Support Scams", "Data Breach".

Categories have NO canonical visual identity. The risk: if you render a detail-faithful "realistic example" of one (a fake virus warning dialog, a phishing email client, a scanner UI table with rows of detections, an installer wizard with multiple buttons), the card packs in small text — unreadable at YouTube mobile thumbnail size — and the viewer just sees "generic computer thing".

For category labels: STRONGLY PREFER a single iconic symbol over a detail-faithful UI mockup. Examples of the iconic approach:
- "Fake Virus Warnings" → a giant red exclamation shield, OR a virus-cartoon-bug bursting out of a window. (Not a faithful browser dialog with multi-line text + countdown timer + progress bar.)
- "Phishing Emails" → a fishing hook piercing an envelope. (Not a faithful email client UI.)
- "Bundled Software" → a wrapped gift box with a small skull peeking out. (Not a setup wizard with installer text + checkboxes + buttons.)
- "Fake Online Scanners" → a magnifying glass over a skull or virus icon. (Not a scanner results table with row after row of fake detection entries.)
- "Malicious Ads" → a stop-sign banner with a skull. (Not a faithful McAfee-style ad with body copy + CTA button.)
- "Password Manager" → a single padlock with a key. (Not a password manager UI mock.)
- "Ransomware Protection" → a shield deflecting a skull. (Not a ransom screen.)
- "Data Breach" → a broken padlock with binary spilling out. (Not a database screenshot.)

A LITTLE text is fine when it's iconic — a single short phrase or a recognisable wordmark (e.g. one short "VIRUS!" header on a warning card, a one-word "Phishing" stamp). The hard rule is "visuals dominate, text supplements" — NOT "zero text categorically". What's NOT OK:
- Multi-line dialog body copy.
- Rows of fake detection results / file names / timestamps / progress percentages.
- Email subject lines + sender + body + attachment all in one card.
- Installer dialog with multiple buttons and explanatory paragraphs.

Rule of thumb when writing the icon_concept: if you find yourself describing a multi-element UI mockup ("a window showing X with Y button and Z list"), STOP and rewrite as a single iconic symbol. If you genuinely want a UI/dialog element, keep it to ONE bold iconic phrase or wordmark, no body copy, no list, no table.

SCRIPT FIDELITY — TITLES MUST MATCH WHAT THE USER WROTE:
- When a script is provided, the script is the canonical source of card content. Read it carefully.
- If the script names specific items, features, events, or things (e.g. "Real-Time Scanning", "Ransomware Protection", "Vulnerability Scanner"), use those EXACT phrases as card labels — character for character — instead of paraphrasing them.
- Pick cards in the order they appear in the script unless that order is clearly arbitrary.
- DO NOT invent topics the script does not mention.
- DO NOT collapse two distinct things the script lists separately into a single card.
- DO NOT split a single thing the script lists into two cards.
- If the script lists MORE items than the grid has cells, prioritise the most prominent / most-emphasised ones in the script (typically the first N or the ones with the most detail).
- If the script lists FEWER items than the grid has cells, pick the additional items from the most natural adjacent concepts the script implies — but mark this clearly with a slight stylistic variation if possible.

The label below each card is short — see the HARD STRUCTURAL CAPS at the top of this message (≤ ${MAX_LABEL_CHARS} chars, ≤ ${MAX_LABEL_WORDS} words). It identifies the card; it isn't repeated inside the illustration.

COLOR SEMANTICS for \`accent_color\`:
- If the card's subject is a scam, attack, threat, malware, breach, fraud, virus, or other "negative" concept, DO NOT pick a green or pure-blue accent. Green reads as safe/legit/trusted (it's the color real antivirus uses), and pure blue reads as corporate/brand. A "Fake Online Scanners" card with a green shield reads to the viewer as a legitimate scanner, the opposite of the meaning.
- Negative subjects want reds, oranges, warning-yellows, magentas, or charged purples — colors that signal danger / alert / hostile.
- Neutral or positive subjects (real-time scanning, password manager, protection features) can use any color that fits naturally. The rule only applies when the label is itself negative.

A reference image is attached to this message. Match its STRUCTURE precisely (grid layout, gutters, borders, the hand-drawn-feeling label font). Do NOT inherit its specific palette or per-card content — your cards should fit the user's topic, not the reference's topic.

Cards are ordered left-to-right, top-to-bottom in the grid.

Return JSON only — no prose, no markdown fences. Schema:

{
  "cards": [
    { "index": 1, "label": "<≤ ${MAX_LABEL_CHARS} chars AND ≤ ${MAX_LABEL_WORDS} words>", "icon_concept": "<≤ ${MAX_ICON_CONCEPT_CHARS} chars, ONE bold central symbol in a single short sentence — name the real logo / screen / product / photo when one exists; let the natural colors and background come through>", "accent_color": "<hex if a specific accent matters for this card, otherwise omit; never green / pure-blue on negative subjects>" }
  ],
  "global_palette": {
    "background": "#000000",
    "primary_accent": "inherit",
    "secondary_accent": "inherit"
  },
  "notes_for_image_model": "<one short sentence of overall style guidance, optional>"
}

The cards array MUST contain EXACTLY ${total} entries. The global_palette is optional and informational only — do NOT design the cards to share a forced palette.`;

  const userParts: string[] = [];
  userParts.push(`**Video Title:** ${title}`);
  userParts.push(`**Niche:** ${niche}`);
  userParts.push(`**Grid:** ${gridRows} rows × ${gridCols} columns = ${total} cards.`);
  if (description) userParts.push(`**Video Description:** ${description.slice(0, 500)}`);
  if (script) userParts.push(`**Script (canonical source for card labels — extract the user's exact terminology):** ${script.slice(0, 12000)}`);
  if (usingPrefilled) {
    userParts.push(
      `**Pre-filled labels — use these verbatim, in this order, do not invent new ones:**\n${prefilledLabels!
        .map((l, i) => `${i + 1}. ${l}`)
        .join('\n')}\n\nYour job for these is to fill in only the icon_concept and accent_color per card. Keep labels EXACTLY as given.`,
    );
  } else {
    userParts.push(
      `Pick ${total} distinct, mutually exclusive card topics from the video. They should together cover the video at a glance — not all duplicates of one theme.`,
    );
  }

  // Card-shape guidance. Square mode keeps the original behaviour; circle
  // mode adds a sentence biasing the model toward simpler single-subject
  // icons that read cleanly inside a disc (where corner detail gets clipped
  // by the circular mask the composite applies).
  if (cardShape === 'circle') {
    userParts.push(
      `**Card shape:** circle. Each card will render as a disc with the label centred beneath it. Detail in the corners of any illustration is CLIPPED by the circular mask — so frame every icon_concept as a single bold subject centred in its frame, with breathing room around the edges. Avoid wide horizontal compositions, edge-of-frame text, or anything that depends on the corners being visible.`,
    );
  }

  // Per-cell upload nudges. For each listed cell, the model is told to emit
  // the `USER_UPLOADED_IMAGE` sentinel as the icon_concept and produce a
  // label only. Downstream the composite paints the user's bytes over that
  // cell regardless, so non-compliance is safe; this just stops the model
  // from wasting tokens on an icon nobody will see.
  if (uploadedIdxList.length > 0) {
    userParts.push(
      `**User-uploaded cells (the user has attached an image to these card slots; you do NOT need to design an icon for them — set icon_concept to the literal string \`USER_UPLOADED_IMAGE\` for these and focus only on a good label):**\n${uploadedIdxList
        .map((n) => `- Card ${n}`)
        .join('\n')}`,
    );
  }

  return { system, user: userParts.join('\n\n') };
}

/** How visually bright the rendered grid should feel. Threaded into
 *  the Step 2 image prompt as an explicit directive. `bright` is the
 *  Phase-1.7 default — the reference channels that win in this niche
 *  (`The Paint Explainer`, `EverythingProfessor`, `The Evaluator`,
 *  `Byte Sized Explainer`) all run uniformly bright. The dark-fade /
 *  cinematic look that older defaults produced was hurting CTR.
 *  `mixed` and `moody` are escape hatches for editorial / horror
 *  niches that genuinely want the darker register. */
export type ThumbnailBrightness = 'bright' | 'mixed' | 'moody';

/** How visually detailed each card may be. `clean` favours single
 *  iconic subjects with chunky shapes — what works at YouTube mobile
 *  size. `detailed` allows photoreal scenes / multi-element
 *  compositions for users who want the older look. */
export type ThumbnailDetail = 'clean' | 'detailed';

/** Visual style register for the rendered cards. Each preset emits a
 *  different `STYLE` block at the head of the image prompt that
 *  overrides Detail=Clean's "chunky iconic" wording, so the model
 *  doesn't default cartoon when the subject would render better in
 *  another register. `free-form` lets the user type a style sentence
 *  that gets sanitised and dropped into the same slot. */
export type ThumbnailStyle =
  | 'cartoon'
  | 'photoreal'
  | 'flat-2d'
  | 'sketch'
  | 'cinematic'
  | 'free-form';

export const DEFAULT_BRIGHTNESS: ThumbnailBrightness = 'bright';
export const DEFAULT_DETAIL: ThumbnailDetail = 'clean';
/** Default style — Cartoon matches the bundled curated reference image
 *  and the previous "always cartoon" implicit output, so existing flows
 *  produce the same visual on first generation. Users opt into a
 *  different style explicitly via the panel. */
export const DEFAULT_STYLE: ThumbnailStyle = 'cartoon';
export const STYLE_FREE_FORM_MAX_CHARS = 300;

/** Label-size multiplier bounds. The slider in the panel and the API
 *  route both clamp to this range. 1.0 is the canonical size derived
 *  from the layout's cell height (matches r2.4.1's per-cell output on
 *  cells where detection landed cleanly). 0.5 / 1.5 are deliberately
 *  generous so users can dial the look across a wide range without
 *  bumping into a wall. */
export const LABEL_SIZE_MIN = 0.5;
export const LABEL_SIZE_MAX = 1.5;
export const DEFAULT_LABEL_SIZE = 1.0;

export interface ImagePromptInput {
  cards: TopicCard[];
  palette: GlobalPalette;
  gridRows: number;
  gridCols: number;
  notesForImageModel?: string;
  /** Visual card shape. Defaults to `'square'`. Drives the layout block of
   *  the prompt. Square mode keeps the original rectangle-with-label-strip
   *  contract; circle mode swaps in a discs-on-white-canvas contract. */
  cardShape?: CardShape;
  /** 1-based indexes of cells the user has uploaded an image for. The prompt
   *  instructs the model to leave each listed cell as a clean pure-white
   *  background with no illustration. The composite step overpaints these
   *  cells regardless, so AI non-compliance is safe. */
  uploadedCellIndexes?: number[];
  /** Brightness register. Defaults to `'bright'` (the Phase-1.7 default
   *  shift). Pass `'mixed'` or `'moody'` to opt back into the older
   *  variable-brightness behaviour. */
  brightness?: ThumbnailBrightness;
  /** Detail register. Defaults to `'clean'` (single iconic subjects).
   *  Pass `'detailed'` to allow photoreal / multi-element compositions
   *  per card. */
  detail?: ThumbnailDetail;
  /** Style preset. Defaults to `'cartoon'` so existing flows produce
   *  the same visual on first generation. `'free-form'` requires
   *  `styleFreeForm` to be set; other presets ignore it. */
  style?: ThumbnailStyle;
  /** Free-form style description. Only consulted when `style ===
   *  'free-form'`. Sanitised + clipped at the boundary, then dropped
   *  into the STYLE block as `STYLE — CUSTOM: <user text>`. */
  styleFreeForm?: string;
}

/**
 * Step 2 prompt. Constructed server-side after the user has reviewed and
 * possibly edited the card list. Hard-locks the layout in writing, repeats
 * the "no embedded text in illustrations" rule three times because GPT
 * Image 2 occasionally drifts there, and enumerates every card explicitly.
 *
 * The prompt is large; we pre-sanitise + clip every interpolated string
 * (`sanitizeForPrompt`) so a malicious or sloppy edit can't smuggle in
 * conflicting instructions.
 */
export function topicCardGridImagePrompt(input: ImagePromptInput): string {
  const {
    cards,
    gridRows,
    gridCols,
    notesForImageModel,
    cardShape = 'square',
    uploadedCellIndexes,
    brightness = DEFAULT_BRIGHTNESS,
    detail = DEFAULT_DETAIL,
    style = DEFAULT_STYLE,
    styleFreeForm,
  } = input;
  const total = gridRows * gridCols;
  const safeNotes = notesForImageModel ? sanitizeForPrompt(notesForImageModel, 300) : '';
  const styleBlock = styleDirective(style, styleFreeForm);

  const uploadedIdxSet = new Set<number>();
  if (uploadedCellIndexes) {
    for (const n of uploadedCellIndexes) {
      if (Number.isInteger(n) && n >= 1 && n <= total) uploadedIdxSet.add(n);
    }
  }

  const cardLines = cards
    .map((c) => {
      // Uploaded cells: render the entire cell as PURE WHITE — no
      // illustration, no label, no border, no text of any kind. The
      // composite step paints the user's image, the cell border, and the
      // label deterministically afterwards, so anything the model draws
      // here can only ever leak through if our cellRect is off by a few
      // pixels (the "double labels" bug the user kept hitting). By
      // omitting the label from the prompt entirely — not just the
      // icon_concept — we eliminate the source of the doubled label
      // bleed even when the AI runs (mixed-upload case where some but
      // not all cells have uploads, so the all-uploads fast path can't
      // skip the AI). Whatever was in the user's `c.label` / `c.icon_concept`
      // is IGNORED for uploaded cells, by design.
      if (uploadedIdxSet.has(c.index)) {
        return `${c.index}. PURE WHITE CELL — no illustration, no label, no text, no border, no icon, no decoration of any kind. Render this cell's entire area as solid pure-white pixels. The compositor will paint the user's uploaded image and label after generation.`;
      }
      const label = sanitizeForPrompt(c.label, 60);
      const concept = sanitizeForPrompt(c.icon_concept, 250);
      const accent = c.accent_color ? ` (accent hint: ${sanitizeForPrompt(c.accent_color, 16)})` : '';
      return `${c.index}. Label: "${label}" — Illustration: ${concept}${accent}`;
    })
    .join('\n');

  // Layout block diverges by shape. Square mode is the original contract;
  // circle mode swaps in a discs-on-white-canvas contract. Keeping the
  // strings inline (rather than a per-shape helper) makes it easier to
  // diff this prompt against image gen outputs when debugging drift.
  const layoutBlock =
    cardShape === 'circle'
      ? `LAYOUT (strict):
- A WHITE canvas with an evenly-spaced ${gridRows} rows × ${gridCols} columns grid of ${total} discs (circles) total.
- WHITE outer margin on all four sides (top, bottom, left, right). Outer margin width matches the horizontal gutter between columns.
- VERTICAL SPACING IS GENEROUS — NOT UNIFORM WITH HORIZONTAL:
  • Horizontal gap between two discs in the same row: the standard gutter (~3-4% of canvas width).
  • Vertical gap between two rows (measured from the BOTTOM of the upper row's LABEL to the TOP of the lower row's DISC): roughly 1.8–2× the horizontal gap, so labels never visually touch the next row's discs. This is the single most common rendering failure in this format — err generous on vertical space.
- Each disc sits in its own equal-size cell. The disc occupies the top ~65% of the cell height (NOT 75% — leave a clearly visible WHITE GAP between the label and the bottom edge of the cell so the next row's disc has breathing room). Disc fills most of the cell width.
- NO rectangular borders around the cells. NO black frame around each disc. NO hairline divider. The discs sit directly on the white canvas; the label sits in the white canvas beneath each disc.
- Each disc's edge is a single clean circular outline (no shadow, no bevel) — or the disc is borderless if its illustration's natural background bleeds to the disc edge.
- Each disc is split into two regions:
  • The disc itself (top ~65% of the cell): the illustration, framed by the circular crop. Anything in the corners of the source illustration is CLIPPED by the disc — frame each subject centred and tight.
  • A short label strip BELOW the disc (next ~20% of the cell): white background, label text centred. The remaining ~15% of the cell is WHITE breathing room beneath the label — do NOT extend the label into this region, do NOT push the next row up into it.`
      : `LAYOUT (strict):
- An evenly-spaced ${gridRows} rows × ${gridCols} columns grid of identical-size cards = ${total} cards total.
- A WHITE outer margin around the entire grid on all four sides of the canvas (top, bottom, left, right) — same width as the inter-card gutter.
- WHITE gutters of uniform width separating every card from its neighbours.
- Each card is ONE single rectangle with ONE solid black border (2-3 px) wrapping the WHOLE card. The illustration AND the label strip share that SAME single border — they are NOT two separate framed boxes.
- Inside that ONE rectangle, two horizontal regions stack vertically:
  • Top region (~80% of card height): the illustration. It fills the FULL card width edge-to-edge.
  • Bottom region (~20% of card height): a pure white horizontal strip containing the card's label. It ALSO fills the FULL card width edge-to-edge — same left edge as the illustration, same right edge as the illustration.
- A 1 px black hairline separates the illustration region from the white label strip. The hairline runs the full card width.
- FORBIDDEN label renderings — do NOT produce any of these:
  • a separate smaller bordered box for the label below the illustration
  • a label "tag", "badge", "callout", "speech bubble", "polaroid caption", or any kind of floating sub-frame
  • a label rectangle that is narrower than the illustration above it
  • a visible gap, margin, or whitespace between the illustration and the label strip
  • a label strip that has its own border separate from the illustration's border
  The label strip is part of the SAME bordered rectangle as the illustration, sitting flush against it, sharing its left and right edges.`;

  return `Create a YouTube thumbnail in the "Topic Card Grid" format, 16:9.

${styleBlock}

${layoutBlock}

PER-CARD ILLUSTRATION RULES:
- Depict each subject in its MOST RECOGNISABLE form. Brand logos rendered on a clean background, real virus/software screens, real product photos, real characters, real news photos — whatever is most immediately identifiable for that specific subject. This is fair use under YouTube's policy and is what the user wants.
- One focal subject per card. No collages of multiple unrelated things on a single card.
- Background and colors PER CARD should fit the subject naturally. A logo on white. A virus screen on dark. A product on its natural backdrop. Do NOT force a uniform colour scheme across all cards — visual variety across the grid is expected and good.
- Recognisable at 168×94 px (YouTube mobile thumbnail size). Crop and frame each card so the subject is obvious at small size; if a subject is detail-dense, frame the most iconic moment of it.

VISUAL DOMINANCE — TEXT INSIDE ILLUSTRATIONS MUST BE MINIMAL:
- The illustration is primarily VISUAL. Text inside it is the EXCEPTION, not the norm.
- Hard cap: at most ONE short text element per card illustration, and only when it's intrinsic to the subject's recognisable identity. Permitted in-card text:
  • A brand wordmark that IS the subject's logo (e.g. "YAHOO!", the Microsoft logotype, "Sony Pictures").
  • A single iconic header from a recognised screen (e.g. WannaCry's "Ooops, your files have been encrypted!" — alone, not with the rest of the dialog).
  • An iconic date/timestamp ONLY when the date itself is the recognisable moment AND nothing else is on the card.
- DO NOT add stat captions like "75,000+ servers infected", "3,000,000,000 accounts compromised", "thousands of organisations affected".
- DO NOT add explanatory subtitles, descriptive sub-lines, factoid bullet points, or news-headline-style summaries beneath the main visual.
- DO NOT add badges that say "ZERO-DAY EXPLOITED", "OPERATIONS HALTED", "DATA STOLEN", "SYSTEM WIPED", or similar.
- DO NOT compose multi-element diagrams with labels for each box.
- DO NOT pad the illustration with ASCII art, fake code, or screen text just to fill space.
When in doubt: TIGHTER FRAMING with NO supplementary text. The label band BELOW the card carries the words.

CATEGORY vs. SPECIFIC RULE (important — most common failure mode):
- For SPECIFIC NAMED entities (real brands, real software, real characters, real events): use their canonical visual identity (logo, famous screen, character render).
- For ABSTRACT CATEGORIES of attack / feature / concept ("fake virus warnings", "phishing emails", "fake scanners", "bundled software", "ransomware protection", "password manager", "data breach", etc.): STRONGLY PREFER one bold iconic symbol over a detail-faithful UI / dialog / inbox / wizard / scanner-table mockup. Categories don't have a canonical visual, so a realistic mockup degenerates into a text-heavy panel unreadable at thumbnail size.
  A LITTLE text is fine when it's iconic (a one-word stamp like "VIRUS!", a wordmark). What's NOT OK on a category card: multi-line dialog body copy, rows of fake detection entries, multi-field email mocks, installer wizards with body paragraphs and multiple buttons. Iconic, not example.

${
  cardShape === 'circle'
    ? `LABEL RULES (strict):
- Each label sits in the white canvas BELOW its disc, centred horizontally.
- Rendered in the SAME hand-drawn humanist font as the attached reference image's typography (friendly weight, slight slope, NOT a system sans-serif).
- Label color: solid black. No box, no underline, no background tint — text sits directly on the white canvas.
- Labels go ONLY beneath each disc — they NEVER appear inside the disc except as part of the subject's authentic visual identity.
- Labels are short (≤ ${MAX_LABEL_CHARS} chars / ≤ ${MAX_LABEL_WORDS} words) — render each as a SINGLE LINE. Do not wrap, do not overflow into the disc above or into the gutter below the cell. Stay strictly within the label band of the cell.`
    : `LABEL STRIP RULES (strict):
- Pure white background.
- Card label rendered in the SAME hand-drawn humanist font as the attached reference image's typography (friendly weight, slight slope, NOT a system sans-serif).
- Label color: solid black.
- Centred horizontally and vertically in the strip.
- Labels go ONLY in the white strip — they NEVER appear in the illustration except as part of the subject's authentic visual identity.
- Labels are short (≤ ${MAX_LABEL_CHARS} chars / ≤ ${MAX_LABEL_WORDS} words) — render each as a SINGLE LINE within its label strip. Do not wrap, do not overflow into the illustration above or into the gutter between rows. Stay strictly within the cell's bottom 20% white strip.`
}

CARDS (render exactly these ${total} ${cardShape === 'circle' ? 'discs' : 'cards'}, in this order, reading left-to-right then top-to-bottom):

${cardLines}

ABSOLUTE REQUIREMENTS — DO NOT VIOLATE:
- The grid MUST contain EXACTLY ${total} ${cardShape === 'circle' ? 'discs' : 'cards'}. Not one more, not one fewer.
- One focal subject per ${cardShape === 'circle' ? 'disc' : 'card'} — no multi-subject collages within a single ${cardShape === 'circle' ? 'disc' : 'card'}.
- Do NOT add a master title, watermark, channel logo, or any text outside the grid.
- Match the LAYOUT (grid + gutters + outer margin) and the LABEL TYPOGRAPHY of the attached reference image precisely. Do NOT inherit the reference's specific palette or per-card content — those are dictated by THIS card list, not by the reference's topic.${
  uploadedIdxSet.size > 0
    ? `
- The following cells are USER-RESERVED — the user is attaching their own image AND their own label post-render. Leave EACH of these cells ENTIRELY blank: pure white pixels covering the full cell area, NO illustration, NO label text, NO border, NO icon, NO decoration. The compositor paints everything for these cells: ${[...uploadedIdxSet].sort((a, b) => a - b).join(', ')}.`
    : ''
}

${brightnessDirective(brightness)}

${detailDirective(detail)}

${safeNotes ? `STYLE NOTE: ${safeNotes}` : ''}`.trim();
}

/** Brightness directive appended to the image prompt. The wording is
 *  deliberately blunt — image models drift toward "moody / cinematic"
 *  on cybersecurity / horror / mystery topics unless told otherwise,
 *  and the analysis with the user showed that drift was the single
 *  biggest hit to CTR vs the reference channels.
 *
 *  Exported so per-card mode
 *  (`src/lib/thumbnail-formats/topic-card-grid-per-card.ts`) can
 *  reuse the exact same wording in its shared style header — drift
 *  between the mega-prompt and the per-card prompts would mean the
 *  two modes produce visually different cards for the same axes. */
export function brightnessDirective(value: ThumbnailBrightness): string {
  if (value === 'moody') {
    return `BRIGHTNESS — MOODY: cinematic, atmospheric, darker palettes are OK. Lean into the subject's natural mood.`;
  }
  if (value === 'mixed') {
    return `BRIGHTNESS — MIXED: vary brightness across cells to fit each subject. Don't force a uniform register; let dark subjects render dark and light subjects render light.`;
  }
  return `BRIGHTNESS — BRIGHT (default):
- Every card must render with a vibrant, well-lit palette. NO cinematic dark fade, NO black-on-black compositions, NO heavy shadows or moody atmospheric lighting.
- Cell backgrounds should read as saturated, lively colours — saturated reds, electric blues, lemon yellows, neon greens, hot pinks, bright purples — not muted desaturated tones. The reference channels' grids look like a sticker collection, not a horror movie poster.
- Even for inherently dark subjects (malware screens, ransomware text, criminals), pick the most colourful framing the subject permits — a red WannaCry screen on a vivid background instead of a near-black close-up of code.
- The bar is "bright enough that the thumbnail still reads as a colourful object at YouTube mobile thumbnail size". If a cell would otherwise be predominantly black, brighten its background or its surrounding accents until that bar is met.`;
}

/** Style directive prepended to the image prompt. Lands at the head of
 *  the body (above the layout block) so the model reads the visual
 *  register before any of the layout / per-card rules — a head-of-prompt
 *  STYLE block reliably overrides Detail=Clean's "chunky iconic"
 *  wording in image-model practice. Unknown values fall back to the
 *  Cartoon default rather than emitting an empty block.
 *
 *  Exported alongside `brightnessDirective` and `detailDirective` so
 *  the per-card runner can share the exact same wording — see the
 *  comment on `brightnessDirective`. */
export function styleDirective(value: ThumbnailStyle, freeForm: string | undefined): string {
  switch (value) {
    case 'photoreal':
      return `STYLE — PHOTOREAL:
- Render each card as a real-world photograph or authentic visual identity. NO illustrated stand-ins, NO cartoon shapes, NO flat 2D iconography.
- Where a subject has a canonical visual (a famous software screen, a brand logo, a product photo, a news photo, a person's face), use that exact visual — rendered as a real photograph or a high-fidelity reproduction of the original screen.
- Lighting, depth-of-field, and texture as a real camera would capture them. Photographic grain and natural shadows are fine. Avoid hyper-saturated cartoon palettes.
- For ABSTRACT CATEGORIES that have no canonical visual: pick one bold iconic SUBJECT (a single envelope-on-hook for phishing, a single padlock for password protection) and render IT photoreal — a real-looking envelope, a real-looking padlock. Not a cartoon version of an icon.`;
    case 'flat-2d':
      return `STYLE — FLAT 2D ILLUSTRATION:
- Clean vector-style flat shapes. Restrained palette (≤ 5 colors per card).
- NO gradients, NO drop shadows, NO 3D shading, NO photoreal textures. Outlines only when geometric / intentional.
- Modern editorial flat illustration register — think Stripe / Linear / Vercel marketing illustration, not children's cartoon stickers.
- Even for brand logos: render the logo flat, in its canonical brand colors, on a clean solid backdrop. No 3D rendering.`;
    case 'sketch':
      return `STYLE — SKETCH / HAND-DRAWN:
- Black ink line art on textured off-white paper. Sparse fills, hand-drawn hatching for shading.
- Hand-drawn humanist feel like a designer's sketchbook. Visible pencil / pen strokes are good.
- Avoid solid color blocks and saturated palettes — let the line work and the paper texture carry the image.
- For brand logos and real subjects: redraw them as sketches, not photoreal. The sketch register is the dominant visual.`;
    case 'cinematic':
      return `STYLE — CINEMATIC:
- Moody, atmospheric, film-still feel. Dramatic key lighting. Shallow depth-of-field. Color grading toward teal-and-orange or muted neutrals.
- Treat each card like a still from a thriller about the subject — strong contrast, deliberate negative space, dramatic camera angles.
- Real photographs and real visual identities are encouraged, but graded for atmosphere rather than left bright.
- Darker palettes are explicitly OK in this style even if the surrounding Brightness toggle reads "Bright" — the cinematic register takes precedence.`;
    case 'free-form': {
      const safe = sanitizeForPrompt(freeForm ?? '', STYLE_FREE_FORM_MAX_CHARS);
      if (!safe) {
        // Empty free-form description = behave as Cartoon so the model
        // gets a usable directive instead of a blank STYLE block.
        return styleDirective('cartoon', undefined);
      }
      return `STYLE — CUSTOM:
- ${safe}
- Apply this style register to EVERY card uniformly. Do not switch styles between cards. If the description conflicts with the per-card subject (e.g. "photoreal" applied to an abstract category), pick the closest visual interpretation of the subject in the requested style.`;
    }
    case 'cartoon':
    default:
      return `STYLE — CARTOON / STICKER:
- Bold flat illustration with thick outlines, saturated palette, sticker-like shapes. Hand-drawn humanist feel.
- Cartoon characters, exaggerated cartoon proportions, chunky shapes that read at thumbnail size.
- Avoid photoreal textures, real photographic depth-of-field, or 3D rendering. The look is a sticker sheet, not a movie poster.`;
  }
}

/** Detail directive appended to the image prompt. Exported so per-card
 *  mode shares the wording — see `brightnessDirective`. */
export function detailDirective(value: ThumbnailDetail): string {
  if (value === 'detailed') {
    return `DETAIL — DETAILED: multi-element compositions and photoreal scenes are OK when the subject calls for them.`;
  }
  return `DETAIL — CLEAN (default):
- One bold iconic visual per card. NO multi-element diagrams, NO collages, NO photoreal scenes packed with small props.
- Subjects should read as a CHUNKY central image — the kind of single-glance thumbnail card the reference channels (The Paint Explainer, EverythingProfessor, The Evaluator, Byte Sized Explainer) ship.
- Cap fine detail aggressively. If a subject is detail-dense (a complex device, a screen with lots of UI), crop to the single most recognisable element instead of rendering the whole thing.
- Text inside the illustration stays minimal — at most one short brand wordmark or iconic header. No body copy, no captions, no stat lines.
- The card should still read clearly at 168×94 px (YouTube mobile thumbnail size).`;
}

// ─── JSON-shape helpers ─────────────────────────────────────────────────────

/**
 * Narrow the LLM's raw parsed JSON down to a `CardListResult`. Throws with a
 * specific reason on shape errors so callers can return an actionable 400.
 *
 * Defensive: the LLM occasionally puts the cards array at the top level
 * instead of under `cards`, or returns a single object instead of an array.
 * We accept the common drift shapes and normalise.
 */
export function parseCardListResult(raw: unknown): CardListResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('LLM response is not an object.');
  }
  const obj = raw as Record<string, unknown>;
  const cardsRaw = Array.isArray(obj.cards)
    ? obj.cards
    : Array.isArray(raw)
      ? raw
      : null;
  if (!cardsRaw) throw new Error('LLM response missing `cards` array.');

  const cards: TopicCard[] = cardsRaw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Card ${i + 1} is not an object.`);
    }
    const e = entry as Record<string, unknown>;
    return {
      index: typeof e.index === 'number' ? e.index : i + 1,
      label: String(e.label ?? '').trim(),
      icon_concept: String(e.icon_concept ?? '').trim(),
      accent_color: e.accent_color ? String(e.accent_color) : undefined,
    };
  });

  // Palette is informational only post-1.5; the image prompt does not enforce
  // it. We still parse and pass through any value the LLM emits so history
  // entries from r1 round-trip without crashing, but new entries can safely
  // leave the accents as `inherit`.
  const paletteRaw = (obj.global_palette ?? {}) as Record<string, unknown>;
  const global_palette: GlobalPalette = {
    background: String(paletteRaw.background ?? '#000000'),
    primary_accent: String(paletteRaw.primary_accent ?? 'inherit'),
    secondary_accent: String(paletteRaw.secondary_accent ?? 'inherit'),
  };

  return {
    cards,
    global_palette,
    notes_for_image_model: obj.notes_for_image_model
      ? String(obj.notes_for_image_model)
      : undefined,
  };
}
