/**
 * Simple in-memory rate limiter for API routes.
 * Tracks requests per IP within a sliding window.
 * Resets automatically — no external dependencies needed.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Check if a request should be rate limited.
 * @param key - Unique identifier (usually IP + route)
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Time window in milliseconds
 * @returns { limited: boolean, remaining: number, resetIn: number }
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { limited: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, remaining: maxRequests - 1, resetIn: windowMs };
  }

  entry.count++;
  const remaining = Math.max(0, maxRequests - entry.count);
  const resetIn = entry.resetAt - now;

  if (entry.count > maxRequests) {
    return { limited: true, remaining: 0, resetIn };
  }

  return { limited: false, remaining, resetIn };
}

/**
 * Extract client IP from request headers.
 *
 * On Vercel, the proxy appends the real client IP as the LAST entry in
 * X-Forwarded-For (any earlier values come from the client and can be
 * forged: `X-Forwarded-For: 1.1.1.1, attacker.com`). Reading the first
 * entry — as we used to — let an attacker split per-IP rate-limit
 * counters across forged values.
 *
 * Prefer Vercel's tamper-resistant `x-vercel-forwarded-for` header
 * when present; fall back to the LAST entry in `x-forwarded-for`,
 * then `x-real-ip`. Cloudflare deployments should inspect
 * `cf-connecting-ip` first if put behind CF.
 */
export function getClientIP(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();

  const vercel = req.headers.get('x-vercel-forwarded-for');
  if (vercel) {
    // x-vercel-forwarded-for is a single trustworthy IP set by Vercel's edge.
    return vercel.split(',')[0].trim();
  }

  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    // Last entry is the one appended by the closest trusted proxy.
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}
