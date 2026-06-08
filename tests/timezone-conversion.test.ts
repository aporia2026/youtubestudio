import { describe, expect, it } from 'vitest';
import {
  utcIsoToLocalInputValue,
  localInputValueToUtcIso,
  formatLocalDate,
} from '@/lib/timezone-conversion';

describe('utcIsoToLocalInputValue', () => {
  it('formats a UTC instant in UTC as itself', () => {
    expect(utcIsoToLocalInputValue('2026-06-08T15:30:00Z', 'UTC')).toBe('2026-06-08T15:30');
  });

  it('subtracts the New York offset from UTC (winter, EST = UTC-5)', () => {
    // 2026-01-15 18:00 UTC = 2026-01-15 13:00 EST
    expect(utcIsoToLocalInputValue('2026-01-15T18:00:00Z', 'America/New_York'))
      .toBe('2026-01-15T13:00');
  });

  it('subtracts the New York offset from UTC (summer, EDT = UTC-4)', () => {
    // 2026-07-15 18:00 UTC = 2026-07-15 14:00 EDT
    expect(utcIsoToLocalInputValue('2026-07-15T18:00:00Z', 'America/New_York'))
      .toBe('2026-07-15T14:00');
  });

  it('adds the Jerusalem offset to UTC (winter, IST = UTC+2)', () => {
    expect(utcIsoToLocalInputValue('2026-01-15T18:00:00Z', 'Asia/Jerusalem'))
      .toBe('2026-01-15T20:00');
  });

  it('rolls over a date when the zone crosses midnight', () => {
    // 2026-01-15 02:00 UTC = 2026-01-14 21:00 EST
    expect(utcIsoToLocalInputValue('2026-01-15T02:00:00Z', 'America/New_York'))
      .toBe('2026-01-14T21:00');
  });

  it('returns empty string for invalid input', () => {
    expect(utcIsoToLocalInputValue('not-a-date', 'UTC')).toBe('');
  });
});

describe('localInputValueToUtcIso', () => {
  it('treats UTC local-time as UTC verbatim', () => {
    expect(localInputValueToUtcIso('2026-06-08T15:30', 'UTC')).toBe('2026-06-08T15:30:00.000Z');
  });

  it('adds the New York offset (winter, EST = UTC-5)', () => {
    // 2026-01-15 13:00 EST = 2026-01-15 18:00 UTC
    expect(localInputValueToUtcIso('2026-01-15T13:00', 'America/New_York'))
      .toBe('2026-01-15T18:00:00.000Z');
  });

  it('adds the New York offset (summer, EDT = UTC-4)', () => {
    // 2026-07-15 13:00 EDT = 2026-07-15 17:00 UTC
    expect(localInputValueToUtcIso('2026-07-15T13:00', 'America/New_York'))
      .toBe('2026-07-15T17:00:00.000Z');
  });

  it('subtracts the Jerusalem offset (winter, IST = UTC+2)', () => {
    expect(localInputValueToUtcIso('2026-01-15T20:00', 'Asia/Jerusalem'))
      .toBe('2026-01-15T18:00:00.000Z');
  });

  it('round-trips: utc → local → utc returns the same instant', () => {
    const cases: ReadonlyArray<{ utc: string; tz: string }> = [
      { utc: '2026-01-15T18:00:00.000Z', tz: 'America/New_York' },
      { utc: '2026-07-15T18:00:00.000Z', tz: 'America/New_York' },
      { utc: '2026-01-15T18:00:00.000Z', tz: 'Asia/Jerusalem' },
      { utc: '2026-12-31T23:30:00.000Z', tz: 'Australia/Sydney' },
      { utc: '2026-06-08T00:00:00.000Z', tz: 'UTC' },
    ];
    for (const c of cases) {
      const local = utcIsoToLocalInputValue(c.utc, c.tz);
      expect(localInputValueToUtcIso(local, c.tz)).toBe(c.utc);
    }
  });

  it('throws on malformed input', () => {
    expect(() => localInputValueToUtcIso('garbage', 'UTC')).toThrow(/Invalid local datetime/);
    expect(() => localInputValueToUtcIso('2026-06-08', 'UTC')).toThrow(/Invalid local datetime/);
    expect(() => localInputValueToUtcIso('2026-06-08 15:00', 'UTC')).toThrow(/Invalid local datetime/);
  });

  it('handles the EST→EDT spring-forward (2026-03-08 02:00 → 03:00 NY)', () => {
    // 2026-03-08 03:00 EDT (just after spring-forward) = 07:00 UTC
    expect(localInputValueToUtcIso('2026-03-08T03:00', 'America/New_York'))
      .toBe('2026-03-08T07:00:00.000Z');
  });

  it('handles the EDT→EST fall-back (2026-11-01 02:00 NY local)', () => {
    // 2026-11-01 02:00 EST (after fall-back) = 07:00 UTC.
    // The 01:00-02:00 NY window happens twice this day; the API
    // picks one deterministically and we accept whichever it gives.
    expect(localInputValueToUtcIso('2026-11-01T02:00', 'America/New_York'))
      .toBe('2026-11-01T07:00:00.000Z');
  });
});

describe('formatLocalDate', () => {
  it('zero-pads single-digit components', () => {
    expect(formatLocalDate(2026, 1, 5, 9, 7)).toBe('2026-01-05T09:07');
  });

  it('passes through already-two-digit components', () => {
    expect(formatLocalDate(2026, 12, 31, 23, 59)).toBe('2026-12-31T23:59');
  });
});
