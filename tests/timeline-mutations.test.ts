import { describe, expect, it } from 'vitest';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import {
  cutRow,
  resetRowDuration,
  setRowMuted,
  splitRowAtPlayheadMs,
  trimRowDuration,
} from '@/components/timeline-editor/timeline-mutations';
import { framesToMs } from '@/lib/timeline-editor/frame-math';
import { computeRowIntervals } from '@/components/timeline-editor/timeline-data-adapter';

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

describe('trimRowDuration', () => {
  it('sets duration_override_ms snapped to the nearest frame at 30 fps', () => {
    const doc = makeDoc([row(), row()]);
    // 5000ms at 30fps is exactly 150 frames — no rounding.
    const out = trimRowDuration(doc, 0, 5000, { fps: 30 });
    expect(out.rows[0].duration_override_ms).toBe(5000);
    expect(out.rows[1].duration_override_ms).toBeUndefined();
  });

  it('snaps a non-frame-aligned value to the nearest frame', () => {
    const doc = makeDoc([row()]);
    // 5050ms at 30fps: 151.5 frames → 152 frames → 5066.67ms.
    const out = trimRowDuration(doc, 0, 5050, { fps: 30 });
    expect(out.rows[0].duration_override_ms).toBeCloseTo(5066.667, 2);
  });

  it('floors to one frame at 30 fps (no sub-frame durations)', () => {
    const doc = makeDoc([row()]);
    const oneFrame = framesToMs(1, 30);
    // Asking for 1ms — below half a frame — should clamp to one full frame.
    const out = trimRowDuration(doc, 0, 1, { fps: 30 });
    expect(out.rows[0].duration_override_ms).toBeCloseTo(oneFrame, 3);
  });

  it('honors a custom minDurationMs above the one-frame default', () => {
    const doc = makeDoc([row()]);
    const out = trimRowDuration(doc, 0, 50, { fps: 30, minDurationMs: 1000 });
    expect(out.rows[0].duration_override_ms).toBe(1000);
  });

  it('returns the SAME doc object when the trim is a no-op (object identity)', () => {
    const doc = makeDoc([row({ duration_override_ms: 3000 })]);
    const out = trimRowDuration(doc, 0, 3000, { fps: 30 });
    expect(out).toBe(doc);
  });

  it('returns the SAME doc when rowIndex is out of range', () => {
    const doc = makeDoc([row(), row()]);
    expect(trimRowDuration(doc, -1, 5000)).toBe(doc);
    expect(trimRowDuration(doc, 999, 5000)).toBe(doc);
  });

  it('does not mutate other rows', () => {
    const doc = makeDoc([
      row({ duration_override_ms: 4000 }),
      row({ duration_override_ms: 7000 }),
      row(),
    ]);
    const out = trimRowDuration(doc, 1, 9000, { fps: 30 });
    expect(out.rows[0]).toBe(doc.rows[0]);
    expect(out.rows[2]).toBe(doc.rows[2]);
    expect(out.rows[1].duration_override_ms).toBe(9000);
  });

  it('snaps differently at 60 fps', () => {
    const doc = makeDoc([row()]);
    // 100ms at 60fps = 6 frames exactly → no snap.
    expect(trimRowDuration(doc, 0, 100, { fps: 60 }).rows[0].duration_override_ms).toBe(100);
    // 50ms at 60fps = 3 frames exactly.
    expect(trimRowDuration(doc, 0, 50, { fps: 60 }).rows[0].duration_override_ms).toBe(50);
    // 16.6ms at 60fps = 0.996 → 1 frame → 16.667ms.
    expect(trimRowDuration(doc, 0, 16.6, { fps: 60 }).rows[0].duration_override_ms).toBeCloseTo(16.667, 2);
  });
});

describe('resetRowDuration', () => {
  it('removes duration_override_ms from the targeted row', () => {
    const doc = makeDoc([row({ duration_override_ms: 8000 })]);
    const out = resetRowDuration(doc, 0);
    expect(out.rows[0].duration_override_ms).toBeUndefined();
  });

  it('returns the same doc when there was no override', () => {
    const doc = makeDoc([row()]);
    expect(resetRowDuration(doc, 0)).toBe(doc);
  });

  it('returns the same doc when rowIndex is out of range', () => {
    const doc = makeDoc([row({ duration_override_ms: 8000 })]);
    expect(resetRowDuration(doc, 99)).toBe(doc);
  });
});

