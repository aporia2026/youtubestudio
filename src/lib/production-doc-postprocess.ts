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
      out.push(row);
      warnings.push(
        `Row at ${row.timecode} is ${seconds.toFixed(1)}s of narration but has no internal sentence boundary to split on. The animation will freeze the last frame after ${cap}s — consider rewriting this sentence in the script.`,
      );
    }
  }

  return { rows: out, warnings, overlongRowCount, splitCount };
}

/** Recursive splitter. Returns `{ kind: 'split', rows }` on success, or
 *  `{ kind: 'unsplittable' }` if the row has no usable sentence boundary
 *  and we've already passed the cap. */
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

  const split = splitScriptAtSentenceBoundary(row.script_text);
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
