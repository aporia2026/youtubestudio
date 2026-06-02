/**
 * Tests for `src/lib/auto-pipeline/post-process-pacing.ts`.
 *
 * This is the deterministic enforcement layer for the opening-hook
 * directive. LLMs follow the directive ~70% of the time; this module
 * splits long opening rows the other 30%. A bug here means the user
 * still sees slow opens after PR3 ships — exactly the complaint that
 * drove the plan.
 *
 * Coverage:
 *   - parseTimecodeRange (every accepted clock format + malformed cases)
 *   - splitRowByMidpoint (sentence-boundary preference, proportional
 *     time split, min-duration refusal, attempts/last_error reset)
 *   - isStandaloneStaticBase (every disqualifying field)
 *   - applyPacingPostProcess profile branching (standard pass-through,
 *     fast/very_fast row splitting, opening detection, diagnostics)
 */

import { describe, it, expect } from 'vitest';
import {
  applyPacingPostProcess,
  parseTimecodeRange,
  splitRowByMidpoint,
  isStandaloneStaticBase,
} from '../src/lib/auto-pipeline/post-process-pacing';
import type { ProductionDoc, ProductionRow } from '../src/remotion/utils';

// ─── Helpers ─────────────────────────────────────────────────────────

function row(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '00:00 - 00:04',
    script_text: 'Default script text here for the row.',
    visual_type: 'B-Roll',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...overrides,
  };
}

function doc(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    title: 'T',
    niche: 'tech',
    total_duration: '00:30',
    total_words: 60,
    speaking_pace_wpm: 135,
    rows: [],
    ...overrides,
  };
}

// ─── parseTimecodeRange ─────────────────────────────────────────────

describe('parseTimecodeRange', () => {
  it('parses the canonical MM:SS - MM:SS shape', () => {
    expect(parseTimecodeRange('00:00 - 00:04')).toEqual({ startSec: 0, endSec: 4 });
    expect(parseTimecodeRange('01:30 - 02:15')).toEqual({ startSec: 90, endSec: 135 });
  });

  it('tolerates the single-digit minute shape (0:00 - 0:05)', () => {
    expect(parseTimecodeRange('0:00 - 0:05')).toEqual({ startSec: 0, endSec: 5 });
    expect(parseTimecodeRange('1:30 - 2:15')).toEqual({ startSec: 90, endSec: 135 });
  });

  it('accepts the H:MM:SS form for long videos', () => {
    expect(parseTimecodeRange('1:00:00 - 1:00:10')).toEqual({ startSec: 3600, endSec: 3610 });
  });

  it('accepts an em-dash separator', () => {
    expect(parseTimecodeRange('00:00 – 00:05')).toEqual({ startSec: 0, endSec: 5 });
    expect(parseTimecodeRange('00:00 — 00:05')).toEqual({ startSec: 0, endSec: 5 });
  });

  it('accepts a pure-seconds shape (defensive — should rarely happen)', () => {
    expect(parseTimecodeRange('12 - 18')).toEqual({ startSec: 12, endSec: 18 });
  });

  it('rejects malformed shapes', () => {
    expect(parseTimecodeRange('foo')).toBeNull();
    expect(parseTimecodeRange('00:00')).toBeNull();
    expect(parseTimecodeRange('-1:00 - 0:05')).toBeNull(); // negative seconds
    expect(parseTimecodeRange('00:05 - 00:00')).toBeNull(); // end < start
    expect(parseTimecodeRange(undefined)).toBeNull();
    expect(parseTimecodeRange('')).toBeNull();
  });
});

// ─── isStandaloneStaticBase ─────────────────────────────────────────

describe('isStandaloneStaticBase', () => {
  it('returns true for a plain B-Roll row with no motion / overlay / title', () => {
    expect(isStandaloneStaticBase(row())).toBe(true);
  });

  it('rejects variants (variant_index > 0)', () => {
    expect(isStandaloneStaticBase(row({ variant_index: 1 }))).toBe(false);
  });

  it('rejects motion + motion_collage shot_kind', () => {
    expect(isStandaloneStaticBase(row({ shot_kind: 'motion' }))).toBe(false);
    expect(isStandaloneStaticBase(row({ shot_kind: 'motion_collage' }))).toBe(false);
  });

  it('accepts shot_kind=static (the explicit "still" mark)', () => {
    expect(isStandaloneStaticBase(row({ shot_kind: 'static' }))).toBe(true);
  });

  it('rejects rows with motion_beats', () => {
    expect(
      isStandaloneStaticBase(
        row({ motion_beats: [{ kind: 'label_pop', startMs: 0, durationMs: 200 }] }),
      ),
    ).toBe(false);
  });

  it('rejects rows with an overlay stock term', () => {
    expect(isStandaloneStaticBase(row({ overlay_stock_terms: 'rocket launch' }))).toBe(false);
  });

  it('rejects rows with a section title', () => {
    expect(isStandaloneStaticBase(row({ section_title: 'Chapter One' }))).toBe(false);
  });
});

