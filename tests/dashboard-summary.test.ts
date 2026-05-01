import { describe, expect, it } from 'vitest';
import {
  isSameUtcDay,
  daysSince,
  pickTodayPublishes,
  pickStuckItems,
  pickUnderperformers,
  computeCadenceGap,
  type ScheduleRow,
  type AnalyticsRow,
} from '@/lib/dashboard-summary';

const NOW = new Date('2026-05-02T12:00:00Z');

const baseScheduleRow: Omit<ScheduleRow, 'id' | 'title' | 'status' | 'scheduled_for'> = {
  stage_entered_at: null,
  editor_collaborator_name: null,
  narrator_collaborator_name: null,
  channel_id: null,
  channel_name: null,
  youtube_url: null,
};

describe('isSameUtcDay', () => {
  it('returns true for two timestamps on the same UTC date', () => {
    expect(isSameUtcDay('2026-05-02T00:00:00Z', NOW)).toBe(true);
    expect(isSameUtcDay('2026-05-02T23:59:59Z', NOW)).toBe(true);
  });
  it('returns false across UTC day boundaries', () => {
    expect(isSameUtcDay('2026-05-01T23:59:59Z', NOW)).toBe(false);
    expect(isSameUtcDay('2026-05-03T00:00:01Z', NOW)).toBe(false);
  });
  it('returns false for an unparseable timestamp', () => {
    expect(isSameUtcDay('not-a-date', NOW)).toBe(false);
  });
});

describe('daysSince', () => {
  it('returns floor of (now - then) in days', () => {
    expect(daysSince('2026-05-01T12:00:00Z', NOW)).toBe(1);
    expect(daysSince('2026-04-25T12:00:00Z', NOW)).toBe(7);
  });
  it('returns 0 for a future timestamp (clamped)', () => {
    expect(daysSince('2026-06-01T00:00:00Z', NOW)).toBe(0);
  });
  it('returns null for null input', () => {
    expect(daysSince(null, NOW)).toBeNull();
  });
  it('returns null for unparseable timestamps', () => {
    expect(daysSince('not-a-date', NOW)).toBeNull();
  });
});

describe('pickTodayPublishes', () => {
  it('keeps only items scheduled for today (UTC) and sorts by time', () => {
    const items: ScheduleRow[] = [
      { id: '1', title: 'A', status: 'ready', scheduled_for: '2026-05-02T15:00:00Z', ...baseScheduleRow },
      { id: '2', title: 'B', status: 'editing', scheduled_for: '2026-05-01T10:00:00Z', ...baseScheduleRow },
      { id: '3', title: 'C', status: 'ready', scheduled_for: '2026-05-02T08:00:00Z', ...baseScheduleRow },
      { id: '4', title: 'D', status: 'ready', scheduled_for: null, ...baseScheduleRow },
    ];
    const out = pickTodayPublishes(items, NOW);
    expect(out.map(i => i.id)).toEqual(['3', '1']); // 08:00 then 15:00
  });

  it('passes through editor / narrator / channel labels', () => {
    const items: ScheduleRow[] = [
      {
        id: '1',
        title: 'A',
        status: 'ready',
        scheduled_for: '2026-05-02T08:00:00Z',
        ...baseScheduleRow,
        editor_collaborator_name: 'Eve',
        narrator_collaborator_name: 'Nora',
        channel_name: 'My Channel',
      },
    ];
    const out = pickTodayPublishes(items, NOW);
    expect(out[0].editor_name).toBe('Eve');
    expect(out[0].narrator_name).toBe('Nora');
    expect(out[0].channel_name).toBe('My Channel');
  });
});

