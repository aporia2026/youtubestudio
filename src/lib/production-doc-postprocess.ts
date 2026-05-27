/**
 * Post-processing for LLM-generated production docs. The prompt at
 * `src/lib/prompts.ts` instructs the model to keep each row's narration
 * within 4–6 seconds, with a hard ceiling of 7 seconds. The model is
 * unreliable at length constraints, so this module runs a deterministic
 * second pass that splits any row whose `script_text` would exceed the
 * cap at the doc's speaking pace.
 *
 * Why split rather than warn-and-leave: a row whose narration runs longer
 * than the i2v clip duration ends with a frozen last frame — visually
 * jarring even when the underlying clip is animated. Splitting one long
 * row into two shorter ones with the same visual fields (so the editor
 * sees a duplicate-shot warning and can edit one of them before animating)
 * trades a one-time editor decision for never-again-broken scene timing.
 *
 * The split is purely textual: sentence boundaries (`.`, `!`, `?`) closest
 * to the row's midpoint. We do NOT call the LLM again — keeping this free
 * and deterministic. The downside is duplicate visual_description /
 * ai_image_prompt across the new rows; the warnings array surfaces this
 * so the editor can rewrite one of them before animating.
 *
 * See plan `_plans/2026-05-18-shorter-scenes-and-new-models.md`.
 */

/** Hard ceiling on narration length per row, in seconds. Above this the
 *  i2v clip freezes its last frame and the editor sees a visibly stuck
 *  scene. Tied to the prompt's "NEVER exceed 7s" language. */
export const PRODUCTION_DOC_MAX_SECONDS_PER_ROW = 7.0;

/** Recursion safety — even pathologically long input rows should converge
 *  within a few splits. Prevents an infinite loop if the splitter ever
 *  fails to actually shorten the row (which would be a bug, but better
 *  to bail than to hang generation). */
const MAX_SPLIT_DEPTH = 4;

/** Minimal shape of a production-doc row this module reads from / writes
 *  to. Kept structural so the route can pass through whatever extra
 *  fields the LLM produced (overlay_*, etc.) without this module needing
 *  to know about them. */
export interface ProductionDocRowLike {
  timecode: string;
  script_text: string;
  visual_type?: string;
  [key: string]: unknown;
}

export interface SplitResult<R extends ProductionDocRowLike> {
  rows: R[];
  warnings: string[];
  /** How many input rows exceeded the cap. Includes rows that could not
   *  be split (no internal sentence boundary). */
  overlongRowCount: number;
  /** How many split operations were performed. May exceed overlongRowCount
   *  when a row gets split more than once during recursion. */
  splitCount: number;
}

/**
 * Walk the LLM-produced rows and split any whose narration exceeds the
 * per-row cap. Returns the new row list (preserving order), a list of
 * human-readable warnings the UI can surface, and counters for logging.
 *
 * Title Card rows are exempt from the cap — they're by definition short
 * (1–2 s of heading text) and never carry the duration risk this module
 * is here to mitigate.
 */
export function validateAndSplitOverlongRows<R extends ProductionDocRowLike>(
  rows: R[],
  speakingPaceWpm: number,
  options: { maxSecondsPerRow?: number } = {},
): SplitResult<R> {
  const cap = options.maxSecondsPerRow ?? PRODUCTION_DOC_MAX_SECONDS_PER_ROW;
  const out: R[] = [];
  const warnings: string[] = [];
  let overlongRowCount = 0;
  let splitCount = 0;

  for (const row of rows) {
    const seconds = estimateRowSeconds(row.script_text, speakingPaceWpm);
    if (row.visual_type === 'Title Card' || seconds <= cap) {
      out.push(row);
      continue;
    }

    overlongRowCount += 1;
    const splits = splitRowRecursively(row, speakingPaceWpm, cap, 0);
    if (splits.kind === 'split') {
      out.push(...splits.rows);
      splitCount += splits.rows.length - 1;
      warnings.push(
        `Row at ${row.timecode} (${seconds.toFixed(1)}s narration) was split into ${splits.rows.length} rows to keep each scene under ${cap}s. The split rows share the same visual description — edit one of them before animating for a distinct second shot.`,
      );
    } else {
      // With the three-tier cascade in splitScriptAtAnyBoundary
      // (sentence → clause → word), this branch fires only when the
      // row is a single token — vanishingly rare in practice, since a
      // single word can't exceed the duration cap at any realistic wpm.
      out.push(row);
      warnings.push(
        `Row at ${row.timecode} is ${seconds.toFixed(1)}s of narration but is a single unbroken token — no word boundary exists to split on. The animation will freeze the last frame after ${cap}s.`,
      );
    }
  }

  return { rows: out, warnings, overlongRowCount, splitCount };
}