// ─── splitRowByMidpoint ─────────────────────────────────────────────

describe('splitRowByMidpoint', () => {
  it('splits a 12-word row at the word-count midpoint', () => {
    const r = row({
      script_text: 'one two three four five six seven eight nine ten eleven twelve',
      attempts: 3,
      last_error: { class: 'timeout', message: 'old failure', at: '2026-06-03T00:00:00Z' },
    });
    const result = splitRowByMidpoint(r, 0, 4);
    expect(result).not.toBeNull();
    const [a, b] = result!;
    expect(a.script_text.split(' ')).toHaveLength(6);
    expect(b.script_text.split(' ')).toHaveLength(6);
    // attempts + last_error reset on split — new rows are not retries.
    expect(a.attempts).toBe(0);
    expect(a.last_error).toBeNull();
    expect(b.attempts).toBe(0);
    expect(b.last_error).toBeNull();
  });

  it('prefers a sentence boundary near the midpoint when one exists', () => {
    const r = row({
      script_text: 'one two three. four five six seven eight nine ten eleven twelve',
    });
    const result = splitRowByMidpoint(r, 0, 5);
    expect(result).not.toBeNull();
    const [a] = result!;
    // The period after "three" is just within the ±25% window. The
    // splitter should land on it rather than the strict word midpoint.
    expect(a.script_text).toBe('one two three.');
  });

  it('proportionally splits time when the split is uneven', () => {
    const r = row({
      script_text: 'one two three four five six seven eight nine ten',
    });
    // Force a non-50/50 split by using punctuation: "one two three. four five six seven eight nine ten"
    // would split 3/7 with sentence preference.
    const r2 = row({
      script_text: 'one two three. four five six seven eight nine ten',
    });
    const result = splitRowByMidpoint(r2, 0, 10);
    expect(result).not.toBeNull();
    const [a, b] = result!;
    // 3 words / 10 total → 3 s for first, 7 s for second.
    const aRange = parseTimecodeRange(a.timecode)!;
    const bRange = parseTimecodeRange(b.timecode)!;
    expect(aRange.endSec - aRange.startSec).toBe(3);
    expect(bRange.endSec - bRange.startSec).toBe(7);
    // Continuous: b starts where a ends.
    expect(bRange.startSec).toBe(aRange.endSec);
    void result;
  });

  it('refuses to split when either half would fall below 1 s', () => {
    const r = row({ script_text: 'one two three four', timecode: '00:00 - 00:01' });
    // Splitting a 1 s row at the midpoint gives 0.5 s halves — under
    // the MIN_SPLIT_ROW_SECONDS floor.
    expect(splitRowByMidpoint(r, 0, 1)).toBeNull();
  });

  it('refuses to split a row with fewer than 4 words', () => {
    expect(splitRowByMidpoint(row({ script_text: 'one two three' }), 0, 4)).toBeNull();
    expect(splitRowByMidpoint(row({ script_text: '' }), 0, 4)).toBeNull();
  });

  it('inherits visual fields on both halves', () => {
    const r = row({
      script_text: 'one two three four five six seven eight',
      ai_image_prompt: 'shared prompt',
      visual_description: 'shared scene',
      visual_type: 'Animation',
      group_id: 'g1',
    });
    const result = splitRowByMidpoint(r, 0, 4);
    expect(result).not.toBeNull();
    const [a, b] = result!;
    expect(a.ai_image_prompt).toBe('shared prompt');
    expect(a.visual_description).toBe('shared scene');
    expect(a.visual_type).toBe('Animation');
    expect(a.group_id).toBe('g1');
    expect(b.ai_image_prompt).toBe('shared prompt');
    expect(b.visual_description).toBe('shared scene');
    expect(b.visual_type).toBe('Animation');
    expect(b.group_id).toBe('g1');
  });
});

