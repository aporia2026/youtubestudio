import { describe, expect, it } from 'vitest';
import {
  attachStyleSuffixToRows,
  dedupVariantIndexCollisions,
  estimateRowSeconds,
  PRODUCTION_DOC_MAX_SECONDS_PER_ROW,
  shiftTimecodeBySeconds,
  splitScriptAtAnyBoundary,
  splitScriptAtClauseBoundary,
  splitScriptAtSentenceBoundary,
  splitScriptAtWordBoundary,
  validateAndSplitOverlongRows,
} from '@/lib/production-doc-postprocess';

const WPM = 135;

function row(timecode: string, script_text: string, visual_type = 'B-Roll') {
  return {
    timecode,
    script_text,
    visual_type,
    visual_description: `desc-${timecode}`,
    ai_image_prompt: `prompt-${timecode}`,
  };
}

describe('estimateRowSeconds', () => {
  it('returns 0 for empty text', () => {
    expect(estimateRowSeconds('', WPM)).toBe(0);
    expect(estimateRowSeconds('   ', WPM)).toBe(0);
  });

  it('matches the prompt formula (wordCount / wpm * 60)', () => {
    // 27 words at 135 wpm = 12 seconds
    const text = Array.from({ length: 27 }, (_, i) => `word${i}`).join(' ');
    expect(estimateRowSeconds(text, 135)).toBeCloseTo(12, 5);
  });
});

describe('splitScriptAtSentenceBoundary', () => {
  it('splits at sentence boundary closest to the middle', () => {
    const text = 'First sentence here. Second sentence in the middle. Third sentence at the end.';
    const split = splitScriptAtSentenceBoundary(text);
    expect(split).not.toBeNull();
    expect(split!.first).toBe('First sentence here. Second sentence in the middle.');
    expect(split!.second).toBe('Third sentence at the end.');
  });

  it('returns null for a single sentence with no internal boundary', () => {
    expect(
      splitScriptAtSentenceBoundary('This is one long sentence without any internal break point'),
    ).toBeNull();
  });

  it('handles question and exclamation marks as boundaries', () => {
    const text = 'What do we know? Almost nothing! But that is about to change today.';
    const split = splitScriptAtSentenceBoundary(text);
    expect(split).not.toBeNull();
    expect(split!.first).toMatch(/Almost nothing!$/);
  });

  it('does not split on "Dr." or decimals (boundary needs capital after)', () => {
    // "Dr. Smith" — the period is followed by capital S, BUT the regex
    // requires a space-separated capital — actually "Dr. Smith" DOES
    // match. Test instead a decimal which does not (followed by digit).
    const text = 'The pi value is 3.14 which we use everywhere in geometry.';
    expect(splitScriptAtSentenceBoundary(text)).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(splitScriptAtSentenceBoundary('   ')).toBeNull();
    expect(splitScriptAtSentenceBoundary('')).toBeNull();
  });
});

describe('splitScriptAtClauseBoundary — tier 2 of the cascade', () => {
  it('splits at a comma followed by whitespace + lowercase word', () => {
    const text = 'We arrived just before noon, but the gates were already locked tight.';
    const out = splitScriptAtClauseBoundary(text);
    expect(out).not.toBeNull();
    expect(out!.first.endsWith(',')).toBe(true);
    expect(out!.second.startsWith('but')).toBe(true);
  });

  it('splits at a coordinating conjunction surrounded by whitespace', () => {
    const text = 'The data looked clean and the experiments all ran to completion as designed.';
    const out = splitScriptAtClauseBoundary(text);
    expect(out).not.toBeNull();
    // Split lands BEFORE the conjunction so the second half opens with it.
    expect(out!.second.startsWith('and')).toBe(true);
  });

  it('splits at an em dash', () => {
    const text = 'We waited for the results — they took far longer than anyone had predicted.';
    const out = splitScriptAtClauseBoundary(text);
    expect(out).not.toBeNull();
    expect(out!.second.startsWith('—')).toBe(true);
  });

  it('does NOT split numeric literals like "1,000"', () => {
    expect(splitScriptAtClauseBoundary('The total came to 1,000 dollars exactly')).toBeNull();
  });

  it('does NOT split date forms like "December 25, 2023"', () => {
    // Comma followed by space + DIGIT — the regex requires a letter after.
    expect(splitScriptAtClauseBoundary('The launch happened on December 25, 2023')).toBeNull();
  });

  it('returns null when no comma/conjunction/dash exists', () => {
    expect(
      splitScriptAtClauseBoundary('Just one long uninterrupted clause with nothing to split on inside'),
    ).toBeNull();
  });

  it('picks the candidate closest to the midpoint when multiple exist', () => {
    const text = 'First clause, second clause, third clause, fourth clause finishes the sentence.';
    const out = splitScriptAtClauseBoundary(text);
    expect(out).not.toBeNull();
    // Text is 80 chars (midpoint 40); comma after "third clause," sits
    // at char 42 — closest to midpoint of the three internal commas.
    expect(out!.first).toMatch(/third clause,$/);
    expect(out!.second).toMatch(/^fourth clause/);
  });
});

