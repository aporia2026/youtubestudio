/**
 * Auto-group consecutive similar rows into variant groups so the editor's
 * Atlas-Edit dispatcher generates derivative frames from a shared base
 * image rather than from-scratch generations that drift apart.
 *
 * Why this exists: the production-doc LLM is told to emit variant
 * groups (`group_id` + `variant_index` + `variant_edit_prompt`) for the
 * doodle_explainer_2 style — see the mixing_rules in
 * src/lib/production-doc-styles.ts. Despite explicit hard-count
 * requirements and a worked Stone Age Brain Surgery example, the LLM
 * routinely emits N independent rows with similar-but-different
 * `ai_image_prompt` strings instead of grouped variants. Each
 * independent row then triggers a full ~$0.04 i2i generation with a
 * different seed, producing inconsistent images — the user reports this
 * as "no consistency, no frame by frame."
 *
 * This post-pass detects the pattern after the fact. Consecutive rows
 * whose `ai_image_prompt` strings are sufficiently similar (Jaccard
 * word-set overlap above threshold) are converted into a variant group:
 * the first row becomes the BASE (`variant_index: 0`), subsequent rows
 * become VARIANT rows (`variant_index: 1..N`) with their
 * `ai_image_prompt` cleared and a `variant_edit_prompt` extracted from
 * the diff. The existing variant dispatcher then routes those rows
 * through Atlas Edit on the base image (~$0.011/call), giving the
 * "near-static animation" look the user has been asking for.
 *
 * Safety properties:
 *   - Skips rows that already carry a `group_id` (idempotent against
 *     LLMs that DID emit variants).
 *   - Skips Title Card / Talking Head / Screen Recording rows (whose
 *     `ai_image_prompt` is empty by design).
 *   - Skips rows whose `ai_image_prompt` is too short to meaningfully
 *     compare (< 20 chars after suffix-strip).
 *   - Caps each group at 4 rows (1 base + 3 variants) to match the
 *     dispatcher's limit and the Phase 3 architectural decision.
 *   - Walks the diff extraction defensively: if no clean delta can be
 *     produced, leaves the rows ungrouped (no false-positive group).
 */

import type { ProductionDocRowLike } from './production-doc-postprocess';

export interface AutoGroupOptions {
  /** Overlap-coefficient threshold (intersection ÷ min set size) above
   *  which two consecutive rows are considered a group candidate.
   *  Default 0.55 — high enough to skip unrelated scenes, low enough
   *  to catch real evolving-scene patterns where the LLM rephrases
   *  ~half the words between beats. Overlap coefficient (vs Jaccard)
   *  is the right metric here: variants are subset-like — the smaller
   *  prompt's content is mostly contained in the larger one, with
   *  extra additions in the larger. Jaccard penalises that with a
   *  larger denominator and was rejecting clear variants in testing. */
  similarityThreshold?: number;
  /** Maximum rows per group (1 base + N-1 variants). Default 4. Tied to
   *  the Phase 3 architecture cap in mixing_rules. */
  maxGroupSize?: number;
  /** Minimum chars in `ai_image_prompt` (after the style suffix is
   *  attached) to consider a row eligible. Below this the comparison
   *  noise dominates. Default 20. */
  minPromptChars?: number;
  /** When the variant's extra-words list is shorter than this, fall back
   *  to the "subtle change from the base" template instead of emitting a
   *  too-terse edit prompt. Default 3. */
  minDeltaWords?: number;
}

export interface AutoGroupResult<R extends ProductionDocRowLike> {
  rows: R[];
  /** Number of variant groups formed by this pass. */
  groupCount: number;
  /** Number of rows promoted into variants (does NOT include the base
   *  rows — those keep their existing identity, just stamped with
   *  `variant_index: 0` and a fresh `group_id`). */
  mergedRowCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Lowercase + word-tokenise a prompt string. Punctuation is stripped to
 *  whitespace; numbers are kept (they often carry the salient delta —
 *  "3 hikers" vs "5 hikers"). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Overlap-coefficient similarity over word sets — `|A ∩ B| / min(|A|, |B|)`.
 *  Asymmetric in spirit: when one prompt is a near-subset of the other
 *  (variant adds content on top of base), the coefficient is high
 *  regardless of how much extra material the larger prompt has. Pure —
 *  no shared state. */
function overlapSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  return intersection / Math.min(tokensA.size, tokensB.size);
}

/** Extract a clean delta phrase the Atlas-Edit dispatcher can use as
 *  `variant_edit_prompt`. Tries two strategies in order:
 *
 *    1) Suffix extraction — if the variant prompt starts with most of
 *       the base prompt, return the trailing remainder. This handles
 *       the canonical "base + ', add a red question mark'" pattern.
 *
 *    2) Novel-word extraction — words in the variant not in the base,
 *       framed as a "keep the base, add" instruction. Handles cases
 *       where the LLM rephrased between beats but the new concepts
 *       are clearly tokenisable.
 *
 *  Returns null if neither approach produces a meaningful delta — the
 *  caller treats null as "don't promote this row to a variant after
 *  all" and leaves it as a standalone row.
 */