/** Recursive splitter. Returns `{ kind: 'split', rows }` on success, or
 *  `{ kind: 'unsplittable' }` if the row is a single word (so even the
 *  word-boundary fallback can't help). With the three-tier cascade in
 *  `splitScriptAtAnyBoundary`, unsplittable is now exceedingly rare —
 *  almost every multi-word row gets split. */
function splitRowRecursively<R extends ProductionDocRowLike>(
  row: R,
  wpm: number,
  cap: number,
  depth: number,
): { kind: 'split'; rows: R[] } | { kind: 'unsplittable' } {
  if (depth >= MAX_SPLIT_DEPTH) {
    return { kind: 'split', rows: [row] };
  }
  const seconds = estimateRowSeconds(row.script_text, wpm);
  if (seconds <= cap) return { kind: 'split', rows: [row] };

  const split = splitScriptAtAnyBoundary(row.script_text);
  if (!split) return { kind: 'unsplittable' };

  const firstRow = { ...row, script_text: split.first } as R;
  const firstSeconds = estimateRowSeconds(split.first, wpm);
  const secondTimecode = shiftTimecodeBySeconds(row.timecode, firstSeconds);
  const secondRow = { ...row, timecode: secondTimecode, script_text: split.second } as R;

  const firstResult = splitRowRecursively(firstRow, wpm, cap, depth + 1);
  const secondResult = splitRowRecursively(secondRow, wpm, cap, depth + 1);

  const collected: R[] = [];
  if (firstResult.kind === 'split') collected.push(...firstResult.rows);
  else collected.push(firstRow);
  if (secondResult.kind === 'split') collected.push(...secondResult.rows);
  else collected.push(secondRow);

  return { kind: 'split', rows: collected };
}

/** Estimate a row's spoken duration from its word count and the doc's
 *  speaking pace. Same formula the prompt uses, so this stays consistent
 *  with what the LLM thinks the timing is. */
export function estimateRowSeconds(scriptText: string, wpm: number): number {
  const wordCount = scriptText.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return 0;
  return (wordCount / wpm) * 60;
}

/** Find a sentence boundary closest to the middle of `text` and split there.
 *  Returns null if no usable boundary exists (the whole row is one sentence,
 *  or shorter than a single sentence). */
export function splitScriptAtSentenceBoundary(
  text: string,
): { first: string; second: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Find sentence-ending punctuation followed by whitespace + capital-ish
  // letter. The capital-letter constraint avoids splitting on abbreviations
  // ("Dr. Smith") or decimals embedded in numbers ("3.14 ").
  const boundaryRegex = /[.!?…](?=\s+["'(]?[A-Z0-9])/g;
  const candidates: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = boundaryRegex.exec(trimmed)) !== null) {
    // Index of the character AFTER the punctuation — split AT this position
    // so the first half ends with the punctuation and the second half
    // starts with the next sentence (leading whitespace stripped on assign).
    candidates.push(match.index + 1);
  }
  if (candidates.length === 0) return null;

  const midpoint = trimmed.length / 2;
  let bestIndex = candidates[0];
  let bestDistance = Math.abs(candidates[0] - midpoint);
  for (const c of candidates) {
    const d = Math.abs(c - midpoint);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = c;
    }
  }
  const first = trimmed.slice(0, bestIndex).trim();
  const second = trimmed.slice(bestIndex).trim();
  if (!first || !second) return null;
  return { first, second };
}

