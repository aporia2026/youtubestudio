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
  /** White gutter between cards in pixels (uniform horizontal + vertical). */
  gutter: number;
  /** Visual card shape. `'square'` keeps the original layout: a black-bordered
   *  rectangle split into an illustration region (top) and a white label
   *  strip (bottom). `'circle'` renders each card as a borderless disc with
   *  the label centred in the gutter below. Defaults to `'square'` when
   *  omitted so older history entries hydrate cleanly. */
  cardShape?: CardShape;
}

/** Visual shape of each card. See `GridLayout.cardShape` for the contract. */
export type CardShape = 'square' | 'circle';

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
  const cardW = (width - 2 * om - (cols - 1) * g) / cols;
  const cardH = (height - 2 * om - (rows - 1) * g) / rows;
  const regions: ThumbnailRegion[] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = om + c * (cardW + g);
      const y = om + r * (cardH + g);
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
  const cardW = (width - 2 * om - (cols - 1) * g) / cols;
  const cardH = (height - 2 * om - (rows - 1) * g) / rows;
  const regions: ThumbnailRegion[] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellX = om + c * (cardW + g);
      const cellY = om + r * (cardH + g);
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
 * Card concepts the model should NOT produce. The aggressive r1 banlist
 * (text / screenshot / UI / person / face / scene / busy / detailed) is
 * gone in r1.5 — competitor analysis showed those are exactly the kinds of
 * cards that work: real virus ransom screens, real product photos, real
 * brand logos, real character faces. The banlist was the wrong solution.
 *
 * What stays banned: "invented" text overlays (fake captions the model
 * makes up on its own). Authentic-to-subject text (the actual WannaCry
 * ransom text, the actual ILOVEYOU file extension) is fine and recognisable.
 *
 * In practice this means the banlist is effectively empty for normal LLM
 * output; we retain the structure so we can re-add narrow bans cheaply if
 * a specific failure mode emerges.
 */
export const ICON_CONCEPT_BANLIST: readonly { match: RegExp; reason: string }[] = [
  // Intentionally empty post-1.5. Add a narrow regex here if a specific
  // failure mode (e.g. "stick-figure clipart") starts dominating outputs.
];

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
    if (label.length > 60) {
      return { ok: false, reason: `Card ${i + 1} label is too long (${label.length} chars; max 60).`, offending_card_index: i };
    }
    for (const banned of ICON_CONCEPT_BANLIST) {
      if (banned.match.test(icon)) {
        return {
          ok: false,
          reason: `Card ${i + 1} icon_concept contains a banned concept (${banned.reason}). Rewrite as a single bold central icon/symbol on a dark background.`,
          offending_card_index: i,
        };
      }
    }
  }
  return { ok: true };
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

The label below each card is short (1–4 words). It identifies the card; it isn't repeated inside the illustration.

A reference image is attached to this message. Match its STRUCTURE precisely (grid layout, gutters, borders, the hand-drawn-feeling label font). Do NOT inherit its specific palette or per-card content — your cards should fit the user's topic, not the reference's topic.

Cards are ordered left-to-right, top-to-bottom in the grid.

Return JSON only — no prose, no markdown fences. Schema:

{
  "cards": [
    { "index": 1, "label": "<1-4 words>", "icon_concept": "<concrete description of the most recognisable depiction of this subject — name the real logo / screen / product / photo when one exists; let the natural colors and background come through>", "accent_color": "<hex if a specific accent matters for this card, otherwise omit>" }
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
  } = input;
  const total = gridRows * gridCols;
  const safeNotes = notesForImageModel ? sanitizeForPrompt(notesForImageModel, 300) : '';

  const uploadedIdxSet = new Set<number>();
  if (uploadedCellIndexes) {
    for (const n of uploadedCellIndexes) {
      if (Number.isInteger(n) && n >= 1 && n <= total) uploadedIdxSet.add(n);
    }
  }

  const cardLines = cards
    .map((c) => {
      const label = sanitizeForPrompt(c.label, 60);
      // Uploaded cells: drop the icon_concept and tell the model to leave
      // the cell as a clean white background, no illustration. Composite
      // overpaints regardless, but the prompt nudge stops the model from
      // wasting capacity inventing an icon nobody will see — and reduces
      // the chance of bleed-through if the overpaint mask is off by a
      // pixel at the cell edge.
      if (uploadedIdxSet.has(c.index)) {
        return `${c.index}. Label: "${label}" — Illustration: BLANK — render this cell's illustration area as a clean pure-white background with no icon, no text, no detail. Only the label band below carries content.`;
      }
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
- WHITE outer margin around the entire grid on all four sides (top, bottom, left, right) — same width as the gutters between discs.
- Each disc sits in its own equal-size cell. The disc fills most of the cell width and the top ~75% of the cell height; the bottom strip of the cell holds the label.
- NO rectangular borders around the cells. NO black frame around each disc. NO hairline divider. The discs sit directly on the white canvas; the label sits in the white canvas beneath each disc.
- Each disc's edge is a single clean circular outline (no shadow, no bevel) — or the disc is borderless if its illustration's natural background bleeds to the disc edge.
- Each disc is split into two regions:
  • The disc itself (top ~75% of the cell): the illustration, framed by the circular crop. Anything in the corners of the source illustration is CLIPPED by the disc — frame each subject centred and tight.
  • A short label strip BELOW the disc (bottom ~25% of the cell): white background, label text centred.`
      : `LAYOUT (strict):
- An evenly-spaced ${gridRows} rows × ${gridCols} columns grid of identical-size cards = ${total} cards total.
- A WHITE outer margin around the entire grid on all four sides of the canvas (top, bottom, left, right) — same width as the inter-card gutter.
- WHITE gutters of uniform width separating every card from its neighbours.
- Each card has a 2-3 px solid black border framing it, clearly visible against the white gutters.
- Each card is split into two stacked regions:
  • Top region (~80% of card height): the illustration.
  • Bottom region (~20% of card height): a pure white horizontal strip containing the card's label.
- A 1 px black hairline separates the illustration region from the white label strip.`;

  return `Create a YouTube thumbnail in the "Topic Card Grid" format, 16:9.

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
- Labels go ONLY beneath each disc — they NEVER appear inside the disc except as part of the subject's authentic visual identity.`
    : `LABEL STRIP RULES (strict):
- Pure white background.
- Card label rendered in the SAME hand-drawn humanist font as the attached reference image's typography (friendly weight, slight slope, NOT a system sans-serif).
- Label color: solid black.
- Centred horizontally and vertically in the strip.
- Labels go ONLY in the white strip — they NEVER appear in the illustration except as part of the subject's authentic visual identity.`
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
- The following cells are USER-RESERVED (the user is attaching their own image post-render). Leave each one as a clean pure-white illustration area with no icon, no text, no detail — only the label band below carries content: ${[...uploadedIdxSet].sort((a, b) => a - b).join(', ')}.`
    : ''
}

${safeNotes ? `STYLE NOTE: ${safeNotes}` : ''}`.trim();
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