describe('pickStuckItems', () => {
  it('flags items past their stage threshold and ignores in-progress ones', () => {
    const items: ScheduleRow[] = [
      // editing threshold = 14d → 20d stuck
      {
        id: '1',
        title: 'Stuck editing',
        status: 'editing',
        scheduled_for: null,
        ...baseScheduleRow,
        stage_entered_at: '2026-04-12T12:00:00Z',
      },
      // scripting threshold = 10d → 5d not stuck yet
      {
        id: '2',
        title: 'Fresh scripting',
        status: 'scripting',
        scheduled_for: null,
        ...baseScheduleRow,
        stage_entered_at: '2026-04-27T12:00:00Z',
      },
      // idea threshold = 21d → 25d stuck
      {
        id: '3',
        title: 'Old idea',
        status: 'idea',
        scheduled_for: null,
        ...baseScheduleRow,
        stage_entered_at: '2026-04-07T12:00:00Z',
      },
    ];
    const out = pickStuckItems(items, NOW);
    expect(out.map(i => i.id)).toEqual(['3', '1']); // 25d > 20d, sorted desc
    expect(out[0].days_in_stage).toBe(25);
    expect(out[0].threshold_days).toBe(21);
  });

  it('skips published items (Infinity threshold)', () => {
    const items: ScheduleRow[] = [
      {
        id: '1',
        title: 'Published',
        status: 'published',
        scheduled_for: '2024-01-01T00:00:00Z',
        ...baseScheduleRow,
        stage_entered_at: '2024-01-01T00:00:00Z',
      },
    ];
    expect(pickStuckItems(items, NOW)).toEqual([]);
  });

  it('skips items with unknown status (no threshold)', () => {
    const items: ScheduleRow[] = [
      {
        id: '1',
        title: 'Unknown',
        status: 'invented_status',
        scheduled_for: null,
        ...baseScheduleRow,
        stage_entered_at: '2024-01-01T00:00:00Z',
      },
    ];
    expect(pickStuckItems(items, NOW)).toEqual([]);
  });

  it('skips items with no stage_entered_at', () => {
    const items: ScheduleRow[] = [
      {
        id: '1',
        title: 'No anchor',
        status: 'editing',
        scheduled_for: null,
        ...baseScheduleRow,
        stage_entered_at: null,
      },
    ];
    expect(pickStuckItems(items, NOW)).toEqual([]);
  });
});