/** Three-tier cascade splitter. Tries each tier in order and returns the
 *  first successful split. Designed so that real-world multi-word rows
 *  practically always succeed — only a literal single word fails.
 *
 *  Tier 1 — sentence boundary (`splitScriptAtSentenceBoundary`).
 *    Period / question mark / exclamation followed by a capital letter.
 *    Best-quality split: the two halves are independent sentences.
 *
 *  Tier 2 — clause boundary (`splitScriptAtClauseBoundary`).
 *    Comma followed by whitespace + lowercase word, a standalone
 *    coordinating conjunction (and / but / so / because / however /
 *    although / while / yet / or) surrounded by whitespace, or an em
 *    dash. The halves are sub-sentences; reads cleanly when the audio
 *    is played continuous.
 *
 *  Tier 3 — word boundary (`splitScriptAtWordBoundary`).
 *    Any whitespace-delimited break. The halves are mid-clause but the
 *    voiceover plays continuously across the boundary — only the visual
 *    cut lands at the unusual point. Directors mid-clause-cut routinely
 *    (the Verite cut), so a viewer doesn't notice.
 *
 *  Returns null only when `text` is a single token (no internal whitespace).
 */
export function splitScriptAtAnyBoundary(
  text: string,
): { first: string; second: string } | null {
  return (
    splitScriptAtSentenceBoundary(text) ??
    splitScriptAtClauseBoundary(text) ??
    splitScriptAtWordBoundary(text)
  );
}

/** Tier 2 — clause boundary. Finds the candidate closest to the midpoint
 *  among:
 *    - commas followed by whitespace + a letter (avoids splitting numeric
 *      literals like "1,000" and date forms like "December 25, 2023")
 *    - coordinating conjunctions surrounded by whitespace ("and", "but",
 *      "so", "because", "however", "although", "while", "yet", "or") —
 *      the split lands JUST BEFORE the conjunction so the second half
 *      starts with it ("…we waited, but then…" → first ends with "waited",
 *      second starts with "but")
 *    - em dashes (real " — " or hyphenated " -- ")
 *
 *  Returns null if none of those exist in the text.
 */
export function splitScriptAtClauseBoundary(
  text: string,
): { first: string; second: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: number[] = [];

  // Commas followed by whitespace + a letter. The character index AFTER
  // the comma is the split point — first half keeps the comma, second
  // half begins with the next clause.
  const commaRegex = /,(?=\s+[A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = commaRegex.exec(trimmed)) !== null) {
    candidates.push(m.index + 1);
  }

  // Coordinating conjunctions. Match whitespace + conjunction + whitespace
  // and place the split BEFORE the conjunction (at the leading whitespace).
  const conjunctionRegex = /\s+(?:and|but|so|because|however|although|while|yet|or)\s+/gi;
  while ((m = conjunctionRegex.exec(trimmed)) !== null) {
    candidates.push(m.index);
  }

  // Em dashes / double hyphens with surrounding whitespace. Split BEFORE
  // the dash so the second half starts with it (matches the conjunction
  // convention).
  const dashRegex = /\s+(?:—|--|–)\s+/g;
  while ((m = dashRegex.exec(trimmed)) !== null) {
    candidates.push(m.index);
  }

  if (candidates.length === 0) return null;

  const midpoint = trimmed.length / 2;
  let bestIndex = candidates[0];
  let bestDistance = Math.abs(candidates[0] - midpoint);
  for (const c of candidates) {
    const d = Math.abs(c - midpoint);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = c;
    }
  }
  const first = trimmed.slice(0, bestIndex).trim();
  const second = trimmed.slice(bestIndex).trim();
  if (!first || !second) return null;
  return { first, second };
}

/** Tier 3 — word boundary. Splits at the whitespace gap closest to the
 *  midpoint of the text. Always succeeds for ≥2-word inputs. Returns
 *  null only for a single token (a one-word row, which is too short to
 *  ever exceed the timing cap anyway).
 *
 *  Why this is acceptable: the doc's `script_text` is the verbatim
 *  voiceover; the narrator reads the script continuously regardless of
 *  row boundaries. A row boundary is a VISUAL cut point only. Cutting
 *  visually mid-clause while audio runs through is a standard editing
 *  technique (Verite cut, "L-cut") and viewers don't perceive it as
 *  jarring — the alternative (a frozen last frame on an overlong row)
 *  IS visually jarring.
 */
