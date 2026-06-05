import { describe, expect, it } from 'vitest';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import {
  computeRowIntervals,
  computeVoiceoverIntervals,
  docToTimelineRows,
  ensureVoiceoverSeeded,
  parseTimecodeDurationMs,
  rowDurationMs,
  rowIndexAtMs,
  totalDocDurationMs,
  voiceoverSegmentIndexAtMs,
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

function makeDoc(rows: ProductionRow[], totalDuration = '0:30'): ProductionDoc {
  // The unified cascade math in `computeProductionDocIntervals`
  // extends the LAST row to `total_duration`, so tests that assert
  // the cascade matches the row's timecode-range duration must pass
  // a matching `total_duration`.
  return {
    title: 'Test',
    niche: 'test',
    total_duration: totalDuration,
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
  it('walks rows cumulatively (cascade math matches the renderer)', () => {
    // Each timecode-range duration is ≥ DEFAULT_MIN_SCENE_MS (2000ms)
    // so the cascade reflects the raw gaps. A separate test below
    // covers the floor-extension behavior explicitly.
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03' }),
        row({ timecode: '0:03-0:08' }),
        row({ timecode: '0:08-0:11' }),
      ],
      '0:11',
    );
    const intervals = computeRowIntervals(doc);
    expect(intervals).toHaveLength(3);
    expect(intervals[0].startMs).toBe(0);
    expect(intervals[0].durationMs).toBe(3000);
    expect(intervals[1].startMs).toBe(3000);
    expect(intervals[1].durationMs).toBe(5000);
    expect(intervals[2].startMs).toBe(8000);
    expect(intervals[2].durationMs).toBe(3000);
  });

  it('extends a sub-floor last shot up to DEFAULT_MIN_SCENE_MS', () => {
    // Auto-pipeline floor: a 1-second timecode range would flash on
    // screen too briefly to read, so calcShotIntervals extends it up
    // to minSceneMs. This is the AI-anti-flash guard — separate from
    // explicit user overrides which now bypass it (see Bug 1 fix).
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03' }),
        row({ timecode: '0:03-0:08' }),
        row({ timecode: '0:08-0:09' }), // natural 1000ms → floored to 2000ms
      ],
      '0:09',
    );
    const intervals = computeRowIntervals(doc);
    expect(intervals[2].durationMs).toBe(2000);
  });

  it('extends the LAST row to total_duration (eliminates timeline/renderer drift)', () => {
    // Pre-unification bug: timeline summed literal timecode ranges
    // (3+5+1=9s), renderer played to total_duration (12s). The user
    // saw a 9s timeline but a 12s preview clock. Unified math makes
    // both surfaces agree at 12s.
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03' }),
        row({ timecode: '0:03-0:08' }),
        row({ timecode: '0:08-0:09' }),
      ],
      '0:12',
    );
    const intervals = computeRowIntervals(doc);
    expect(intervals[2].startMs).toBe(8000);
    expect(intervals[2].durationMs).toBe(4000); // 12_000 − 8_000
  });

  it('respects duration_override_ms in the middle of the cascade', () => {
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03' }),                              // 3000ms
        row({ timecode: '0:03-0:08', duration_override_ms: 10000 }), // overridden to 10000ms
        row({ timecode: '0:08-0:11' }),                              // 3000ms (above floor)
      ],
      '0:11',
    );
    const intervals = computeRowIntervals(doc);
    expect(intervals[1].startMs).toBe(3000);
    expect(intervals[1].durationMs).toBe(10000);
    expect(intervals[2].startMs).toBe(13000);
    expect(intervals[2].durationMs).toBe(3000);
  });

  it('honors a tiny override below DEFAULT_MIN_SCENE_MS (timeline trim below 2s reflects on the ruler)', () => {
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03', duration_override_ms: 500 }),
        row({ timecode: '0:03-0:06' }),
      ],
      '0:06',
    );
    const intervals = computeRowIntervals(doc);
    expect(intervals[0].durationMs).toBe(500);
    expect(intervals[1].startMs).toBe(500);
  });

  it('emits unique rowIds per index', () => {
    const doc = makeDoc([row(), row(), row()]);
    const ids = computeRowIntervals(doc).map((i) => i.rowId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('rowIndexAtMs', () => {
  const doc = makeDoc(
    [
      row({ timecode: '0:00-0:03' }),
      row({ timecode: '0:03-0:08' }),
      row({ timecode: '0:08-0:11' }),
    ],
    '0:11',
  );

  it('returns the row containing the supplied ms', () => {
    expect(rowIndexAtMs(doc, 0)).toBe(0);
    expect(rowIndexAtMs(doc, 1500)).toBe(0);
    expect(rowIndexAtMs(doc, 3000)).toBe(1); // start of row 2 (inclusive)
    expect(rowIndexAtMs(doc, 7999)).toBe(1);
    expect(rowIndexAtMs(doc, 8000)).toBe(2);
    expect(rowIndexAtMs(doc, 10999)).toBe(2);
  });

  it('returns -1 before the first row and after the last', () => {
    expect(rowIndexAtMs(doc, -1)).toBe(-1);
    expect(rowIndexAtMs(doc, 11000)).toBe(-1);
  });
});

describe('totalDocDurationMs', () => {
  it('sums every row using the unified cascade (matches the Player clock)', () => {
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03' }),
        row({ timecode: '0:03-0:08' }),
        row({ timecode: '0:08-0:11' }),
      ],
      '0:11',
    );
    expect(totalDocDurationMs(doc)).toBe(11000);
  });

  it('extends to total_duration when timecodes do not cover the full video', () => {
    // 619.2s vs 772s regression guard: pre-unification the timeline
    // summed literal timecode ranges (11000ms) while the renderer
    // played to total_duration (15000ms). Unified math has both
    // surfaces agree at 15000ms.
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03' }),
        row({ timecode: '0:03-0:08' }),
        row({ timecode: '0:08-0:11' }),
      ],
      '0:15',
    );
    expect(totalDocDurationMs(doc)).toBe(15000);
  });
});