describe('splitRowAtPlayheadMs', () => {
  it('splits a 3-second row exactly in half', () => {
    const doc = makeDoc([row({ timecode: '0:00-0:03' })]);
    const out = splitRowAtPlayheadMs(doc, 1500, { fps: 30 });
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].duration_override_ms).toBe(1500);
    expect(out.rows[0].pin_duration).toBe(true);
    expect(out.rows[1].duration_override_ms).toBe(1500);
    expect(out.rows[1].pin_duration).toBe(true);
  });

  it('preserves total duration after split', () => {
    const doc = makeDoc([row({ timecode: '0:00-0:05' })]);
    const out = splitRowAtPlayheadMs(doc, 1666, { fps: 30 });
    const total = computeRowIntervals(out).reduce((acc, iv) => acc + iv.durationMs, 0);
    expect(total).toBe(5000);
  });

  it('snaps the cut point to the nearest frame at 30 fps', () => {
    const doc = makeDoc([row({ timecode: '0:00-0:03' })]);
    // 1234ms cut at 30fps: 1234ms × 30/1000 = 37.02 frames → 37 → 1233.33ms
    const out = splitRowAtPlayheadMs(doc, 1234, { fps: 30 });
    expect(out.rows[0].duration_override_ms).toBeCloseTo(1233.33, 1);
  });

  it('clones script_text + ai_image_prompt into both halves', () => {
    const doc = makeDoc([row({ script_text: 'hello world', ai_image_prompt: 'pretty image' })]);
    const out = splitRowAtPlayheadMs(doc, 1500, { fps: 30 });
    expect(out.rows[0].script_text).toBe('hello world');
    expect(out.rows[1].script_text).toBe('hello world');
    expect(out.rows[0].ai_image_prompt).toBe('pretty image');
    expect(out.rows[1].ai_image_prompt).toBe('pretty image');
  });

  it('splits inside the second row, not the first', () => {
    const doc = makeDoc([
      row({ timecode: '0:00-0:03', script_text: 'first' }),
      row({ timecode: '0:03-0:08', script_text: 'second' }),
    ]);
    // Playhead at 5000ms = 2000ms into row 2.
    const out = splitRowAtPlayheadMs(doc, 5000, { fps: 30 });
    expect(out.rows).toHaveLength(3);
    expect(out.rows[0].script_text).toBe('first');
    expect(out.rows[1].script_text).toBe('second');
    expect(out.rows[1].duration_override_ms).toBe(2000);
    expect(out.rows[2].script_text).toBe('second');
    expect(out.rows[2].duration_override_ms).toBe(3000);
  });

  it('refuses to split within one frame of the start edge', () => {
    const doc = makeDoc([row({ timecode: '0:00-0:03' })]);
    expect(splitRowAtPlayheadMs(doc, 5, { fps: 30 })).toBe(doc); // <1 frame
  });

  it('refuses to split within one frame of the end edge', () => {
    const doc = makeDoc([row({ timecode: '0:00-0:03' })]);
    expect(splitRowAtPlayheadMs(doc, 2995, { fps: 30 })).toBe(doc); // within 1 frame of end
  });

  it('returns the same doc when playhead is past the last row', () => {
    const doc = makeDoc([row({ timecode: '0:00-0:03' })]);
    expect(splitRowAtPlayheadMs(doc, 10_000, { fps: 30 })).toBe(doc);
  });

  it('returns the same doc when playhead is before the first row', () => {
    const doc = makeDoc([row()]);
    expect(splitRowAtPlayheadMs(doc, -100, { fps: 30 })).toBe(doc);
  });

  it('respects a custom minDurationMs', () => {
    const doc = makeDoc([row({ timecode: '0:00-0:05' })]);
    // Cut at 800ms with min=1000ms should refuse.
    expect(splitRowAtPlayheadMs(doc, 800, { fps: 30, minDurationMs: 1000 })).toBe(doc);
    // Cut at 1500ms with min=1000ms should succeed.
    const out = splitRowAtPlayheadMs(doc, 1500, { fps: 30, minDurationMs: 1000 });
    expect(out.rows).toHaveLength(2);
  });
});

describe('cutRow', () => {
  it('removes the row at the given index', () => {
    const doc = makeDoc([
      row({ script_text: 'a' }),
      row({ script_text: 'b' }),
      row({ script_text: 'c' }),
    ]);
    const out = cutRow(doc, 1);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].script_text).toBe('a');
    expect(out.rows[1].script_text).toBe('c');
  });

  it('refuses to cut the last remaining row', () => {
    const doc = makeDoc([row()]);
    expect(cutRow(doc, 0)).toBe(doc);
  });

  it('returns the same doc for out-of-range indices', () => {
    const doc = makeDoc([row(), row()]);
    expect(cutRow(doc, -1)).toBe(doc);
    expect(cutRow(doc, 99)).toBe(doc);
  });

  it('does not mutate the input rows array (immutable)', () => {
    const doc = makeDoc([row({ script_text: 'a' }), row({ script_text: 'b' })]);
    const inputRows = doc.rows;
    const inputRowsLength = inputRows.length;
    cutRow(doc, 0);
    expect(inputRows).toHaveLength(inputRowsLength);
    expect(doc.rows).toBe(inputRows);
  });
});

describe('setRowMuted', () => {
  it('toggles muted', () => {
    const doc = makeDoc([row(), row({ muted: true })]);
    expect(setRowMuted(doc, 0, true).rows[0].muted).toBe(true);
    expect(setRowMuted(doc, 1, false).rows[1].muted).toBe(false);
  });

  it('returns the same doc on no-op', () => {
    const doc = makeDoc([row({ muted: true })]);
    expect(setRowMuted(doc, 0, true)).toBe(doc);
  });

  it('does not mutate other rows', () => {
    const doc = makeDoc([row(), row(), row()]);
    const out = setRowMuted(doc, 1, true);
    expect(out.rows[0]).toBe(doc.rows[0]);
    expect(out.rows[2]).toBe(doc.rows[2]);
  });
});
