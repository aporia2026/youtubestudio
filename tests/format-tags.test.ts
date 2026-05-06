import { describe, expect, it } from 'vitest';
import {
  aggregateFormatStats,
  isVideoFormat,
  parseFormatTagOutput,
  VIDEO_FORMATS,
} from '@/lib/format-tags';

describe('isVideoFormat', () => {
  it('accepts every documented format', () => {
    for (const f of VIDEO_FORMATS) {
      expect(isVideoFormat(f)).toBe(true);
    }
  });
  it('rejects unknown strings', () => {
    expect(isVideoFormat('explainerz')).toBe(false);
    expect(isVideoFormat('')).toBe(false);
    expect(isVideoFormat('Tutorial')).toBe(false); // case-sensitive
  });
});

describe('parseFormatTagOutput', () => {
  it('parses a clean JSON response', () => {
    const out = parseFormatTagOutput(
      JSON.stringify({
        format: 'tutorial',
        topics: ['ai agents', 'claude', 'sdk'],
        confidence: 0.85,
      }),
    );
    expect(out).toEqual({
      format: 'tutorial',
      topics: ['ai agents', 'claude', 'sdk'],
      confidence: 0.85,
    });
  });

  it('falls back to "other" when the format is not in the enum', () => {
    const out = parseFormatTagOutput(
      JSON.stringify({ format: 'rambling', topics: [], confidence: 0.5 }),
    );
    expect(out!.format).toBe('other');
  });

  it('lowercases + de-dupes + caps topics at 5 entries', () => {
    const out = parseFormatTagOutput(
      JSON.stringify({
        format: 'list',
        topics: ['AI', 'ai', 'AGENTS', 'agents', 'claude', 'sdk', 'tutorial', 'extra'],
        confidence: 0.7,
      }),
    );
    expect(out!.topics).toHaveLength(5);
    // 'AI' + 'ai' collapsed; 'AGENTS' + 'agents' collapsed.
    expect(new Set(out!.topics)).toEqual(new Set(['ai', 'agents', 'claude', 'sdk', 'tutorial']));
  });

  it('handles comma-separated string topics defensively', () => {
    const out = parseFormatTagOutput(
      JSON.stringify({ format: 'commentary', topics: 'ai, agents, claude', confidence: 0.6 }),
    );
    expect(out!.topics).toEqual(['ai', 'agents', 'claude']);
  });

  it('clamps confidence to [0, 1] and falls back to 0.5 on garbage', () => {
    expect(parseFormatTagOutput(JSON.stringify({ format: 'list', topics: [], confidence: 5 }))!.confidence).toBe(1);
    expect(parseFormatTagOutput(JSON.stringify({ format: 'list', topics: [], confidence: -0.5 }))!.confidence).toBe(0);
    expect(parseFormatTagOutput(JSON.stringify({ format: 'list', topics: [], confidence: 'high' }))!.confidence).toBe(0.5);
    expect(parseFormatTagOutput(JSON.stringify({ format: 'list', topics: [] }))!.confidence).toBe(0.5);
  });

  it('drops topics over 40 chars (defensive size cap)', () => {
    const long = 'x'.repeat(50);
    const out = parseFormatTagOutput(
      JSON.stringify({ format: 'list', topics: ['ok', long], confidence: 0.5 }),
    );
    expect(out!.topics).toEqual(['ok']);
  });

  it('returns null for non-JSON', () => {
    expect(parseFormatTagOutput('not json')).toBeNull();
    expect(parseFormatTagOutput('null')).toBeNull();
  });

  it('parses fenced JSON', () => {
    const fenced =
      '```json\n' +
      JSON.stringify({ format: 'explainer', topics: ['ai'], confidence: 0.8 }) +
      '\n```';
    const out = parseFormatTagOutput(fenced);
    expect(out!.format).toBe('explainer');
  });
});

describe('aggregateFormatStats', () => {
  it('aggregates means per format and sorts by video_count desc', () => {
    const out = aggregateFormatStats([
      { format: 'tutorial', average_view_percentage: 50, ctr_percentage: 5, views: 1000 },
      { format: 'tutorial', average_view_percentage: 40, ctr_percentage: 4, views: 800 },
      { format: 'tutorial', average_view_percentage: 60, ctr_percentage: 6, views: 1200 },
      { format: 'list', average_view_percentage: 30, ctr_percentage: 3, views: 500 },
    ]);
    expect(out[0]!.format).toBe('tutorial');
    expect(out[0]!.video_count).toBe(3);
    expect(out[0]!.mean_avp).toBeCloseTo(50, 5);
    expect(out[0]!.mean_ctr).toBeCloseTo(5, 5);
    expect(out[0]!.mean_views).toBeCloseTo(1000, 5);
    expect(out[1]!.format).toBe('list');
    expect(out[1]!.video_count).toBe(1);
  });

  it('returns null mean when every value is null in the bucket', () => {
    const out = aggregateFormatStats([
      { format: 'list', average_view_percentage: null, ctr_percentage: null, views: null },
      { format: 'list', average_view_percentage: null, ctr_percentage: null, views: null },
    ]);
    expect(out[0]!.mean_avp).toBeNull();
    expect(out[0]!.mean_ctr).toBeNull();
    expect(out[0]!.mean_views).toBeNull();
    expect(out[0]!.video_count).toBe(2);
  });

  it('mixes null + non-null values in the same bucket without crashing', () => {
    const out = aggregateFormatStats([
      { format: 'story', average_view_percentage: 40, ctr_percentage: null, views: 100 },
      { format: 'story', average_view_percentage: null, ctr_percentage: 6, views: null },
    ]);
    expect(out[0]!.video_count).toBe(2);
    expect(out[0]!.mean_avp).toBeCloseTo(40, 5);
    expect(out[0]!.mean_ctr).toBeCloseTo(6, 5);
    expect(out[0]!.mean_views).toBeCloseTo(100, 5);
  });

  it('returns [] for empty input', () => {
    expect(aggregateFormatStats([])).toEqual([]);
  });
});