describe('computeVoiceoverIntervals', () => {
  it('walks segments cumulatively', () => {
    const doc = {
      ...makeDoc([row()]),
      voiceover_segments: [
        { id: 'a', sourceUrl: 'x', sourceOffsetMs: 0, durationMs: 1000 },
        { id: 'b', sourceUrl: 'x', sourceOffsetMs: 1000, durationMs: 2000 },
        { id: 'c', sourceUrl: 'x', sourceOffsetMs: 3000, durationMs: 500 },
      ],
    };
    const out = computeVoiceoverIntervals(doc);
    expect(out).toHaveLength(3);
    expect(out[0].startMs).toBe(0);
    expect(out[1].startMs).toBe(1000);
    expect(out[2].startMs).toBe(3000);
    expect(out[2].segmentId).toBe('c');
  });

  it('returns empty array when no segments', () => {
    const doc = makeDoc([row()]);
    expect(computeVoiceoverIntervals(doc)).toEqual([]);
  });
});

describe('voiceoverSegmentIndexAtMs', () => {
  const doc = {
    ...makeDoc([row()]),
    voiceover_segments: [
      { id: 'a', sourceUrl: 'x', sourceOffsetMs: 0, durationMs: 1000 },
      { id: 'b', sourceUrl: 'x', sourceOffsetMs: 1000, durationMs: 2000 },
    ],
  };

  it('returns the segment containing the supplied ms', () => {
    expect(voiceoverSegmentIndexAtMs(doc, 0)).toBe(0);
    expect(voiceoverSegmentIndexAtMs(doc, 999)).toBe(0);
    expect(voiceoverSegmentIndexAtMs(doc, 1000)).toBe(1);
    expect(voiceoverSegmentIndexAtMs(doc, 2999)).toBe(1);
  });

  it('returns -1 before first or after last', () => {
    expect(voiceoverSegmentIndexAtMs(doc, -1)).toBe(-1);
    expect(voiceoverSegmentIndexAtMs(doc, 9000)).toBe(-1);
  });
});

describe('ensureVoiceoverSeeded', () => {
  it('adds one segment covering the entire video duration', () => {
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03' }),
        row({ timecode: '0:03-0:05' }),
      ],
      '0:05',
    );
    const out = ensureVoiceoverSeeded(doc, 'https://example/voice.mp3');
    expect(out.voiceover_segments).toHaveLength(1);
    expect(out.voiceover_segments?.[0].sourceUrl).toBe('https://example/voice.mp3');
    expect(out.voiceover_segments?.[0].durationMs).toBe(5000);
    expect(out.voiceover_segments?.[0].sourceOffsetMs).toBe(0);
  });

  it('returns same doc when segments already exist', () => {
    const doc = {
      ...makeDoc([row()]),
      voiceover_segments: [{ id: 'x', sourceUrl: 'a', sourceOffsetMs: 0, durationMs: 1000 }],
    };
    expect(ensureVoiceoverSeeded(doc, 'something')).toBe(doc);
  });

  it('returns same doc when sourceUrl is empty', () => {
    const doc = makeDoc([row()]);
    expect(ensureVoiceoverSeeded(doc, '')).toBe(doc);
  });
});

describe('docToTimelineRows', () => {
  it('produces one video row containing every ProductionRow as a clip', () => {
    const doc = makeDoc(
      [
        row({ timecode: '0:00-0:03', script_text: 'first', muted: true }),
        row({ timecode: '0:03-0:08', script_text: 'second' }),
      ],
      '0:08',
    );
    const tracks = docToTimelineRows(doc);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe('video');
    expect(tracks[0].actions).toHaveLength(2);
    expect(tracks[0].actions[0].start).toBe(0);
    expect(tracks[0].actions[0].end).toBe(3);
    if (tracks[0].actions[0].data.kind === 'video') {
      expect(tracks[0].actions[0].data.muted).toBe(true);
    }
    expect(tracks[0].actions[1].start).toBe(3);
    expect(tracks[0].actions[1].end).toBe(8);
    if (tracks[0].actions[1].data.kind === 'video') {
      expect(tracks[0].actions[1].data.scriptText).toBe('second');
    }
  });

  it('produces a second voiceover row when voiceover_segments are present', () => {
    const doc = {
      ...makeDoc([row()]),
      voiceover_segments: [
        { id: 'a', sourceUrl: 'https://x/audio.mp3', sourceOffsetMs: 0, durationMs: 2000 },
        { id: 'b', sourceUrl: 'https://x/audio.mp3', sourceOffsetMs: 2000, durationMs: 3000 },
      ],
    };
    const tracks = docToTimelineRows(doc);
    expect(tracks).toHaveLength(2);
    expect(tracks[1].id).toBe('voiceover');
    expect(tracks[1].actions).toHaveLength(2);
    expect(tracks[1].actions[0].start).toBe(0);
    expect(tracks[1].actions[0].end).toBe(2);
    if (tracks[1].actions[0].data.kind === 'voiceover') {
      expect(tracks[1].actions[0].data.segmentIndex).toBe(0);
      expect(tracks[1].actions[0].data.sourceOffsetMs).toBe(0);
    }
  });

  it('handles an empty doc gracefully', () => {
    const doc = makeDoc([]);
    const tracks = docToTimelineRows(doc);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].actions).toHaveLength(0);
  });
});
