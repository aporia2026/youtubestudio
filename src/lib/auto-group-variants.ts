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

/** Length of the longest common TRAILING substring of two strings
 *  (case-insensitive). Used to detect — and strip — the shared style
 *  suffix that `attachStyleSuffixToRows` appends to every row's
 *  ai_image_prompt. Without stripping, the suffix's ~60 shared
 *  tokens inflate `overlapSimilarity` for any two suffix-bearing rows
 *  to ~0.55 regardless of whether their actual SCENE bodies are
 *  related, producing false-positive variant groups (the user-
 *  reported "tent / bodies / avalanche grouped as variants" bug). */
function commonSuffixLength(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  let i = la.length - 1;
  let j = lb.length - 1;
  let count = 0;
  while (i >= 0 && j >= 0 && la[i] === lb[j]) {
    i -= 1;
    j -= 1;
    count += 1;
  }
  return count;
}

/** Strip the trailing common substring (likely the appended style
 *  suffix) before similarity comparison. Only fires when the common
 *  trailing run is long enough to be the suffix (vs incidental
 *  shared ending punctuation); below 40 chars we leave both strings
 *  alone so genuinely-similar short prompts still match correctly.
 *  The 40-char floor sits well above incidental endings ("on a plain
 *  white background." = ~25 chars) and well below any real style
 *  suffix (Doodle Explainer 2's trimmed suffix is ~560 chars). */
const MIN_COMMON_SUFFIX_TO_STRIP = 40;
function stripCommonSuffix(a: string, b: string): { a: string; b: string } {
  const len = commonSuffixLength(a, b);
  if (len < MIN_COMMON_SUFFIX_TO_STRIP) return { a, b };
  return {
    a: a.slice(0, a.length - len),
    b: b.slice(0, b.length - len),
  };
}

/** Overlap-coefficient similarity over word sets — `|A ∩ B| / min(|A|, |B|)`.
 *  Asymmetric in spirit: when one prompt is a near-subset of the other
 *  (variant adds content on top of base), the coefficient is high
 *  regardless of how much extra material the larger prompt has. Pure —
 *  no shared state.
 *
 *  The trailing common substring (the appended style suffix) is
 *  stripped from BOTH inputs before tokenisation. Without this, two
 *  unrelated scenes sharing the same 400+ char style suffix score
 *  ~0.55 on the suffix alone — high enough to trip the default
 *  grouping threshold even when the actual scene bodies are
 *  semantically unrelated (e.g. "Their tent was found cut open" vs
 *  "Several bodies sustained severe trauma"). Stripping the suffix
 *  lets us compare scene bodies only, which is what we actually
 *  want to measure for "is this the same composition with a small
 *  delta?". */
function overlapSimilarity(a: string, b: string): number {
  const { a: strippedA, b: strippedB } = stripCommonSuffix(a, b);
  const tokensA = new Set(tokenize(strippedA));
  const tokensB = new Set(tokenize(strippedB));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  return intersection / Math.min(tokensA.size, tokensB.size);
}

/** Detect prose-level variant cues — phrases the LLM uses when it
 *  understands a row is a variant but writes the full prompt anyway
 *  (instead of emitting the structural group_id + variant_index +
 *  variant_edit_prompt). The Mary Celeste QA showed this pattern
 *  reliably: row N says "Same empty brigantine deck as before, with
 *  both sailors now frozen..." but lacks group_id, so the row is
 *  emitted as a fresh full-cost generation.
 *
 *  Returns true when the prompt's opening sentence reads like a
 *  continuation of a previous scene. The opening (first ~80 chars) is
 *  where this cue lives in practice — the rest of the prompt then
 *  describes the additive delta.
 *
 *  Conservative on purpose: only matches strong prose signals
 *  ("Same X as before", "The same X with", "Continuing from the
 *  previous"). Weaker hedges ("still", "now") on their own match too
 *  often for unrelated reasons (e.g. "the still water", "now the wind
 *  picked up"). */
const PROSE_VARIANT_PATTERNS: readonly RegExp[] = [
  /^\s*the\s+same\s+/i,
  /^\s*same\s+\w+.{0,80}\bas\s+before\b/i,
  /^\s*same\s+\w+.{0,80}\bbut\s+(now|with|the)\b/i,
  /^\s*same\s+scene\b/i,
  /^\s*same\s+composition\b/i,
  /^\s*same\s+(shot|frame|view|angle)\b/i,
  /^\s*continuing\s+from\s+the\s+previous\b/i,
  /^\s*from\s+the\s+same\s+(angle|camera|view|frame)\b/i,
  // "Same empty brigantine deck as before" — the QA-observed pattern.
  // Covers "Same X, now with Y" too via the second pattern above.
  /^\s*same\s+\w+(\s+\w+){0,4}.{0,40}\b(now|then)\s+/i,
];

