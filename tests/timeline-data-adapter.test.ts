import { describe, expect, it } from 'vitest';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import {
  computeRowIntervals,
  docToTimelineRows,
  parseTimecodeDurationMs,
  rowDurationMs,
  rowIndexAtMs,
  totalDocDurationMs,
} from '@/components/timeline-editor/timeline-data-adapter';

function row(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '0:00-0:03',
    script_text: 'hello',
    visual_type: 'ai_image',
    visual_description: 'desc',
    stock_search_terms: '',
    ai_image_prompt: 'prompt',
    on_screen_text: '',
    notes: '',
    ...overrides,
  } as ProductionRow;
}

function makeDoc(rows: ProductionRow[]): ProductionDoc {
  return {
    title: 'Test',
    niche: 'test',
    total_duration: '0:30',
    total_words: 50,
    speaking_pace_wpm: 100,
    rows,
  } as ProductionDoc;
}

describe('parseTimecodeDurationMs', () => {
  it('parses 0:00-0:03 → 3000ms', () => {
    expect(parseTimecodeDurationMs('0:00-0:03')).toBe(3000);
  });

  it('parses 01:23-01:28 → 5000ms', () => {
    expect(parseTimecodeDurationMs('01:23-01:28')).toBe(5000);
  });

  it('returns null on malformed input', () => {
    expect(parseTimecodeDurationMs('not a timecode')).toBeNull();
    expect(parseTimecodeDurationMs(undefined)).toBeNull();
    expect(parseTimecodeDurationMs('0:00 - 0:03')).toBeNull(); // space
    expect(parseTimecodeDurationMs('')).toBeNull();
  });

  it('returns null when end ≤ start', () => {
    expect(parseTimecodeDurationMs('0:05-0:05')).toBeNull();
    expect(parseTimecodeDurationMs('0:10-0:05')).toBeNull();
  });
});

describe('rowDurationMs precedence', () => {
  it('prefers duration_override_ms', () => {
    expect(rowDurationMs(row({ duration_override_ms: 7000, timecode: '0:00-0:03' }))).toBe(7000);
  });

  it('falls back to timecode when no override', () => {
    expect(rowDurationMs(row({ timecode: '0:00-0:05' }))).toBe(5000);
  });

  it('defaults to 3000ms when neither is usable', () => {
    expect(rowDurationMs(row({ timecode: 'garbage' }))).toBe(3000);
  });

  it('rejects zero and negative overrides', () => {
    expect(rowDurationMs(row({ duration_override_ms: 0, timecode: '0:00-0:04' }))).toBe(4000);
    expect(rowDurationMs(row({ duration_override_ms: -100, timecode: '0:00-0:04' }))).toBe(4000);
  });
});

describe('computeRowIntervals', () => {
  it('walks rows cumulatively', () => {
    const doc = makeDoc([
      row({ timecode: '0:00-0:03' }),
      row({ timecode: '0:03-0:08' }),
      row({ timecode: '0:08-0:09' }),
    ]);
    const intervals = computeRowIntervals(doc);
    expect(intervals).toHaveLength(3);
    expect(intervals[0].startMs).toBe(0);
    expect(intervals[0].durationMs).toBe(3000);
    expect(intervals[1].startMs).toBe(3000);
    expect(intervals[1].durationMs).toBe(5000);
    expect(intervals[2].startMs).toBe(8000);
    expect(intervals[2].durationMs).toBe(1000);
  });

  it('respects duration_override_ms in the middle of the cascade', () => {
    const doc = makeDoc([
      row({ timecode: '0:00-0:03' }),                          // 3000ms
      row({ timecode: '0:03-0:08', duration_override_ms: 10000 }), // overridden to 10000ms
      row({ timecode: '0:08-0:09' }),                          // 1000ms
    ]);
    const intervals = computeRowIntervals(doc);
    expect(intervals[1].startMs).toBe(3000);
    expect(intervals[1].durationMs).toBe(10000);
    expect(intervals[2].startMs).toBe(13000);
    expect(intervals[2].durationMs).toBe(1000);
  });

  it('emits unique rowIds per index', () => {
    const doc = makeDoc([row(), row(), row()]);
    const ids = computeRowIntervals(doc).map((i) => i.rowId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('rowIndexAtMs', () => {
  const doc = makeDoc([
    row({ timecode: '0:00-0:03' }),
    row({ timecode: '0:03-0:08' }),
    row({ timecode: '0:08-0:09' }),
  ]);

  it('returns the row containing the supplied ms', () => {
    expect(rowIndexAtMs(doc, 0)).toBe(0);
    expect(rowIndexAtMs(doc, 1500)).toBe(0);
    expect(rowIndexAtMs(doc, 3000)).toBe(1); // start of row 2 (inclusive)
    expect(rowIndexAtMs(doc, 7999)).toBe(1);
    expect(rowIndexAtMs(doc, 8000)).toBe(2);
  });

  it('returns -1 before the first row and after the last', () => {
    expect(rowIndexAtMs(doc, -1)).toBe(-1);
    expect(rowIndexAtMs(doc, 9000)).toBe(-1);
  });
});

describe('totalDocDurationMs', () => {
  it('sums every row', () => {
    const doc = makeDoc([
      row({ timecode: '0:00-0:03' }),
      row({ timecode: '0:03-0:08' }),
      row({ timecode: '0:08-0:09' }),
    ]);
    expect(totalDocDurationMs(doc)).toBe(9000);
  });
});

describe('docToTimelineRows', () => {
  it('produces one video row containing every ProductionRow as a clip', () => {
    const doc = makeDoc([
      row({ timecode: '0:00-0:03', script_text: 'first', muted: true }),
      row({ timecode: '0:03-0:08', script_text: 'second' }),
    ]);
    const tracks = docToTimelineRows(doc);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe('video');
    expect(tracks[0].actions).toHaveLength(2);
    expect(tracks[0].actions[0].start).toBe(0);
    expect(tracks[0].actions[0].end).toBe(3);
    expect(tracks[0].actions[0].data.muted).toBe(true);
    expect(tracks[0].actions[1].start).toBe(3);
    expect(tracks[0].actions[1].end).toBe(8);
    expect(tracks[0].actions[1].data.scriptText).toBe('second');
  });

  it('handles an empty doc gracefully', () => {
    const doc = makeDoc([]);
    const tracks = docToTimelineRows(doc);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].actions).toHaveLength(0);
  });
});
