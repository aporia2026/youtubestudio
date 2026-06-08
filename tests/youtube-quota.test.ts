import { describe, expect, it } from 'vitest';
import {
  computeSnapshot,
  currentUtcDate,
  YOUTUBE_DEFAULT_DAILY_QUOTA_UNITS,
} from '@/lib/youtube-quota';

describe('currentUtcDate', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    // 2026-06-08 23:30 UTC — same as 2026-06-09 in some timezones,
    // but the helper must always pin to UTC.
    const d = new Date('2026-06-08T23:30:00Z');
    expect(currentUtcDate(d)).toBe('2026-06-08');
  });

  it('rolls over at UTC midnight, not local midnight', () => {
    // 2026-06-09 00:30 UTC — should report 06-09 even though the
    // host's local timezone may say it's still the 8th.
    const d = new Date('2026-06-09T00:30:00Z');
    expect(currentUtcDate(d)).toBe('2026-06-09');
  });

  it('zero-pads single-digit months and days', () => {
    const d = new Date('2026-01-05T12:00:00Z');
    expect(currentUtcDate(d)).toBe('2026-01-05');
  });
});

describe('computeSnapshot', () => {
  it('computes remaining units against the default daily cap', () => {
    const snap = computeSnapshot('ch-1', '2026-06-08', 300, 3);
    expect(snap.unitsCharged).toBe(300);
    expect(snap.chargeCount).toBe(3);
    expect(snap.remainingUnits).toBe(YOUTUBE_DEFAULT_DAILY_QUOTA_UNITS - 300);
    expect(snap.estimatedRemainingUploads).toBe((YOUTUBE_DEFAULT_DAILY_QUOTA_UNITS - 300) / 100);
  });

  it('floors estimated remaining uploads on a partial unit budget', () => {
    // 250 units left at 100 units/upload → 2 uploads (not 2.5).
    const snap = computeSnapshot('ch-1', '2026-06-08', YOUTUBE_DEFAULT_DAILY_QUOTA_UNITS - 250, 1);
    expect(snap.remainingUnits).toBe(250);
    expect(snap.estimatedRemainingUploads).toBe(2);
  });

  it('clamps remaining units at zero when over the cap', () => {
    const snap = computeSnapshot('ch-1', '2026-06-08', YOUTUBE_DEFAULT_DAILY_QUOTA_UNITS + 500, 105);
    expect(snap.remainingUnits).toBe(0);
    expect(snap.estimatedRemainingUploads).toBe(0);
  });

  it('respects a custom dailyQuota override (granted quota increase)', () => {
    const snap = computeSnapshot('ch-1', '2026-06-08', 1000, 10, 50_000, 100);
    expect(snap.remainingUnits).toBe(49_000);
    expect(snap.estimatedRemainingUploads).toBe(490);
  });
});
