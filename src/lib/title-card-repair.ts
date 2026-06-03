// ---------------------------------------------------------------------------
// Deterministic Title Card repair.
//
// The production-doc prompt asks the LLM to emit one Title Card row per
// `<<TITLE_N>>` sentinel. Compliance is unreliable: a 7-title script can
// come back with 5 cards and 2 silently dropped, or with cards whose
// `script_text` paraphrases the heading past the punctuation-tolerant
// allowlist normalizer (and then gets demoted to Animation by the route's
// strict allowlist pass at route.ts:339-356).
//
// Before this module, the route's only response was a `generation_warnings`
// entry telling the user to add the missing card by hand. That broke the
// contract the pre-flight TitleReviewPanel implies — every detected title
// becomes a card. This module closes the gap deterministically: walk the
// emitted rows AND the sentinel offsets in script order, and insert a
// synthetic Title Card at the exact sentinel position for every expected
// title the LLM dropped.
//
// No LLM call. No retry. Same content shape as a model-emitted Title Card,
// so the renderer / suffix-attach pass / editor see no difference.
//
// See plan `_plans/2026-06-03-title-card-deterministic-repair.md`.
// ---------------------------------------------------------------------------

import type { ProductionDocRowLike } from './production-doc-postprocess';
import type { ExtractedTitle } from './script-titles';

/** Punctuation+whitespace+case tolerance used by both the demote pass and
 *  the repair pass. Two texts that normalize to the same string are treated
 *  as the same title; this absorbs the most common LLM paraphrases
 *  ("Knight Capital." vs the extracted "Knight Capital") without letting
 *  genuinely different text through. Exported so the route's emission
 *  validator can share the exact comparison rule and never disagree with
 *  this module about what counts as a match. */
export function normalizeTitleText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?]+$/, '')
    .replace(/\s+/g, ' ');
}

/** Number of leading characters of a non-TC row's script_text used to locate
 *  the row inside `strippedScript`. Long enough to be unique across most
 *  scripts, short enough to survive minor LLM whitespace fiddling. */
const ROW_OFFSET_SNIPPET_CHARS = 40;

export interface TitleCardRepairResult<R extends ProductionDocRowLike> {
  /** Rows after repair, in script order. Includes all originals plus any
   *  synthesized Title Card rows inserted at their correct positions. */
  rows: R[];
  /** Number of synthetic Title Card rows inserted. */
  insertedCount: number;
  /** Title texts that needed synthesis, in script order. Surfaced to the
   *  user via `generation_warnings` so the LLM misbehavior is visible. */
  insertedTitles: string[];
}

export interface RepairOptions {
  /** Whether the resolved style allows real-image overlays. Drives whether
   *  the synthetic row carries the overlay_* fields. Mirrors the prompt's
   *  schema gate at `prompts.ts:2412-2415`. */
  allowOverlay: boolean;
}

/**
 * Ensure every expected title has a Title Card row in `rows`, inserting
 * synthetic rows at script-accurate positions where the LLM dropped them.
 *
 * Algorithm:
 *
 *   1. For each expected title, find the offset of its `<<TITLE_N>>`
 *      sentinel in `strippedScript`. This is the authoritative position
 *      of the title in the source script.
 *
 *   2. For each non-Title-Card row, estimate its offset in `strippedScript`
 *      by running `indexOf` on a short prefix of its `script_text`. A
 *      running cursor enforces forward progress so the LLM can't trip the
 *      matcher with stale or repeated snippets.
 *
 *   3. Determine which expected titles were emitted by collecting the
 *      normalized text of every Title Card row in `rows`.
 *
 *   4. For each MISSING title, find the first non-TC row whose estimated
 *      offset is at or past the title's sentinel offset, and insert a
 *      synthetic Title Card row immediately before it. When no such row
 *      exists (the title's sentinel sits after every emitted row's
 *      content), append at the end.
 *
 * Title Card rows the LLM did emit are left exactly where they are in
 * the input — repair only adds missing rows, never reorders existing ones.
 */