function looksLikeProseVariant(prompt: string): boolean {
  const head = prompt.slice(0, 200);
  return PROSE_VARIANT_PATTERNS.some((re) => re.test(head));
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
      // Effective threshold drops to 0.25 when the candidate's prompt
      // opens with a strong prose-variant cue ("Same X as before",
      // "The same scene, but now…"). Those cues mean the LLM
      // understood the row was a variant but wrote a full prompt
      // instead of the structural variant_edit_prompt form. The
      // overlap can be as low as ~0.3 in those cases because the
      // variant text describes the DELTA in fresh vocabulary
      // ("frozen", "wide eyes", "open mouths") while sharing only a
      // few base nouns. Below 0.25 we still bail — that's where the
      // false-positive risk lives. See the Mary Celeste QA run
      // 2026-05-28T06:41:00 for the row 4/5 case this catches.
      const candThreshold = looksLikeProseVariant(candidatePrompt) ? 0.25 : threshold;
      if (sim < candThreshold) break;
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

  // Rescue pass — fix orphan variants. The LLM occasionally emits a
  // row with `variant_index >= 1` and a `group_id` but FORGETS to mark
  // the preceding row as the base (variant_index: 0, same group_id).
  // The main walk above skips already-tagged rows, so this malformed
  // pattern would otherwise survive intact and the renderer would have
  // a variant with no base. Rescue it by grafting the previous fresh
  // (untagged) row into the group as variant_index: 0. Observed in QA
  // run 2026-05-28T06:51:23 (Mary Celeste): row 5 had
  // `mary-empty-deck-1#1` but row 4 was a plain fresh row that was
  // clearly the intended base.
  for (let k = 1; k < rows.length; k++) {
    const curBag = rows[k] as Record<string, unknown>;
    const curGroupId = curBag.group_id;
    const curVariantIndex = curBag.variant_index;
    if (typeof curGroupId !== 'string' || curGroupId.length === 0) continue;
    if (typeof curVariantIndex !== 'number' || curVariantIndex < 1) continue;
    // Already has a properly-matched base earlier? Skip.
    let hasBase = false;
    for (let p = k - 1; p >= 0; p--) {
      const prev = rows[p] as Record<string, unknown>;
      if (prev.group_id === curGroupId && prev.variant_index === 0) {
        hasBase = true;
        break;
      }
      // Stop scanning back at the first row that BELONGS to a different
      // group — bases don't skip across other groups.
      if (typeof prev.group_id === 'string' && prev.group_id !== curGroupId) break;
    }
    if (hasBase) continue;
    // Promote the previous row into the group as the base, if it's
    // a plain fresh row (no existing group_id) and has an ai_image_prompt
    // we can use.
    const baseBag = rows[k - 1] as Record<string, unknown>;
    const baseCandidatePrompt = typeof baseBag.ai_image_prompt === 'string' ? baseBag.ai_image_prompt : '';
    if (
      typeof baseBag.group_id === 'string' && baseBag.group_id.length > 0
    ) continue; // not a free fresh row — don't steal it
    if (baseCandidatePrompt.trim().length < minPromptChars) continue;
    baseBag.group_id = curGroupId;
    baseBag.variant_index = 0;
    // If the orphan variant had a populated ai_image_prompt (instead of
    // the proper variant_edit_prompt), convert it into an edit prompt
    // and clear the full prompt — same shape the main walk produces.
    const orphanFullPrompt = typeof curBag.ai_image_prompt === 'string' ? curBag.ai_image_prompt : '';
    const existingEditPrompt = typeof curBag.variant_edit_prompt === 'string' ? curBag.variant_edit_prompt : '';
    if (orphanFullPrompt.length > 0 && existingEditPrompt.length === 0) {
      const delta = extractDelta(baseCandidatePrompt, orphanFullPrompt, minDeltaWords);
      if (delta) {
        curBag.variant_edit_prompt = delta;
        curBag.ai_image_prompt = '';
      }
    }
    groupCount += 1;
    mergedRowCount += 1; // the orphan was already tagged; the base is the new addition
  }

  return { rows, groupCount, mergedRowCount };
}
