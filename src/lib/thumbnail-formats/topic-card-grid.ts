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

export interface GlobalPalette {
  /** Card illustration background. Default `#000000`. */
  background: string;
  /** Primary accent color across all cards (e.g. dominant red). */
  primary_accent: string;
  /** Secondary accent color (e.g. amber highlight). */
  secondary_accent: string;
}

export interface CardListResult {
  cards: TopicCard[];
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
}

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

export function makeDefaultLayout(rows: number, cols: number, width: number = DEFAULT_CANVAS.width, height: number = DEFAULT_CANVAS.height): GridLayout {
  const g = defaultGutter(width);
  return { width, height, rows, cols, outerMargin: g, gutter: g };
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

// ─── Banlist + validation ───────────────────────────────────────────────────

/**
 * Phrases that disqualify a card's `icon_concept`. Each entry maps to a short
 * human-readable reason that the LLM-revise retry can quote back into the
 * fix-this prompt. Case-insensitive word-boundary match.
 *
 * The list is intentionally aggressive because the cost of letting bad cards
 * through is a generated thumbnail with busy/illegible content — exactly the
 * outcome we were hired to prevent. Better to over-flag and re-prompt than to
 * under-flag and ship a bad thumbnail.
 */
export const ICON_CONCEPT_BANLIST: readonly { match: RegExp; reason: string }[] = [
  { match: /\btext\b/i, reason: 'no embedded text in the illustration' },
  { match: /\bcaption\b/i, reason: 'no captions in the illustration' },
  { match: /\bscreenshot\b/i, reason: 'no UI screenshots' },
  { match: /\bUI\b/, reason: 'no UI mockups' },
  { match: /\binterface\b/i, reason: 'no interface mockups' },
  { match: /\bperson\b|\bpeople\b/i, reason: 'no people' },
  { match: /\bface\b|\bfaces\b/i, reason: 'no human faces' },
  { match: /\bcrowd\b/i, reason: 'no crowds' },
  { match: /\bscene\b/i, reason: 'one isolated icon — not a scene' },
  { match: /\bmultiple\b/i, reason: 'one icon — not multiple subjects' },
  { match: /\bbusy\b/i, reason: 'simple — not busy' },
  { match: /\bcomplex\b/i, reason: 'simple — not complex' },
  { match: /\bdetailed\b/i, reason: 'iconic — not detailed' },
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
}

/**
 * Step 1 prompt. The LLM produces an ordered card list + a global palette.
 * Multimodal: the reference image is attached by the caller via
 * `generateText({ image })`; this prompt just refers to it.
 */
export function topicCardGridLlmPrompt(input: LlmPromptInput): { system: string; user: string } {
  const { title, niche, script, description, gridRows, gridCols, prefilledLabels } = input;
  const total = gridRows * gridCols;
  const usingPrefilled = !!prefilledLabels && prefilledLabels.length === total;

  const system = `You are designing a YouTube thumbnail in the "Topic Card Grid" format. The thumbnail is an N×M grid of cards. Each card has a dark-background illustration on top and a white label strip on the bottom. The grid is decorative + informational: it previews the video's content at a glance.

YOUR JOB: produce exactly ${total} card entries (the user has chosen a ${gridRows}×${gridCols} grid) and a single global palette that ties them together.

EVERY card's illustration MUST be:
- ONE bold central icon or symbol — vertically and horizontally centered, generously padded.
- On a dark/black background.
- Recognisable at 168×94 px (YouTube mobile thumbnail size). The icon idea must work small.

EVERY card's illustration MUST NOT be:
- A scene with multiple subjects.
- A UI screenshot, app mockup, or interface render.
- A photo of a person or any human face (unless the topic is literally a named person AND no symbol works).
- An illustration with embedded text, labels, or captions inside it.
- Busy, detailed, or cluttered. We want iconic and clean.

If a topic resists iconification, pick the closest concrete symbol:
- "Data breach" → broken padlock.
- "Awareness" → shield, lightbulb, or eye.
- "AI threat" → microchip with a glow.
- "Pipeline attack" → a single pipe with a crack.

The label is short (1–4 words ideally). The user reads it; it isn't part of the illustration.

A reference image is attached to this message. Match its visual style: layout, gutters, borders, the hand-drawn-feeling label font. KEEP per-card illustrations SIMPLER than the reference if the reference shows busy detailed cards — we want clean iconic cards.

Pick ONE global palette: black background + 2 accent colors that fit the niche. All ${total} cards share that palette; individual cards can vary their accent within it.

Cards are ordered left-to-right, top-to-bottom in the grid.

Return JSON only — no prose, no markdown fences. Schema:

{
  "cards": [
    { "index": 1, "label": "<1-4 words>", "icon_concept": "<one bold central icon/symbol on dark background, NO text, NO scene, NO person, NO UI>", "accent_color": "<hex or omit>" }
  ],
  "global_palette": {
    "background": "#000000",
    "primary_accent": "<hex>",
    "secondary_accent": "<hex>"
  },
  "notes_for_image_model": "<one short sentence of style guidance, optional>"
}

The cards array MUST contain EXACTLY ${total} entries.`;

  const userParts: string[] = [];
  userParts.push(`**Video Title:** ${title}`);
  userParts.push(`**Niche:** ${niche}`);
  userParts.push(`**Grid:** ${gridRows} rows × ${gridCols} columns = ${total} cards.`);
  if (description) userParts.push(`**Video Description:** ${description.slice(0, 500)}`);
  if (script) userParts.push(`**Script Excerpt (for context):** ${script.slice(0, 4000)}`);
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

  return { system, user: userParts.join('\n\n') };
}

export interface ImagePromptInput {
  cards: TopicCard[];
  palette: GlobalPalette;
  gridRows: number;
  gridCols: number;
  notesForImageModel?: string;
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
  const { cards, palette, gridRows, gridCols, notesForImageModel } = input;
  const total = gridRows * gridCols;
  const safeNotes = notesForImageModel ? sanitizeForPrompt(notesForImageModel, 300) : '';

  const cardLines = cards
    .map((c) => {
      const label = sanitizeForPrompt(c.label, 60);
      const concept = sanitizeForPrompt(c.icon_concept, 200);
      const accent = c.accent_color ? ` (accent: ${sanitizeForPrompt(c.accent_color, 16)})` : '';
      return `${c.index}. Label: "${label}" — Illustration: ${concept}${accent}`;
    })
    .join('\n');

  return `Create a YouTube thumbnail in the "Topic Card Grid" format, 16:9.

LAYOUT (strict):
- Pure black canvas behind everything.
- An evenly-spaced ${gridRows} rows × ${gridCols} columns grid of identical-size cards = ${total} cards total.
- A WHITE outer margin around the entire grid on all four sides of the canvas (top, bottom, left, right) — same width as the inter-card gutter.
- WHITE gutters of uniform width separating every card from its neighbours.
- Each card has a 2-3 px solid black border framing it, clearly visible against the white gutters.
- Each card is split into two stacked regions:
  • Top region (~80% of card height): the illustration.
  • Bottom region (~20% of card height): a pure white horizontal strip containing the card's label.
- A 1 px black hairline separates the illustration region from the white label strip.

PER-CARD ILLUSTRATION RULES (strict):
- Dark background (${sanitizeForPrompt(palette.background, 16)} or near-black).
- ONE bold central icon or symbol per card — vertically and horizontally centred, generously padded so the icon doesn't touch the card edges.
- NO embedded text anywhere inside the illustration.
- NO captions, NO labels, NO numbers as the main subject.
- NO UI screenshots, NO interface mockups, NO multi-subject scenes, NO human faces.
- Consistent rim lighting / soft glow across every card. Same lighting language throughout.
- Color treatment across all cards: background ${sanitizeForPrompt(palette.background, 16)}, primary accent ${sanitizeForPrompt(palette.primary_accent, 16)}, secondary accent ${sanitizeForPrompt(palette.secondary_accent, 16)}.
- Each icon must be recognisable at 168×94 px (YouTube mobile thumbnail size). If you can't see what it is at small size, it's too detailed.

LABEL STRIP RULES (strict):
- Pure white background.
- Card label rendered in the SAME hand-drawn humanist font as the attached reference image's typography (friendly weight, slight slope, NOT a system sans-serif).
- Label color: solid black.
- Centred horizontally and vertically in the strip.
- Labels go ONLY in the white strip — they NEVER appear in the illustration.

CARDS (render exactly these ${total} cards, in this order, reading left-to-right then top-to-bottom):

${cardLines}

ABSOLUTE REQUIREMENTS — DO NOT VIOLATE:
- The grid MUST contain EXACTLY ${total} cards. Not one more, not one fewer.
- Per-card illustrations MUST be simpler than any reference image you've seen — one bold isolated icon per card, no detail clutter. This is the most common failure mode of this format; do not repeat it.
- NO embedded text inside any card's illustration. Labels go ONLY in the white strips.
- Do NOT add a master title, watermark, channel logo, or any text outside the grid.
- Match the LAYOUT (grid + gutters + outer margin) and TYPOGRAPHY of the attached reference image precisely.

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

  const paletteRaw = (obj.global_palette ?? {}) as Record<string, unknown>;
  const global_palette: GlobalPalette = {
    background: String(paletteRaw.background ?? '#000000'),
    primary_accent: String(paletteRaw.primary_accent ?? '#e63a3a'),
    secondary_accent: String(paletteRaw.secondary_accent ?? '#ffb238'),
  };

  return {
    cards,
    global_palette,
    notes_for_image_model: obj.notes_for_image_model
      ? String(obj.notes_for_image_model)
      : undefined,
  };
}
