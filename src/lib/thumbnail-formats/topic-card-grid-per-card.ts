/**
 * Per-card generation primitives for the topic-card grid.
 *
 * **Why this exists:** the legacy pipeline produces the whole thumbnail
 * in ONE AI call — all N discs, all gutters, all labels in a single
 * render. AI image models are notoriously bad at precise grid layout,
 * so even with explicit prompt instructions the AI produces crowded
 * rows that no amount of text guidance fixes. The reference image
 * (`public/thumbnail-formats/topic-card-grid-default.png`) influences
 * layout more than text, but the AI still drifts toward "what
 * thumbnails usually look like".
 *
 * The structural fix: generate each card's illustration SEPARATELY
 * (N AI calls returning square illustrations), then let our existing
 * `buildCircleCellOverlay` composite them onto a canvas with perfect
 * spacing. The composite math (`effectiveRowGutter`, etc.) already
 * yields SCP-style breathing room — what's missing is feeding it
 * per-card AI illustrations instead of user uploads.
 *
 * **Cost note (rule 8):** N AI calls instead of 1. At GPT Image 2
 * medium ~$0.04/image that's ~$0.36 for 9 cards vs ~$0.04 for one
 * mega-call. Real cost increase the route should flag to the user.
 *
 * **Style consistency:** independent AI calls won't auto-share palette
 * or line weight. The `styleHeader` field on every prompt is the lever
 * — it carries the brand/style instructions across all N calls so the
 * grid still reads as one coherent set, not a yard sale of unrelated
 * illustrations.
 *
 * **Failure semantics:** the runner captures per-card errors instead
 * of aborting the whole batch. The caller decides whether a partial
 * result is shippable — usually it is (a 9-card grid with 1 failed
 * card can fall back to a placeholder + retry that single card).
 *
 * Plan: `_plans/2026-06-04-topic-card-grid-per-card-generation.md`.
 */

import type { Buffer } from 'node:buffer';
import {
  brightnessDirective,
  detailDirective,
  styleDirective,
  type CardShape,
  type ThumbnailBrightness,
  type ThumbnailDetail,
  type ThumbnailStyle,
  type TopicCard,
} from './topic-card-grid';

// ─── Shared style header ────────────────────────────────────────────────────

export interface PerCardStyleHeaderInput {
  /** Visual style register. Same union the mega-prompt accepts so the
   *  two modes produce visually consistent output for the same axes. */
  style: ThumbnailStyle;
  /** Free-form style sentence. Only consulted when `style === 'free-form'`;
   *  ignored otherwise (mirrors `topicCardGridImagePrompt`). */
  styleFreeForm?: string;
  /** Brightness register. Threaded into the header verbatim so a "Bright"
   *  toggle in the editor produces the same vivid-palette wording in both
   *  per-card prompts and the mega-prompt. */
  brightness: ThumbnailBrightness;
  /** Detail register — `clean` vs `detailed`. Carried through so per-card
   *  illustrations don't drift into multi-element compositions when the
   *  user picked Clean for the overall grid. */
  detail: ThumbnailDetail;
}

/**
 * Build the shared style header that prefixes every per-card prompt in a
 * batch. The header carries the brand/style information that keeps the
 * N independent AI calls visually coherent — without it the cards land
 * looking like a yard sale.
 *
 * Reuses the exact same `styleDirective` / `brightnessDirective` /
 * `detailDirective` wording the mega-prompt uses, so a user who toggles
 * between one-shot and per-card modes for the same axes sees a
 * consistent visual register across both modes.
 */
export function buildPerCardStyleHeader(input: PerCardStyleHeaderInput): string {
  const { style, styleFreeForm, brightness, detail } = input;
  return [
    'SHARED STYLE (applies to this card and every other card in the set — DO NOT drift):',
    '',
    styleDirective(style, styleFreeForm),
    '',
    brightnessDirective(brightness),
    '',
    detailDirective(detail),
  ].join('\n');
}

// ─── Per-card prompt builder ────────────────────────────────────────────────

export interface PerCardPromptInput {
  /** The card to illustrate. `icon_concept` becomes the subject; `label`
   *  is included only so the AI can frame the illustration with the
   *  semantic context — the label is NOT drawn into the illustration
   *  itself (our composite paints it separately). */
  card: TopicCard;
  /** Shared style header that goes at the TOP of every per-card prompt
   *  in this batch. Carries the brand/style instructions — colour
   *  palette hints, line weight, background treatment, any visual
   *  conventions the user picked. Empty string is allowed (no shared
   *  style) but discouraged: independent AI calls drift visually.
   *  Length budget: keep under ~800 chars so the per-card body has
   *  room to land its subject description. */
  styleHeader: string;
  /** Final render shape. `'circle'` adds a critical hint about corners
   *  being clipped — without it the AI tends to put important subject
   *  detail near the square corners that the disc never reveals.
   *  `'square'` skips the warning. */
  cardShape: CardShape;
  /** Optional explicit background colour for the illustration. When
   *  omitted, falls back to `card.accent_color`; when that's also
   *  omitted the AI picks a colour that fits the subject. The explicit
   *  override exists so callers can force a specific palette across a
   *  batch (e.g. all-white backgrounds for a "monochrome doc" style)
   *  without mutating the source card data. */
  backgroundColor?: string;
}