describe('splitScriptAtWordBoundary — tier 3 of the cascade', () => {
  it('splits any multi-word string at the word boundary closest to the midpoint', () => {
    const text = 'one two three four five six seven eight nine ten';
    const out = splitScriptAtWordBoundary(text);
    expect(out).not.toBeNull();
    // Midpoint by chars; expect roughly half the words in each side.
    expect(out!.first.split(/\s+/).length).toBeGreaterThanOrEqual(4);
    expect(out!.second.split(/\s+/).length).toBeGreaterThanOrEqual(4);
  });

  it('returns null for a single-token input', () => {
    expect(splitScriptAtWordBoundary('SingleToken')).toBeNull();
    expect(splitScriptAtWordBoundary('   indented   ')).toBeNull();
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(splitScriptAtWordBoundary('')).toBeNull();
    expect(splitScriptAtWordBoundary('   ')).toBeNull();
  });

  it('always succeeds for >=2-word inputs even with weird punctuation', () => {
    // Slashes, numbers, all-caps — the splitter operates on whitespace only.
    expect(splitScriptAtWordBoundary('UNIT/1A 47% 2026 hello world')).not.toBeNull();
  });
});

describe('splitScriptAtAnyBoundary — the three-tier cascade', () => {
  it('prefers sentence boundary (tier 1) when present', () => {
    const text = 'First sentence here. Second sentence following on naturally.';
    const out = splitScriptAtAnyBoundary(text);
    expect(out).not.toBeNull();
    expect(out!.first.endsWith('.')).toBe(true);
    expect(out!.second.startsWith('Second')).toBe(true);
  });

  it('falls through to clause boundary (tier 2) when no sentence boundary', () => {
    const text = 'We waited for the results, but the verdict took much longer to land';
    const out = splitScriptAtAnyBoundary(text);
    expect(out).not.toBeNull();
    expect(out!.first.endsWith(',')).toBe(true);
    expect(out!.second.startsWith('but')).toBe(true);
  });

  it('falls through to word boundary (tier 3) when no punctuation at all', () => {
    const text = 'A truly enormous sentence that runs without any internal sentence boundaries';
    const out = splitScriptAtAnyBoundary(text);
    expect(out).not.toBeNull();
    expect(out!.first.length).toBeGreaterThan(0);
    expect(out!.second.length).toBeGreaterThan(0);
    // No punctuation was added; the join preserves the original tokens.
    expect((out!.first + ' ' + out!.second).split(/\s+/).length).toBe(text.split(/\s+/).length);
  });

  it('returns null only for a single token', () => {
    expect(splitScriptAtAnyBoundary('OneWord')).toBeNull();
    expect(splitScriptAtAnyBoundary('')).toBeNull();
  });
});

describe('shiftTimecodeBySeconds', () => {
  it('adds seconds and rolls over minutes', () => {
    expect(shiftTimecodeBySeconds('0:00', 6)).toBe('0:06');
    expect(shiftTimecodeBySeconds('0:55', 10)).toBe('1:05');
    expect(shiftTimecodeBySeconds('2:30', 45.5)).toBe('3:16');
  });

  it('returns input unchanged when the timecode is malformed', () => {
    expect(shiftTimecodeBySeconds('not-a-timecode', 5)).toBe('not-a-timecode');
  });

  it('clamps negative results to 0:00', () => {
    expect(shiftTimecodeBySeconds('0:03', -10)).toBe('0:00');
  });
});