// ─── applyPacingPostProcess ─────────────────────────────────────────

describe('applyPacingPostProcess', () => {
  it('is a no-op for pacing_profile=standard', () => {
    const input = doc({
      pacing_profile: 'standard',
      rows: [
        row({ timecode: '00:00 - 00:08', script_text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen' }),
      ],
    });
    const result = applyPacingPostProcess(input);
    expect(result.doc.rows).toBe(input.rows);
    expect(result.diagnostics.profile).toBe('standard');
    expect(result.diagnostics.openingRowsSplit).toBe(0);
  });

  it('is a no-op for undefined pacing_profile (legacy doc, treated as standard)', () => {
    const input = doc({
      rows: [
        row({ timecode: '00:00 - 00:08', script_text: 'one two three four five six seven eight nine ten' }),
      ],
    });
    const result = applyPacingPostProcess(input);
    expect(result.diagnostics.profile).toBe('standard');
    expect(result.diagnostics.openingRowsSplit).toBe(0);
  });

  it('splits opening rows over 2.5 s on the fast profile', () => {
    const input = doc({
      pacing_profile: 'fast',
      rows: [
        row({
          timecode: '00:00 - 00:06',
          script_text:
            'The Stuxnet worm appeared in 2010 and shocked engineers worldwide with its precision',
        }),
        row({
          timecode: '00:06 - 00:10',
          script_text: 'Five more words five more words',
        }),
      ],
    });
    const result = applyPacingPostProcess(input);
    // First row over 2.5 s → split into two.
    // Second row over 2.5 s AND startSec === 6 (inside the 12 s window) → also split.
    expect(result.diagnostics.openingRowsExamined).toBe(2);
    expect(result.diagnostics.openingRowsSplit).toBeGreaterThanOrEqual(1);
    expect(result.doc.rows.length).toBeGreaterThan(input.rows.length);
  });

  it('leaves rows past the 12 s hook window untouched', () => {
    const input = doc({
      pacing_profile: 'fast',
      rows: [
        row({ timecode: '00:00 - 00:02', script_text: 'short row keeps fine' }),
        row({
          timecode: '00:13 - 00:20',
          script_text: 'past the hook, the rule does not apply, leave this alone',
        }),
      ],
    });
    const result = applyPacingPostProcess(input);
    // Only the first row is examined (startSec < 12). The second is past the window.
    expect(result.diagnostics.openingRowsExamined).toBe(1);
    expect(result.diagnostics.openingRowsSplit).toBe(0);
    expect(result.doc.rows).toHaveLength(2);
  });

  it('detects a standalone-static-base opening row in diagnostics', () => {
    const input = doc({
      pacing_profile: 'fast',
      rows: [
        row({ timecode: '00:00 - 00:02', script_text: 'short opener line here' }),
      ],
    });
    const result = applyPacingPostProcess(input);
    expect(result.diagnostics.openingFirstRowIsStaticBase).toBe(true);
  });

  it('does NOT flag standalone-static-base when first row has a section title', () => {
    const input = doc({
      pacing_profile: 'fast',
      rows: [
        row({
          timecode: '00:00 - 00:02',
          script_text: 'short opener line here',
          section_title: 'Chapter One',
        }),
      ],
    });
    const result = applyPacingPostProcess(input);
    expect(result.diagnostics.openingFirstRowIsStaticBase).toBe(false);
  });

  it('preserves row order after splitting', () => {
    const input = doc({
      pacing_profile: 'fast',
      rows: [
        row({ timecode: '00:00 - 00:05', script_text: 'first one two three four five six seven eight' }),
        row({ timecode: '00:15 - 00:20', script_text: 'second past the hook window' }),
      ],
    });
    const result = applyPacingPostProcess(input);
    // First row got split, second stays. Order preserved.
    expect(result.doc.rows.length).toBeGreaterThan(2);
    expect(result.doc.rows[result.doc.rows.length - 1].script_text).toMatch(/second past/);
  });

  it('leaves rows with malformed timecodes untouched', () => {
    const input = doc({
      pacing_profile: 'fast',
      rows: [
        row({ timecode: 'garbage timecode here', script_text: 'one two three four five six seven eight' }),
      ],
    });
    const result = applyPacingPostProcess(input);
    expect(result.doc.rows).toHaveLength(1);
    expect(result.diagnostics.openingRowsSplit).toBe(0);
  });
});
