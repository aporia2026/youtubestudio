import { describe, expect, it } from 'vitest';
import { rateLimitHeaders, windowStartFor, type RateLimitResult } from '@/lib/rate-limit-db';
import { getClientIP } from '@/lib/rate-limit';

function makeReq(headers: Record<string, string>): Request {
  return new Request('http://localhost/anything', { headers });
}

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

describe('getClientIP', () => {
  it('prefers cf-connecting-ip when present (Cloudflare)', () => {
    const req = makeReq({
      'cf-connecting-ip': '203.0.113.5',
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      'x-real-ip': '9.9.9.9',
    });
    expect(getClientIP(req)).toBe('203.0.113.5');
  });

  it('falls back to x-vercel-forwarded-for when no Cloudflare header', () => {
    const req = makeReq({
      'x-vercel-forwarded-for': '198.51.100.7',
      'x-forwarded-for': 'attacker.example.com, 10.0.0.1',
    });
    expect(getClientIP(req)).toBe('198.51.100.7');
  });

  it('uses the LAST entry of x-forwarded-for (proxy-appended, not client-supplied)', () => {
    // Attacker forges the leading entry; Vercel appends the real IP at the end.
    const req = makeReq({ 'x-forwarded-for': '1.1.1.1, attacker.com, 192.0.2.42' });
    expect(getClientIP(req)).toBe('192.0.2.42');
  });

  it('handles a single-entry x-forwarded-for', () => {
    const req = makeReq({ 'x-forwarded-for': '203.0.113.99' });
    expect(getClientIP(req)).toBe('203.0.113.99');
  });

  it('falls through to x-real-ip when no XFF/Vercel/CF header', () => {
    const req = makeReq({ 'x-real-ip': '10.20.30.40' });
    expect(getClientIP(req)).toBe('10.20.30.40');
  });

  it('returns "unknown" when no headers are set', () => {
    expect(getClientIP(makeReq({}))).toBe('unknown');
  });

  it('trims whitespace around the resolved IP', () => {
    const req = makeReq({ 'x-forwarded-for': '1.1.1.1 ,  2.2.2.2  ' });
    expect(getClientIP(req)).toBe('2.2.2.2');
  });

  it('ignores empty entries in x-forwarded-for', () => {
    const req = makeReq({ 'x-forwarded-for': ', , 192.0.2.10, ' });
    expect(getClientIP(req)).toBe('192.0.2.10');
  });
});