describe('pickUnderperformers', () => {
  const baseAnalytics: Omit<AnalyticsRow, 'youtube_video_id' | 'published_at' | 'ctr_percentage' | 'average_view_percentage'> = {
    schedule_item_id: null,
    title: 'A video',
    thumbnail_url: null,
    views: 100,
    fetched_at: '2026-05-02T12:00:00Z',
    channel_id: null,
    channel_name: null,
  };

  it('flags rows below CTR threshold', () => {
    const rows: AnalyticsRow[] = [
      {
        ...baseAnalytics,
        youtube_video_id: 'v1',
        published_at: '2026-04-30T00:00:00Z',
        ctr_percentage: 2.5,
        average_view_percentage: 50,
      },
    ];
    const out = pickUnderperformers(rows, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].reasons[0]).toMatch(/CTR 2.5%/);
  });

  it('flags rows below AVP threshold', () => {
    const rows: AnalyticsRow[] = [
      {
        ...baseAnalytics,
        youtube_video_id: 'v1',
        published_at: '2026-04-30T00:00:00Z',
        ctr_percentage: 8,
        average_view_percentage: 18,
      },
    ];
    const out = pickUnderperformers(rows, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].reasons[0]).toMatch(/Avg view 18.0%/);
  });

  it('records BOTH reasons when both fall below', () => {
    const rows: AnalyticsRow[] = [
      {
        ...baseAnalytics,
        youtube_video_id: 'v1',
        published_at: '2026-04-30T00:00:00Z',
        ctr_percentage: 2,
        average_view_percentage: 12,
      },
    ];
    const out = pickUnderperformers(rows, NOW);
    expect(out[0].reasons).toHaveLength(2);
  });

  it('skips rows outside the recent window (default 14d)', () => {
    const rows: AnalyticsRow[] = [
      {
        ...baseAnalytics,
        youtube_video_id: 'v-old',
        published_at: '2026-01-01T00:00:00Z',
        ctr_percentage: 0.5,
        average_view_percentage: 5,
      },
    ];
    expect(pickUnderperformers(rows, NOW)).toEqual([]);
  });

  it('skips rows where neither metric is below threshold', () => {
    const rows: AnalyticsRow[] = [
      {
        ...baseAnalytics,
        youtube_video_id: 'v-good',
        published_at: '2026-04-30T00:00:00Z',
        ctr_percentage: 8,
        average_view_percentage: 50,
      },
    ];
    expect(pickUnderperformers(rows, NOW)).toEqual([]);
  });

  it('skips rows whose metrics are null (not yet synced)', () => {
    const rows: AnalyticsRow[] = [
      {
        ...baseAnalytics,
        youtube_video_id: 'v-pending',
        published_at: '2026-04-30T00:00:00Z',
        ctr_percentage: null,
        average_view_percentage: null,
      },
    ];
    expect(pickUnderperformers(rows, NOW)).toEqual([]);
  });

  it('sorts double-flagged before single-flagged, and lowest CTR first within each group', () => {
    const rows: AnalyticsRow[] = [
      { ...baseAnalytics, youtube_video_id: 'a', published_at: '2026-04-30T00:00:00Z', ctr_percentage: 1, average_view_percentage: 50 },
      { ...baseAnalytics, youtube_video_id: 'b', published_at: '2026-04-30T00:00:00Z', ctr_percentage: 2, average_view_percentage: 12 },
      { ...baseAnalytics, youtube_video_id: 'c', published_at: '2026-04-30T00:00:00Z', ctr_percentage: 3, average_view_percentage: 50 },
    ];
    const out = pickUnderperformers(rows, NOW);
    // 'b' has 2 reasons, then a (CTR 1) before c (CTR 3) among single-reason.
    expect(out.map(o => o.youtube_video_id)).toEqual(['b', 'a', 'c']);
  });

  it('honours custom thresholds', () => {
    const rows: AnalyticsRow[] = [
      {
        ...baseAnalytics,
        youtube_video_id: 'v',
        published_at: '2026-04-30T00:00:00Z',
        ctr_percentage: 5,
        average_view_percentage: 35,
      },
    ];
    expect(
      pickUnderperformers(rows, NOW, { ctr_percent_min: 6, avp_percent_min: 30 }),
    ).toHaveLength(1);
  });
});

describe('computeCadenceGap', () => {
  it('computes actual = total / weeks_window per channel', () => {
    const out = computeCadenceGap(
      [{ id: 'c1', name: 'Main' }, { id: 'c2', name: 'Side' }],
      [{ channel_id: 'c1', count: 8 }, { channel_id: 'c2', count: 1 }],
      4,
      1,
    );
    const main = out.find(r => r.channel_id === 'c1')!;
    const side = out.find(r => r.channel_id === 'c2')!;
    expect(main.actual_per_week).toBe(2);
    expect(main.gap).toBe(-1); // ahead of target
    expect(side.actual_per_week).toBe(0.25);
    expect(side.gap).toBe(0.75); // behind
  });

  it('reports 0 actual for channels with no recent publishes', () => {
    const out = computeCadenceGap(
      [{ id: 'c1', name: 'Main' }],
      [],
      4,
      1,
    );
    expect(out[0].actual_per_week).toBe(0);
    expect(out[0].gap).toBe(1);
  });

  it('sorts worst-gap channel first', () => {
    const out = computeCadenceGap(
      [
        { id: 'c1', name: 'Behind' },
        { id: 'c2', name: 'Caught up' },
        { id: 'c3', name: 'Ahead' },
      ],
      [
        { channel_id: 'c2', count: 4 }, // 1/wk = on target
        { channel_id: 'c3', count: 8 }, // 2/wk = ahead
        // c1 has 0
      ],
      4,
      1,
    );
    expect(out.map(r => r.channel_id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('honours custom target uploads/week', () => {
    const out = computeCadenceGap(
      [{ id: 'c1', name: 'Main' }],
      [{ channel_id: 'c1', count: 4 }],
      4,
      3, // target = 3 / wk
    );
    expect(out[0].actual_per_week).toBe(1);
    expect(out[0].gap).toBe(2);
    expect(out[0].target_per_week).toBe(3);
  });
});
