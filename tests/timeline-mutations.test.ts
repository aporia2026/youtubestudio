import { describe, expect, it } from 'vitest';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import {
  cutRow,
  cutVoiceoverSegment,
  moveRow,
  moveVoiceoverSegment,
  resetRowDuration,
  setRowMuted,
  setRowTransitionIn,
  splitRowAtPlayheadMs,
  splitVoiceoverSegmentAtPlayheadMs,
  trimRowDuration,
  trimVoiceoverSegmentDuration,
} from '@/components/timeline-editor/timeline-mutations';
import { framesToMs } from '@/lib/timeline-editor/frame-math';
import {
  computeRowIntervals,
  targetIndexFromDropMs,
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

describe('moveRow', () => {
  it('moves a row from later index to earlier (drag-left)', () => {
    const doc = makeDoc([
      row({ script_text: 'a' }),
      row({ script_text: 'b' }),
      row({ script_text: 'c' }),
      row({ script_text: 'd' }),
    ]);
    const out = moveRow(doc, 2, 0);
    expect(out.rows.map((r) => r.script_text)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves a row from earlier index to later (drag-right)', () => {
    const doc = makeDoc([
      row({ script_text: 'a' }),
      row({ script_text: 'b' }),
      row({ script_text: 'c' }),
      row({ script_text: 'd' }),
    ]);
    const out = moveRow(doc, 1, 3);
    expect(out.rows.map((r) => r.script_text)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('returns same doc on no-op (fromIndex === toIndex)', () => {
    const doc = makeDoc([row(), row(), row()]);
    expect(moveRow(doc, 1, 1)).toBe(doc);
  });

  it('returns same doc on out-of-range indices', () => {
    const doc = makeDoc([row(), row()]);
    expect(moveRow(doc, -1, 0)).toBe(doc);
    expect(moveRow(doc, 0, 99)).toBe(doc);
    expect(moveRow(doc, 99, 0)).toBe(doc);
  });

  it('preserves all rows (no loss, no dup)', () => {
    const doc = makeDoc([
      row({ script_text: 'a' }),
      row({ script_text: 'b' }),
      row({ script_text: 'c' }),
      row({ script_text: 'd' }),
      row({ script_text: 'e' }),
    ]);
    const out = moveRow(doc, 0, 4);
    expect(out.rows.map((r) => r.script_text).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('targetIndexFromDropMs', () => {
  const doc = makeDoc([
    row({ timecode: '0:00-0:03' }), // 3000ms, slot anchors after removal: 0, 5000, 6000
    row({ timecode: '0:03-0:08' }), // dragged
    row({ timecode: '0:08-0:09' }),
  ]);

  it('snaps drop near 0 to slot 0 (move to start)', () => {
    expect(targetIndexFromDropMs(doc, 1, 100)).toBe(0);
  });

  it('snaps drop near the end to the last slot', () => {
    expect(targetIndexFromDropMs(doc, 1, 99_000)).toBe(2);
  });

  it('snaps to the middle slot when closest', () => {
    // Drop at 2500ms: gaps are at 0, 3000 (after row 0), 4000 (after row 0+row 2). Closest = 3000.
    expect(targetIndexFromDropMs(doc, 1, 2500)).toBe(1);
  });

  it('returns fromIndex on out-of-range fromIndex', () => {
    expect(targetIndexFromDropMs(doc, -1, 0)).toBe(-1);
    expect(targetIndexFromDropMs(doc, 99, 0)).toBe(99);
  });
});

describe('setRowTransitionIn', () => {
  it('applies cross-fade', () => {
    const doc = makeDoc([row(), row()]);
    const out = setRowTransitionIn(doc, 1, 'cross-fade');
    expect(out.rows[1].transition_in).toBe('cross-fade');
    expect(out.rows[0].transition_in).toBeUndefined();
  });

  it('clears the transition when given null', () => {
    const doc = makeDoc([row({ transition_in: 'cross-fade' })]);
    const out = setRowTransitionIn(doc, 0, null);
    expect(out.rows[0].transition_in).toBeUndefined();
  });

  it('returns same doc on no-op', () => {
    const doc = makeDoc([row({ transition_in: 'cross-fade' })]);
    expect(setRowTransitionIn(doc, 0, 'cross-fade')).toBe(doc);
    const docNoTrans = makeDoc([row()]);
    expect(setRowTransitionIn(docNoTrans, 0, null)).toBe(docNoTrans);
  });

  it('returns same doc on out-of-range index', () => {
    const doc = makeDoc([row()]);
    expect(setRowTransitionIn(doc, 99, 'cross-fade')).toBe(doc);
  });
});

describe('trimVoiceoverSegmentDuration', () => {
  function docWithSegments(durations: number[]) {
    return {
      ...makeDoc([row()]),
      voiceover_segments: durations.map((d, i) => ({
        id: `vo-${i}`,
        sourceUrl: 'https://example/audio.mp3',
        sourceOffsetMs: 0,
        durationMs: d,
      })),
    };
  }

  it('sets durationMs snapped to frame', () => {
    const doc = docWithSegments([5000]);
    const out = trimVoiceoverSegmentDuration(doc, 0, 3000, { fps: 30 });
    expect(out.voiceover_segments?.[0].durationMs).toBe(3000);
  });

  it('floors at one frame', () => {
    const doc = docWithSegments([5000]);
    const out = trimVoiceoverSegmentDuration(doc, 0, 1, { fps: 30 });
    expect(out.voiceover_segments?.[0].durationMs).toBeCloseTo(33.333, 1);
  });

  it('returns same doc on no-op', () => {
    const doc = docWithSegments([5000]);
    expect(trimVoiceoverSegmentDuration(doc, 0, 5000)).toBe(doc);
  });

  it('returns same doc on out-of-range segmentIndex', () => {
    const doc = docWithSegments([5000]);
    expect(trimVoiceoverSegmentDuration(doc, 99, 3000)).toBe(doc);
    expect(trimVoiceoverSegmentDuration(doc, -1, 3000)).toBe(doc);
  });

  it('returns same doc when there are no segments', () => {
    const doc = makeDoc([row()]);
    expect(trimVoiceoverSegmentDuration(doc, 0, 3000)).toBe(doc);
  });
});

describe('splitVoiceoverSegmentAtPlayheadMs', () => {
  function docWithSegments(durations: number[], sourceOffset = 0) {
    return {
      ...makeDoc([row()]),
      voiceover_segments: durations.map((d, i) => ({
        id: `vo-${i}`,
        sourceUrl: 'https://example/audio.mp3',
        sourceOffsetMs: sourceOffset,
        durationMs: d,
      })),
    };
  }

  it('splits a 5s segment in half', () => {
    const doc = docWithSegments([5000]);
    const out = splitVoiceoverSegmentAtPlayheadMs(doc, 2500, { fps: 30 });
    expect(out.voiceover_segments).toHaveLength(2);
    expect(out.voiceover_segments?.[0].durationMs).toBe(2500);
    expect(out.voiceover_segments?.[1].durationMs).toBe(2500);
  });

  it('preserves total duration', () => {
    const doc = docWithSegments([5000]);
    const out = splitVoiceoverSegmentAtPlayheadMs(doc, 1666, { fps: 30 });
    const total = out.voiceover_segments!.reduce((a, s) => a + s.durationMs, 0);
    expect(total).toBe(5000);
  });

  it('advances sourceOffsetMs on the second half so audio continues from the cut', () => {
    const doc = docWithSegments([5000], 1000); // segment sourced from offset 1000ms
    const out = splitVoiceoverSegmentAtPlayheadMs(doc, 2500, { fps: 30 });
    expect(out.voiceover_segments?.[0].sourceOffsetMs).toBe(1000);
    expect(out.voiceover_segments?.[1].sourceOffsetMs).toBe(1000 + 2500);
  });

  it('refuses to split within one frame of either edge', () => {
    const doc = docWithSegments([3000]);
    expect(splitVoiceoverSegmentAtPlayheadMs(doc, 5)).toBe(doc); // <1 frame
    expect(splitVoiceoverSegmentAtPlayheadMs(doc, 2995)).toBe(doc); // within 1 frame of end
  });

  it('returns same doc when there are no segments', () => {
    const doc = makeDoc([row()]);
    expect(splitVoiceoverSegmentAtPlayheadMs(doc, 1000)).toBe(doc);
  });
});

describe('cutVoiceoverSegment', () => {
  function docWithSegments(durations: number[]) {
    return {
      ...makeDoc([row()]),
      voiceover_segments: durations.map((d, i) => ({
        id: `vo-${i}`,
        sourceUrl: 'https://example/audio.mp3',
        sourceOffsetMs: 0,
        durationMs: d,
      })),
    };
  }

  it('removes the segment at the supplied index', () => {
    const doc = docWithSegments([1000, 2000, 3000]);
    const out = cutVoiceoverSegment(doc, 1);
    expect(out.voiceover_segments?.map((s) => s.durationMs)).toEqual([1000, 3000]);
  });

  it('refuses to delete the last remaining segment', () => {
    const doc = docWithSegments([1000]);
    expect(cutVoiceoverSegment(doc, 0)).toBe(doc);
  });

  it('returns same doc on out-of-range', () => {
    const doc = docWithSegments([1000, 2000]);
    expect(cutVoiceoverSegment(doc, 99)).toBe(doc);
    expect(cutVoiceoverSegment(doc, -1)).toBe(doc);
  });
});

describe('moveVoiceoverSegment', () => {
  function docWithSegments(ids: string[]) {
    return {
      ...makeDoc([row()]),
      voiceover_segments: ids.map((id) => ({
        id,
        sourceUrl: 'https://example/audio.mp3',
        sourceOffsetMs: 0,
        durationMs: 1000,
      })),
    };
  }

  it('reorders the segment from one index to another', () => {
    const doc = docWithSegments(['a', 'b', 'c', 'd']);
    const out = moveVoiceoverSegment(doc, 0, 2);
    expect(out.voiceover_segments?.map((s) => s.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns same doc on no-op or out-of-range', () => {
    const doc = docWithSegments(['a', 'b']);
    expect(moveVoiceoverSegment(doc, 0, 0)).toBe(doc);
    expect(moveVoiceoverSegment(doc, -1, 0)).toBe(doc);
    expect(moveVoiceoverSegment(doc, 0, 99)).toBe(doc);
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