export function repairMissingTitleCards<R extends ProductionDocRowLike>(
  rows: readonly R[],
  expectedTitles: readonly ExtractedTitle[],
  strippedScript: string,
  options: RepairOptions,
): TitleCardRepairResult<R> {
  // Fast path: nothing to repair against.
  if (expectedTitles.length === 0) {
    return { rows: [...rows], insertedCount: 0, insertedTitles: [] };
  }

  // ----- Step 1: sentinel offsets in stripped script -----
  // A sentinel that can't be located (-1) means the title was effectively
  // removed from the script — leave it alone, the user / overrides pass
  // already decided to drop it.
  const sentinelOffsets: number[] = expectedTitles.map((t) =>
    strippedScript.indexOf(t.sentinel),
  );

  // ----- Step 2: non-TC row offsets in stripped script -----
  // Cursor enforces forward progress. When `indexOf` fails for a snippet
  // (LLM paraphrased past recognition), the row inherits the cursor —
  // effectively keeping it in its current relative position without
  // advancing past unknown content.
  let cursor = 0;
  const rowOffsets: number[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.visual_type === 'Title Card') {
      // TCs don't need accurate offsets — they're never used as insertion
      // anchors. Park them at the current cursor so the array stays
      // index-aligned with `rows`.
      rowOffsets[i] = cursor;
      continue;
    }
    const text = typeof r.script_text === 'string' ? r.script_text.trim() : '';
    const snippet = text.slice(0, ROW_OFFSET_SNIPPET_CHARS);
    let offset = cursor;
    if (snippet) {
      const found = strippedScript.indexOf(snippet, cursor);
      if (found >= 0) {
        offset = found;
        cursor = found + snippet.length;
      }
    }
    rowOffsets[i] = offset;
  }

  // ----- Step 3: which titles did the LLM emit? -----
  const emittedNorm = new Set<string>();
  for (const r of rows) {
    if (r.visual_type === 'Title Card') {
      const s = typeof r.script_text === 'string' ? r.script_text : '';
      emittedNorm.add(normalizeTitleText(s));
    }
  }

  // ----- Step 4: build insertion ops keyed by row index -----
  // Each insertion: insert this synthetic title BEFORE the row at
  // `index`. `index === rows.length` means append at end. Multiple
  // insertions can land at the same index when several consecutive
  // titles all fall after every emitted row — they emit in expected-
  // title order (which is script order).
  const insertions: { index: number; title: ExtractedTitle }[] = [];
  expectedTitles.forEach((t, i) => {
    const norm = normalizeTitleText(t.text);
    if (emittedNorm.has(norm)) return;
    const sentinelOffset = sentinelOffsets[i];
    if (sentinelOffset < 0) return;

    // First NON-TC row whose offset is at or past the sentinel offset.
    // We anchor on non-TC rows specifically because TC rows have park-
    // at-cursor offsets that don't reflect script position.
    let insertIdx = rows.length;
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].visual_type === 'Title Card') continue;
      if (rowOffsets[r] >= sentinelOffset) {
        insertIdx = r;
        break;
      }
    }
    insertions.push({ index: insertIdx, title: t });
  });

  // Stable sort by index. `expectedTitles` is in script order, so two
  // insertions at the same index emit in script-order automatically.
  insertions.sort((a, b) => a.index - b.index);

  // ----- Step 5: weave insertions into the final row list -----
  const out: R[] = [];
  let nextIns = 0;
  for (let i = 0; i <= rows.length; i++) {
    while (nextIns < insertions.length && insertions[nextIns].index === i) {
      const t = insertions[nextIns].title;
      out.push(synthesizeTitleCardRow<R>(t.text, prevTimecode(out), options));
      nextIns += 1;
    }
    if (i < rows.length) out.push(rows[i]);
  }

  return {
    rows: out,
    insertedCount: insertions.length,
    insertedTitles: insertions.map((ins) => ins.title.text),
  };
}

// ---------------------------------------------------------------------------
// Composed normalize pass: demote non-allowlisted Title Cards, then repair
// missing ones. The route's strict-allowlist demoter catches Title Cards
// the LLM emitted with wrong text (a full sentence mistagged as a card, a
// `[SFX:]` cue, etc.) by checking each TC row's `script_text` against the
// set of expected title texts and downgrading the visual_type to
// "Animation" on mismatch. After that pass runs, the repair phase fills
// in any expected title the LLM dropped.
//
// Used by both `src/app/api/generate/production-doc/route.ts` and
// `src/lib/auto-pipeline/stages/generate-production-doc.ts` so both code
// paths produce identical Title Card sets for the same input.
// ---------------------------------------------------------------------------