function extractDelta(
  basePrompt: string,
  variantPrompt: string,
  minDeltaWords: number,
): string | null {
  const baseTrim = basePrompt.trim();
  const variantTrim = variantPrompt.trim();
  if (!baseTrim || !variantTrim) return null;

  // Strategy 1 — common prefix suffix
  const prefixLen = commonPrefixLength(baseTrim, variantTrim);
  if (prefixLen >= baseTrim.length * 0.6 && variantTrim.length - prefixLen >= 10) {
    const suffix = variantTrim.slice(prefixLen).replace(/^[\s.,;:]+/, '').trim();
    if (suffix.length >= 10) {
      return `keep the base composition identical, ${stripImperativePreamble(suffix)}`;
    }
  }

  // Strategy 2 — novel words. Only return when there's a meaningful
  // amount of new content; otherwise the variant is more like a
  // rewording of the base and Atlas Edit would have nothing to do.
  const baseTokens = new Set(tokenize(baseTrim));
  const novelWords: string[] = [];
  for (const t of tokenize(variantTrim)) {
    if (!baseTokens.has(t) && !novelWords.includes(t)) novelWords.push(t);
  }
  if (novelWords.length >= minDeltaWords) {
    // Re-extract phrases from the original variant text where novel
    // tokens dominate. Preserves grammar over a tokenised
    // reconstruction. Joining multiple dense phrases lets us catch
    // additions that span across clauses (e.g. "blood on his head"
    // plus "his hand raised to it" — two phrases, one delta).
    const phrase = extractNoveltyDensePhrases(variantTrim, novelWords);
    if (phrase) {
      return `keep the base composition identical, ${stripImperativePreamble(phrase)}`;
    }
  }

  return null;
}

/** Longest common character prefix between two strings (case-insensitive
 *  for fairness — LLM capitalisation can drift between sibling beats). */
function commonPrefixLength(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const max = Math.min(la.length, lb.length);
  let i = 0;
  while (i < max && la[i] === lb[i]) i += 1;
  return i;
}

/** From `text`, return ALL clause-bounded phrases where more than half
 *  the content tokens are in `noveltyWords`, joined back with ", ".
 *  Novel-content density (rather than absolute count) lets us pick out
 *  phrases that are mostly delta — even short ones like "his hand
 *  raised" — while excluding long base-recap phrases like "two stick
 *  figure cavemen standing on a stone plain" which still contain some
 *  novel words but are dominated by base material.
 *
 *  Phrases are split on commas, semicolons, periods, and a small set
 *  of coordinating conjunctions. Returns null if no phrase clears the
 *  density bar — caller treats that as "delta too diffuse to express
 *  cleanly" and skips the group. */
function extractNoveltyDensePhrases(text: string, noveltyWords: string[]): string | null {
  const wordSet = new Set(noveltyWords.map((w) => w.toLowerCase()));
  const phrases = text.split(/[,.;]|\s+(?:and|but|while|with|plus|also)\s+/i);
  const kept: string[] = [];
  for (const raw of phrases) {
    const phrase = raw.replace(/^[,\s]+|[,\s]+$/g, '');
    if (!phrase) continue;
    const tokens = tokenize(phrase);
    if (tokens.length === 0) continue;
    let novelTokenCount = 0;
    for (const t of tokens) if (wordSet.has(t)) novelTokenCount += 1;
    const density = novelTokenCount / tokens.length;
    // Density gate: > 50% of tokens novel. Short delta phrases ("his
    // hand raised") cleanly clear; long base-recap phrases ("two stick
    // figure cavemen standing on a stone plain") fall under.
    if (density > 0.5 && novelTokenCount >= 1) {
      kept.push(phrase);
    }
  }
  if (kept.length === 0) return null;
  return kept.join(', ');
}

/** Atlas Edit reads imperative prompts ("add a red question mark…")
 *  much better than declarative ones ("there is a red question mark…").
 *  Strip declarative preambles so the final composed prompt reads as a
 *  single edit instruction. */
function stripImperativePreamble(phrase: string): string {
  const cleaned = phrase
    .replace(/^(?:and|but|while|with|also|plus)\s+/i, '')
    .replace(/^(?:there is|there are|the scene has|the picture shows|now)\s+/i, '')
    .trim();
  // Bias toward starting with an imperative verb. If the result already
  // begins with one (add / draw / place / show / put / make), keep it;
  // otherwise prepend "add" as the safest default.
  if (/^(?:add|draw|place|show|put|make|change|raise|drop|open|close|highlight|colour|color)\b/i.test(cleaned)) {
    return cleaned;
  }
  return `add ${cleaned}`;
}