export function splitScriptAtWordBoundary(
  text: string,
): { first: string; second: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return null;

  // Walk the character positions of each inter-word gap and pick the
  // one closest to the textual midpoint. `charPos` after the loop body
  // equals the END of token i; the split point is AT that position
  // (whitespace after gets trimmed when assigning halves).
  const midpoint = trimmed.length / 2;
  let charPos = 0;
  let bestSplit = tokens[0].length;
  let bestDistance = Math.abs(bestSplit - midpoint);
  for (let i = 0; i < tokens.length - 1; i++) {
    charPos += tokens[i].length;
    const d = Math.abs(charPos - midpoint);
    if (d < bestDistance) {
      bestDistance = d;
      bestSplit = charPos;
    }
    charPos += 1; // account for the single whitespace between tokens
  }

  const first = trimmed.slice(0, bestSplit).trim();
  const second = trimmed.slice(bestSplit).trim();
  if (!first || !second) return null;
  return { first, second };
}

/** Add `seconds` to a "M:SS" timecode, returning a new "M:SS" string. */
export function shiftTimecodeBySeconds(timecode: string, seconds: number): string {
  const match = /^(\d+):(\d{1,2})$/.exec(timecode.trim());
  if (!match) return timecode;
  const baseSeconds = Number(match[1]) * 60 + Number(match[2]);
  const total = Math.max(0, Math.round(baseSeconds + seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Result of the style-suffix attachment pass. */
export interface AttachSuffixResult<R extends ProductionDocRowLike> {
  rows: R[];
  /** Rows whose ai_image_prompt was non-empty and received the suffix. */
  attachedCount: number;
  /** Non-empty rows skipped because the body already ended with the suffix
   *  (idempotency — LLM partial compliance, retries). */
  skippedAlreadyPresent: number;
  /** Non-empty rows skipped because the body was not a string. */
  skippedNonString: number;
}

/** Substring length used for idempotency detection. Long enough to make a
 *  false positive on natural prose essentially impossible; short enough that
 *  a body that contains *most* of the suffix (LLM partial compliance) still
 *  matches. */
const SUFFIX_FINGERPRINT_CHARS = 80;

/**
 * Append the style suffix to every row whose `ai_image_prompt` carries a
 * non-empty scene body.
 *
 * Why this exists: the LLM used to be asked to copy the style suffix verbatim
 * into every row. For long-suffix styles (doodle_explainer_2 is 377 words /
 * ~500 tokens) this blew past GPT-mini-class models' 16k output cap mid-stream
 * on long scripts. Now the LLM emits only the 35–55 word scene body and the
 * server attaches the suffix here, after JSON parsing. Persisted row shape is
 * identical to the old "LLM wrote the suffix in" path, so zero downstream
 * consumers change.
 *
 * Rules:
 *   - Empty `ai_image_prompt` ("") stays empty — those are Title Card /
 *     Talking Head / Screen Recording rows which never carried a suffix.
 *   - Idempotency: if the body already contains the suffix's first 80 chars,
 *     leave it alone. Handles LLMs that ignored the new instruction and
 *     handles retries against rows that already had the suffix attached.
 *   - Joiner: the body's trailing whitespace and trailing periods are
 *     stripped, then `". " + suffix` is appended. Matches the joining
 *     convention `buildBrollPrompt` uses when composing the final prompt.
 *
 * Empty / missing suffix → pass-through, no mutations.
 */
export function attachStyleSuffixToRows<R extends ProductionDocRowLike>(
  rows: R[],
  suffix: string | null | undefined,
): AttachSuffixResult<R> {
  const cleanSuffix = (suffix ?? '').trim();
  if (!cleanSuffix) {
    return { rows, attachedCount: 0, skippedAlreadyPresent: 0, skippedNonString: 0 };
  }
  const fingerprint = cleanSuffix.slice(0, SUFFIX_FINGERPRINT_CHARS);

  let attachedCount = 0;
  let skippedAlreadyPresent = 0;
  let skippedNonString = 0;

  for (const row of rows) {
    // Bracket access via the interface's `[key: string]: unknown` index
    // signature — `ai_image_prompt` isn't declared on the type but every
    // real production-doc row carries it.
    const bag = row as Record<string, unknown>;
    const value = bag.ai_image_prompt;
    if (typeof value !== 'string') {
      if (value !== undefined && value !== null) skippedNonString += 1;
      continue;
    }
    const body = value.trim();
    if (!body) continue;
    if (body.includes(fingerprint)) {
      skippedAlreadyPresent += 1;
      continue;
    }
    const stripped = body.replace(/[.\s]+$/, '');
    bag.ai_image_prompt = `${stripped}. ${cleanSuffix}`;
    attachedCount += 1;
  }

  return { rows, attachedCount, skippedAlreadyPresent, skippedNonString };
}