export interface NormalizeTitleCardsResult<R extends ProductionDocRowLike> {
  /** Final rows after demotion + repair. */
  rows: R[];
  /** How many Title Card rows were demoted to Animation (LLM-mistagged). */
  demotedCount: number;
  /** Up to 4 `script_text` samples from demoted rows, for log readability. */
  demotedSamples: string[];
  /** How many synthetic Title Cards were inserted (LLM-dropped). */
  insertedCount: number;
  /** Title texts that needed synthesis, in script order. */
  insertedTitles: string[];
}

/** Apply the strict-allowlist demoter, then the repair pass. The two
 *  passes are deliberately ordered: demoting first prevents repair from
 *  treating an LLM mistagged-as-Title-Card row as a "match" for an
 *  expected title, which would leave the real title missing AND keep the
 *  bad row in place. */
export function normalizeTitleCards<R extends ProductionDocRowLike>(
  rows: readonly R[],
  expectedTitles: readonly ExtractedTitle[],
  strippedScript: string,
  options: RepairOptions,
): NormalizeTitleCardsResult<R> {
  // Step 1: demote. Build the allowlist of normalized title texts; any
  // Title Card row whose script_text doesn't normalize-match an entry
  // gets its visual_type rewritten to "Animation". Returns a new array
  // so the caller can pass `result.rows` (a readonly view) without
  // worrying about in-place mutation surprising downstream consumers.
  const allowedNorm = new Set(
    expectedTitles.map((t) => normalizeTitleText(t.text)),
  );
  const demotedSamples: string[] = [];
  const afterDemote: R[] = rows.map((r) => {
    if (r.visual_type !== 'Title Card') return r;
    const script = typeof r.script_text === 'string' ? r.script_text.trim() : '';
    if (!script) return r;
    if (allowedNorm.has(normalizeTitleText(script))) return r;
    demotedSamples.push(script);
    return { ...r, visual_type: 'Animation' } as R;
  });

  // Step 2: repair. The demoted-row pass left script_text untouched, so
  // the rows still anchor the repair's script-offset estimation
  // correctly — only the visual_type label changed.
  const repair = repairMissingTitleCards(
    afterDemote,
    expectedTitles,
    strippedScript,
    options,
  );

  return {
    rows: repair.rows,
    demotedCount: demotedSamples.length,
    demotedSamples: demotedSamples.slice(0, 4),
    insertedCount: repair.insertedCount,
    insertedTitles: repair.insertedTitles,
  };
}

/** Construct a Title Card row that satisfies the prompt's row contract
 *  (`prompts.ts:2319-2328`). The renderer reads `on_screen_text` for the
 *  typography; `ai_image_prompt` is intentionally empty (the route's
 *  `attachStyleSuffixToRows` skips empty prompts, so the synthetic row is
 *  byte-identical to a well-formed LLM-emitted card). */
function synthesizeTitleCardRow<R extends ProductionDocRowLike>(
  text: string,
  timecode: string,
  options: RepairOptions,
): R {
  const row: Record<string, unknown> = {
    timecode,
    script_text: text,
    visual_type: 'Title Card',
    visual_description: `Title card displaying "${text}"`,
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: text,
    notes: 'Title card scene — auto-inserted to match a detected `##` heading the model missed.',
  };
  if (options.allowOverlay) {
    row.overlay_stock_terms = '';
    row.overlay_zone = '';
    row.overlay_size = '';
  }
  return row as R;
}

/** Reuse the previous row's timecode as a placeholder. The editor recomputes
 *  timecodes during layout, so a precise value here is unnecessary — what
 *  matters is that the field is a non-empty string in the expected shape. */
function prevTimecode(emitted: readonly ProductionDocRowLike[]): string {
  if (emitted.length === 0) return '00:00';
  const prev = emitted[emitted.length - 1].timecode;
  return typeof prev === 'string' && prev.length > 0 ? prev : '00:00';
}
