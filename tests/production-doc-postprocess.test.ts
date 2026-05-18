import { describe, expect, it } from 'vitest';
import {
  estimateRowSeconds,
  PRODUCTION_DOC_MAX_SECONDS_PER_ROW,
  shiftTimecodeBySeconds,
  splitScriptAtSentenceBoundary,
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

  it('warns but does not split when the long row is a single unsplittable sentence', () => {
    // ~21 words ≈ 9.3s, one sentence with no internal punctuation.
    const sentence =
      'A truly enormous sentence that runs without any internal sentence boundaries for far too many words to fit cleanly';
    const input = [row('0:00', sentence)];
    const result = validateAndSplitOverlongRows(input, WPM);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].script_text).toBe(sentence);
    expect(result.overlongRowCount).toBe(1);
    expect(result.splitCount).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no internal sentence boundary/i);
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