describe('validateAndSplitOverlongRows', () => {
  it('leaves short rows untouched', () => {
    const input = [
      row('0:00', 'A quick first scene.'),
      row('0:03', 'A second scene that is also short.'),
    ];
    const result = validateAndSplitOverlongRows(input, WPM);
    expect(result.rows).toHaveLength(2);
    expect(result.overlongRowCount).toBe(0);
    expect(result.splitCount).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('splits a row whose narration exceeds the 7s cap on a sentence boundary', () => {
    // ~27 words at 135 wpm = 12s. Two sentences so it has a split point.
    const longText =
      'When we first opened the cabinet we expected to find dust and old paper instead. ' +
      'But what we actually pulled out of the back changed how the team thought about the year ahead.';
    const input = [row('0:00', longText)];
    const result = validateAndSplitOverlongRows(input, WPM);

    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.overlongRowCount).toBe(1);
    expect(result.splitCount).toBeGreaterThanOrEqual(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/0:00/);
    expect(result.warnings[0]).toMatch(/split/i);

    // First split row keeps the original timecode.
    expect(result.rows[0].timecode).toBe('0:00');
    // Second split row's timecode is later than 0:00.
    expect(result.rows[1].timecode).not.toBe('0:00');
    // Both rows carry the source row's visual fields (duplicate-shot
    // warning to the editor is intentional).
    expect(result.rows[0].visual_description).toBe('desc-0:00');
    expect(result.rows[1].visual_description).toBe('desc-0:00');
  });

  it('splits a long no-punctuation sentence at a word boundary (cascade tier 3)', () => {
    // ~21 words ≈ 9.3s, one sentence with no internal punctuation. The
    // three-tier cascade falls through to word-boundary splitting, so
    // this case now produces a clean split rather than a freeze warning.
    const sentence =
      'A truly enormous sentence that runs without any internal sentence boundaries for far too many words to fit cleanly';
    const input = [row('0:00', sentence)];
    const result = validateAndSplitOverlongRows(input, WPM);

    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.overlongRowCount).toBe(1);
    expect(result.splitCount).toBeGreaterThanOrEqual(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/split into/i);
    // No "freeze last frame" wording any more for word-boundary splits.
    expect(result.warnings[0]).not.toMatch(/freeze the last frame/i);
  });

  it('only emits the single-token freeze warning when the row is literally one word', () => {
    // A single token that somehow exceeds the cap is the only case the
    // cascade can\'t split. Realistically this never happens (one word
    // is well under 7s at any wpm) — pin the behavior by forcing a
    // 0.5s cap so a 3-word row triggers the unsplittable branch when
    // it\'s reduced to one token.
    const input = [row('0:00', 'Antidisestablishmentarianism')];
    const result = validateAndSplitOverlongRows(input, WPM, { maxSecondsPerRow: 0.01 });
    expect(result.overlongRowCount).toBe(1);
    expect(result.splitCount).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/single unbroken token/i);
  });

  it('does not split Title Card rows even if they exceed the cap', () => {
    // Title cards are by definition short, but if the LLM produces one
    // that's somehow long, we still skip it — the renderer handles
    // title cards as fixed-duration scenes.
    const titleCard = row(
      '0:00',
      'The Long Heading That Should Never Have Been This Many Words Honestly What Was The Model Thinking',
      'Title Card',
    );
    const result = validateAndSplitOverlongRows([titleCard], WPM);
    expect(result.rows).toHaveLength(1);
    expect(result.overlongRowCount).toBe(0);
  });

  it('respects a custom maxSecondsPerRow option', () => {
    const text =
      'Sentence one is here. Sentence two follows right after. Sentence three closes things out cleanly.';
    // At 4s cap, even this fairly short row triggers a split.
    const result = validateAndSplitOverlongRows([row('0:00', text)], WPM, {
      maxSecondsPerRow: 4,
    });
    expect(result.overlongRowCount).toBe(1);
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('handles multiple overlong rows in one doc', () => {
    const long1 =
      'When we first opened the cabinet we expected dust and old paper instead. ' +
      'But what we pulled out of the back changed how the team thought about everything.';
    const long2 =
      'The second scene starts with something familiar and easy to recognise on screen. ' +
      'Then it pivots hard into a totally unexpected reveal that needs its own visual moment to land.';
    const input = [
      row('0:00', long1),
      row('0:12', 'A short bridge scene.'),
      row('0:15', long2),
    ];
    const result = validateAndSplitOverlongRows(input, WPM);
    expect(result.overlongRowCount).toBe(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.rows.length).toBeGreaterThanOrEqual(5);
  });

  it('exports the cap constant matching the prompt rule', () => {
    expect(PRODUCTION_DOC_MAX_SECONDS_PER_ROW).toBe(7.0);
  });
});

// ---------------------------------------------------------------------------
// attachStyleSuffixToRows — server-side suffix attachment.
// Replaces the legacy "LLM copies the 377-word suffix into every row" path
// that caused GPT-mini truncations on long doodle-style scripts. See plan
// `_plans/2026-05-26-production-doc-suffix-server-side.md`.
// ---------------------------------------------------------------------------

const DOODLE_SUFFIX =
  'extremely minimalist stick figure cartoon in the style of a child\'s freehand drawing, ' +
  'thin uneven hand-drawn black ink lines on plain pure white background';

describe('attachStyleSuffixToRows', () => {
  function brollRow(prompt: string) {
    return {
      timecode: '0:00',
      script_text: 'narration here',
      visual_type: 'B-Roll',
      visual_description: 'desc',
      ai_image_prompt: prompt,
    };
  }

  it('appends the suffix to a non-empty ai_image_prompt', () => {
    const rows = [brollRow('A stick figure waving at the camera, plain white background')];
    const out = attachStyleSuffixToRows(rows, DOODLE_SUFFIX);
    expect(out.attachedCount).toBe(1);
    expect(out.rows[0].ai_image_prompt).toBe(
      'A stick figure waving at the camera, plain white background. ' + DOODLE_SUFFIX,
    );
  });

  it('strips the body\'s trailing period and joins with ". "', () => {
    const rows = [brollRow('Two characters seated at a desk.')];
    const out = attachStyleSuffixToRows(rows, DOODLE_SUFFIX);
    // Body keeps its single period (we strip and re-add via joiner).
    expect(out.rows[0].ai_image_prompt).toBe('Two characters seated at a desk. ' + DOODLE_SUFFIX);
  });

  it('leaves empty ai_image_prompt rows alone (Title Card / Talking Head / Screen Recording)', () => {
    const rows = [
      { ...brollRow(''), visual_type: 'Title Card' },
      { ...brollRow(''), visual_type: 'Talking Head' },
      { ...brollRow('Real scene body'), visual_type: 'B-Roll' },
    ];
    const out = attachStyleSuffixToRows(rows, DOODLE_SUFFIX);
    expect(out.attachedCount).toBe(1);
    expect(out.rows[0].ai_image_prompt).toBe('');
    expect(out.rows[1].ai_image_prompt).toBe('');
    expect(out.rows[2].ai_image_prompt).toBe('Real scene body. ' + DOODLE_SUFFIX);
  });

  it('is idempotent — skips rows whose body already contains the suffix fingerprint', () => {
    const already = 'A stick figure waving. ' + DOODLE_SUFFIX;
    const rows = [brollRow(already)];
    const out = attachStyleSuffixToRows(rows, DOODLE_SUFFIX);
    expect(out.attachedCount).toBe(0);
    expect(out.skippedAlreadyPresent).toBe(1);
    expect(out.rows[0].ai_image_prompt).toBe(already);
  });

  it('idempotency catches LLMs that wrote only the suffix prefix', () => {
    // Even if the LLM produced just the first ~100 chars of the suffix, we
    // detect it and don\'t append (prevents double-suffixing).
    const partial = 'Scene body here. ' + DOODLE_SUFFIX.slice(0, 100);
    const rows = [brollRow(partial)];
    const out = attachStyleSuffixToRows(rows, DOODLE_SUFFIX);
    expect(out.skippedAlreadyPresent).toBe(1);
    expect(out.rows[0].ai_image_prompt).toBe(partial);
  });

  it('null or empty suffix is a no-op pass-through', () => {
    const rows = [brollRow('Scene body')];
    const out1 = attachStyleSuffixToRows(rows, null);
    expect(out1.attachedCount).toBe(0);
    expect(out1.rows[0].ai_image_prompt).toBe('Scene body');
    const out2 = attachStyleSuffixToRows(rows, '');
    expect(out2.attachedCount).toBe(0);
    const out3 = attachStyleSuffixToRows(rows, '   ');
    expect(out3.attachedCount).toBe(0);
  });

  it('mutates rows in place and returns the same array reference', () => {
    const rows = [brollRow('Scene body')];
    const out = attachStyleSuffixToRows(rows, DOODLE_SUFFIX);
    expect(out.rows).toBe(rows);
    expect(rows[0].ai_image_prompt).toContain(DOODLE_SUFFIX);
  });

  it('processes a mixed batch correctly', () => {
    const rows = [
      brollRow('Body A'),
      { ...brollRow(''), visual_type: 'Title Card' },
      brollRow('Body C with trailing space.   '),
      brollRow('Body D. ' + DOODLE_SUFFIX), // already attached
    ];
    const out = attachStyleSuffixToRows(rows, DOODLE_SUFFIX);
    expect(out.attachedCount).toBe(2);
    expect(out.skippedAlreadyPresent).toBe(1);
    expect(out.rows[0].ai_image_prompt).toBe('Body A. ' + DOODLE_SUFFIX);
    expect(out.rows[1].ai_image_prompt).toBe('');
    expect(out.rows[2].ai_image_prompt).toBe('Body C with trailing space. ' + DOODLE_SUFFIX);
    expect(out.rows[3].ai_image_prompt).toBe('Body D. ' + DOODLE_SUFFIX);
  });
});

// ─── Phase 1.6 (Bug 3) — variant-index collision dedup ───────────────────────
//
// QA on Sodder doc b30b8d1e found rows 5+6 both claiming
// `group_id = "sodder-fire-1"` AND `variant_index = 1` AND the same
// `variant_edit_prompt`. Spec:
// _plans/2026-05-28-doodle-2-phase-1-6-completion.md (R-3).

interface DedupRow {
  timecode: string;
  script_text: string;
  visual_type?: string;
  ai_image_prompt?: string;
  variant_edit_prompt?: string;
  group_id?: string;
  variant_index?: number;
  [key: string]: unknown;
}

function variantRow(opts: {
  tc: string;
  script?: string;
  vtype?: string;
  prompt?: string;
  editPrompt?: string;
  groupId?: string;
  variantIndex?: number;
}): DedupRow {
  return {
    timecode: opts.tc,
    script_text: opts.script ?? `script-${opts.tc}`,
    visual_type: opts.vtype ?? 'Animation',
    ai_image_prompt: opts.prompt ?? '',
    variant_edit_prompt: opts.editPrompt ?? '',
    group_id: opts.groupId,
    variant_index: opts.variantIndex,
  };
}

describe('dedupVariantIndexCollisions', () => {
  it('drops the duplicate when two rows share group_id + variant_index + identical content', () => {
    const rows: DedupRow[] = [
      variantRow({ tc: '0:00', groupId: 'g1', variantIndex: 0, prompt: 'base scene' }),
      variantRow({ tc: '0:05', groupId: 'g1', variantIndex: 1, editPrompt: 'add a hat' }),
      variantRow({ tc: '0:10', groupId: 'g1', variantIndex: 1, editPrompt: 'add a hat' }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.collisionsResolved).toBe(1);
    expect(out.duplicatesDropped).toBe(1);
    expect(out.renumbered).toBe(0);
    expect(out.basesRecovered).toBe(0);
    expect(out.rows).toHaveLength(2);
    // The first occurrence (0:05) survives; the duplicate at 0:10 drops.
    expect(out.rows[1].timecode).toBe('0:05');
  });

  it('renumbers the later row when collision rows have DIFFERENT content', () => {
    const rows: DedupRow[] = [
      variantRow({ tc: '0:00', groupId: 'g1', variantIndex: 0, prompt: 'base scene' }),
      variantRow({ tc: '0:05', groupId: 'g1', variantIndex: 1, editPrompt: 'add a hat' }),
      variantRow({ tc: '0:10', groupId: 'g1', variantIndex: 1, editPrompt: 'open the mouth' }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.collisionsResolved).toBe(1);
    expect(out.duplicatesDropped).toBe(0);
    expect(out.renumbered).toBe(1);
    expect(out.rows).toHaveLength(3);
    // First occurrence keeps index 1; the colliding row gets renumbered to 2.
    expect(out.rows[1].variant_index).toBe(1);
    expect(out.rows[2].variant_index).toBe(2);
  });

  it('renumbers around already-used indices instead of repeating them', () => {
    const rows: DedupRow[] = [
      variantRow({ tc: '0:00', groupId: 'g1', variantIndex: 0, prompt: 'base' }),
      variantRow({ tc: '0:05', groupId: 'g1', variantIndex: 1, editPrompt: 'A' }),
      variantRow({ tc: '0:10', groupId: 'g1', variantIndex: 2, editPrompt: 'B' }),
      // Collides with variant_index=1 from row 1; needs index 3, not 1 or 2.
      variantRow({ tc: '0:15', groupId: 'g1', variantIndex: 1, editPrompt: 'C' }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.collisionsResolved).toBe(1);
    expect(out.renumbered).toBe(1);
    expect(out.rows[3].variant_index).toBe(3);
  });

  it('leaves a well-formed group untouched (idempotent on clean input)', () => {
    const rows: DedupRow[] = [
      variantRow({ tc: '0:00', groupId: 'g1', variantIndex: 0, prompt: 'base' }),
      variantRow({ tc: '0:05', groupId: 'g1', variantIndex: 1, editPrompt: 'A' }),
      variantRow({ tc: '0:10', groupId: 'g1', variantIndex: 2, editPrompt: 'B' }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.collisionsResolved).toBe(0);
    expect(out.duplicatesDropped).toBe(0);
    expect(out.renumbered).toBe(0);
    expect(out.basesRecovered).toBe(0);
    expect(out.warnings).toHaveLength(0);
    expect(out.rows).toBe(rows); // Same reference — no drops.
  });

  it('recovers a missing base by promoting a fresh preceding row', () => {
    const rows: DedupRow[] = [
      // Plain fresh row immediately before the orphan variants.
      variantRow({ tc: '0:00', prompt: 'a wide shot of the house' }),
      variantRow({ tc: '0:05', groupId: 'g1', variantIndex: 1, editPrompt: 'add a hat' }),
      variantRow({ tc: '0:10', groupId: 'g1', variantIndex: 2, editPrompt: 'open the mouth' }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.basesRecovered).toBe(1);
    expect(out.rows).toHaveLength(3);
    // Row 0 is now the base of g1.
    expect(out.rows[0].group_id).toBe('g1');
    expect(out.rows[0].variant_index).toBe(0);
    expect(out.warnings).toHaveLength(0);
  });

  it('warns instead of recovering when the preceding row already belongs to another group', () => {
    const rows: DedupRow[] = [
      variantRow({ tc: '0:00', groupId: 'g0', variantIndex: 0, prompt: 'group 0 base' }),
      variantRow({ tc: '0:05', groupId: 'g1', variantIndex: 1, editPrompt: 'add a hat' }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.basesRecovered).toBe(0);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('"g1"');
    expect(out.warnings[0]).toContain('preceding row already belongs to another group');
  });

  it('warns when an orphan group sits at the start of the doc with no row to promote', () => {
    const rows: DedupRow[] = [
      variantRow({ tc: '0:00', groupId: 'g1', variantIndex: 1, editPrompt: 'add a hat' }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.basesRecovered).toBe(0);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('"g1"');
    expect(out.warnings[0]).toContain("doc's first row");
  });

  it('ignores standalone rows (no group_id)', () => {
    const rows: DedupRow[] = [
      variantRow({ tc: '0:00', prompt: 'scene 1' }),
      variantRow({ tc: '0:05', prompt: 'scene 2' }),
      variantRow({ tc: '0:10', prompt: 'scene 3' }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.collisionsResolved).toBe(0);
    expect(out.rows).toBe(rows);
  });

  it('reproduces the exact Sodder doc b30b8d1e collision pattern', () => {
    // Row 2 (base) + rows 5 and 6 (variant_index=1 colliding, same edit prompt).
    // The diag output shape from scripts/diag-sodder-styleid.ts.
    const rows: DedupRow[] = [
      variantRow({
        tc: '0:06',
        groupId: 'sodder-fire-1',
        variantIndex: 0,
        prompt: 'Same house composition, now with orange flames bursting from the roof and windows, smoke rising hard.',
      }),
      variantRow({
        tc: '0:15',
        groupId: 'sodder-fire-1',
        variantIndex: 1,
        editPrompt: 'remove the escaping family from the foreground and make the upstairs window feel empty and tragic, keep…',
      }),
      variantRow({
        tc: '0:19',
        groupId: 'sodder-fire-1',
        variantIndex: 1,
        editPrompt: 'remove the escaping family from the foreground and make the upstairs window feel empty and tragic, keep…',
      }),
    ];
    const out = dedupVariantIndexCollisions(rows);
    expect(out.duplicatesDropped).toBe(1);
    expect(out.collisionsResolved).toBe(1);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.timecode)).toEqual(['0:06', '0:15']);
  });
});