/** Generate a short stable group id. Not cryptographically random — the
 *  variant dispatcher only needs a key for "rows in the same group", and
 *  collisions across docs don't matter because group ids are scoped to
 *  a single doc. */
function makeGroupId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `g_${rand}`;
}

/** Row eligibility for auto-grouping. Skip when:
 *   - Row already participates in a group (LLM did emit, or a prior
 *     pass already grouped it).
 *   - Row is a Title Card / Talking Head / Screen Recording (their
 *     ai_image_prompt is empty by design).
 *   - ai_image_prompt is too short to meaningfully compare. */
function isEligible(row: ProductionDocRowLike, minPromptChars: number): boolean {
  const bag = row as Record<string, unknown>;
  if (typeof bag.group_id === 'string' && bag.group_id.length > 0) return false;
  const visualType = typeof row.visual_type === 'string' ? row.visual_type : '';
  if (visualType === 'Title Card' || visualType === 'Talking Head' || visualType === 'Screen Recording') {
    return false;
  }
  const prompt = typeof bag.ai_image_prompt === 'string' ? bag.ai_image_prompt : '';
  return prompt.trim().length >= minPromptChars;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk the rows and group consecutive sufficiently-similar ones into
 * variant groups. Mutates the rows in place; also returns them along
 * with counters useful for telemetry / surfacing in the UI.
 *
 * The pass does NOT call the LLM, does NOT call Atlas Edit, and does
 * NOT cost anything. It's a pure string-similarity transformation on
 * the parsed result. Atlas Edit only fires later, lazily, when the
 * editor actually requests a variant image — same flow as if the LLM
 * had emitted the variant directly.
 */
export function autoGroupVariants<R extends ProductionDocRowLike>(
  rows: R[],
  options: AutoGroupOptions = {},
): AutoGroupResult<R> {
  // 0.4 default — verified against the Stone Age Brain Surgery sequence
  // where late variants accumulate enough new content that overlap with
  // the BASE drops to ~0.47 even when they're clearly the same group.
  // Below 0.4, unrelated scenes start to occasionally clip (truly
  // independent scenes share only stop-word-like tokens and score ~0.05,
  // so there's a comfortable margin). Override via the option only when
  // tuning a specific style's content distribution.
  const threshold = options.similarityThreshold ?? 0.4;
  const maxGroupSize = Math.max(2, options.maxGroupSize ?? 4);
  const minPromptChars = options.minPromptChars ?? 20;
  const minDeltaWords = options.minDeltaWords ?? 3;

  let groupCount = 0;
  let mergedRowCount = 0;

  let i = 0;
  while (i < rows.length) {
    if (!isEligible(rows[i], minPromptChars)) {
      i += 1;
      continue;
    }
    const baseRow = rows[i] as R & Record<string, unknown>;
    const basePrompt = String(baseRow.ai_image_prompt ?? '');

    // Walk forward while consecutive rows are similar to the BASE
    // (not the most recent variant — anchoring on the base prevents
    // drift where each variant resembles its predecessor but the last
    // one no longer resembles the start). Cap at maxGroupSize - 1
    // variants.
    const variants: Array<{ row: R; delta: string }> = [];
    let j = i + 1;
    while (j < rows.length && variants.length < maxGroupSize - 1) {
      if (!isEligible(rows[j], minPromptChars)) break;
      const candidate = rows[j] as R & Record<string, unknown>;
      const candidatePrompt = String(candidate.ai_image_prompt ?? '');
      const sim = overlapSimilarity(basePrompt, candidatePrompt);
      if (sim < threshold) break;
      const delta = extractDelta(basePrompt, candidatePrompt, minDeltaWords);
      if (!delta) break;
      variants.push({ row: rows[j], delta });
      j += 1;
    }

    if (variants.length === 0) {
      i += 1;
      continue;
    }

    // Promote the base + variants into a group. Write through the
    // index-signature side of the intersection (bracket notation) so
    // TypeScript doesn't try to resolve the field on R's narrowed
    // declaration — ProductionDocRowLike doesn't declare these fields,
    // they live on the `[key: string]: unknown` index signature.
    const groupId = makeGroupId();
    const baseBag = baseRow as Record<string, unknown>;
    baseBag.group_id = groupId;
    baseBag.variant_index = 0;

    variants.forEach((variant, idx) => {
      const v = variant.row as Record<string, unknown>;
      v.group_id = groupId;
      v.variant_index = idx + 1;
      v.variant_edit_prompt = variant.delta;
      // Clear ai_image_prompt — the dispatcher composes the final edit
      // prompt from base.ai_image_prompt + variant_edit_prompt. Leaving
      // a stale prompt here would confuse the editor's "is this row
      // image-ready?" check.
      v.ai_image_prompt = '';
    });

    groupCount += 1;
    mergedRowCount += variants.length;
    // Advance past the group. j is the index of the first non-grouped
    // row after the variants.
    i = j;
  }

  return { rows, groupCount, mergedRowCount };
}