/**
 * Build the prompt for ONE card. Output is plain text suitable for
 * direct submission to GPT Image 2 / Kie / any image API that accepts
 * a text prompt. No grid context, no other-card context — each call
 * is independent and forgets everything except the shared style
 * header.
 */
export function buildPerCardPrompt(input: PerCardPromptInput): string {
  const { card, styleHeader, cardShape } = input;
  const trimmedHeader = styleHeader.trim();
  const headerBlock = trimmedHeader ? `${trimmedHeader}\n\n` : '';

  // Explicit `backgroundColor` wins; otherwise inherit from the card's
  // own `accent_color`. Direct callers and the runner-driven path land
  // on the same prompt this way.
  const backgroundColor = input.backgroundColor ?? card.accent_color;
  const bgLine = backgroundColor
    ? `- Background: solid ${backgroundColor}, filling the entire square edge to edge. NO patterns, NO gradients on the background.`
    : `- Background: a SINGLE solid colour that complements the subject. NO patterns, NO gradients, NO scenes, NO landscapes.`;

  const cropHint =
    cardShape === 'circle'
      ? `- IMPORTANT: this illustration will be CROPPED to a circle by the downstream pipeline. Anything outside the inscribed circle of the 1024×1024 square (≈ 13 % of the area, the four corners) will be invisible. Keep ALL focal subject content within the inscribed circle. Backgrounds can extend to the corners — they will be clipped harmlessly.`
      : `- The illustration will be rendered inside a rectangular cell. Corners are visible.`;

  return `${headerBlock}SINGLE-CARD ILLUSTRATION:
- Generate ONE 1024×1024 SQUARE illustration. ONE illustration only — not a thumbnail, not a grid, not multiple panels.
- Subject: ${card.icon_concept}
${bgLine}
- Frame the subject CENTRED. Tight composition — fill most of the inscribed circle area with the subject, leave generous solid-colour padding around it.
- Style: follow the style header above precisely (line weight, palette family, illustration conventions).
- TEXT INSIDE THE ILLUSTRATION IS FORBIDDEN. The card label "${card.label}" is painted SEPARATELY by our pipeline on a white strip below the illustration — do NOT include any caption, label, title, watermark, or other text in this square. The ONLY allowed text is if it is part of the subject's intrinsic visual identity (e.g. a brand wordmark, an iconic newspaper headline, a single iconic stamp like "SECRET").
${cropHint}`;
}

// ─── Concurrency-limited parallel runner ────────────────────────────────────

export interface PerCardRunnerInput {
  cards: TopicCard[];
  styleHeader: string;
  cardShape: CardShape;
  /** Function that turns a prompt into image bytes. The route injects
   *  the actual API call (e.g. `generateImageOpenAI`); tests inject a
   *  deterministic stub. This indirection is what makes the runner
   *  unit-testable without touching the network. */
  generate: (prompt: string, card: TopicCard) => Promise<Buffer>;
  /** Maximum simultaneous in-flight `generate` calls. Default `4` keeps
   *  us within OpenAI's per-org image rate limits without serialising
   *  the batch end-to-end. Set lower to be polite to flaky providers,
   *  higher if you have headroom. */
  concurrency?: number;
}

export interface PerCardRunnerResult {
  /** 1-based card index, same as `TopicCard.index`. Lets the caller
   *  thread the bytes back to the right cell when results may arrive
   *  out of order. */
  cardIndex: number;
  /** Image bytes on success. Undefined when `error` is set. */
  bytes?: Buffer;
  /** Error message on failure. Undefined on success. The runner never
   *  throws — partial-success batches return a mixed result array and
   *  let the caller decide whether to retry, fall back, or ship. */
  error?: string;
  /** Wall-clock duration of the `generate` call, in ms. Diagnostic
   *  only — useful for spotting one slow card dragging down a batch. */
  durationMs: number;
}

/**
 * Run `generate` for each card in `cards`, capping in-flight calls to
 * `concurrency`. Returns a stable-order result array (same length and
 * order as `cards`) so the caller can splice results back into the
 * existing position-keyed upload pipeline.
 *
 * Per-card failures are captured into the result's `error` field. The
 * runner does NOT retry, does NOT throw, and does NOT abort siblings
 * when one card fails — those policy choices belong to the caller.
 */
export async function runPerCardGeneration(
  input: PerCardRunnerInput,
): Promise<PerCardRunnerResult[]> {
  const { cards, styleHeader, cardShape, generate, concurrency = 4 } = input;
  const results: PerCardRunnerResult[] = new Array(cards.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= cards.length) return;
      const card = cards[i];
      // `buildPerCardPrompt` picks up `card.accent_color` automatically
      // when `backgroundColor` is omitted, so we don't thread it here.
      const prompt = buildPerCardPrompt({ card, styleHeader, cardShape });
      const startedAt = Date.now();
      try {
        const bytes = await generate(prompt, card);
        results[i] = {
          cardIndex: card.index,
          bytes,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        results[i] = {
          cardIndex: card.index,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, cards.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
