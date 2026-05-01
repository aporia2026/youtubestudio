import { describe, expect, it } from 'vitest';
import { rateLimitHeaders, windowStartFor, type RateLimitResult } from '@/lib/rate-limit-db';

describe('windowStartFor', () => {
  it('floors to the nearest multiple of windowMs from epoch', () => {
    const w = 60_000; // 1 minute
    // 2026-05-01 12:34:56.789 UTC
    const t = Date.parse('2026-05-01T12:34:56.789Z');
    const start = windowStartFor(t, w);
    expect(start.toISOString()).toBe('2026-05-01T12:34:00.000Z');
  });

  it('returns the same window for two timestamps within it', () => {
    const w = 5 * 60_000;
    const t1 = Date.parse('2026-05-01T12:30:00.000Z');
    const t2 = Date.parse('2026-05-01T12:34:59.999Z');
    expect(windowStartFor(t1, w).getTime()).toBe(windowStartFor(t2, w).getTime());
  });

  it('rolls to the next window at the boundary', () => {
    const w = 60_000;
    const a = windowStartFor(Date.parse('2026-05-01T12:34:59.999Z'), w);
    const b = windowStartFor(Date.parse('2026-05-01T12:35:00.000Z'), w);
    expect(b.getTime() - a.getTime()).toBe(60_000);
  });
});

describe('rateLimitHeaders', () => {
  it('emits the three RateLimit-* headers per draft-ietf-httpapi-ratelimit', () => {
    const result: RateLimitResult = {
      ok: true,
      remaining: 7,
      count: 3,
      limit: 10,
      resetAt: new Date(Date.now() + 60_000),
    };
    const headers = rateLimitHeaders(result);
    expect(headers['RateLimit-Limit']).toBe('10');
    expect(headers['RateLimit-Remaining']).toBe('7');
    const reset = Number(headers['RateLimit-Reset']);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(60);
  });

  it('clamps RateLimit-Reset to 0 if the resetAt is in the past', () => {
    const result: RateLimitResult = {
      ok: false,
      remaining: 0,
      count: 11,
      limit: 10,
      resetAt: new Date(Date.now() - 1000),
    };
    expect(rateLimitHeaders(result)['RateLimit-Reset']).toBe('0');
  });
});
