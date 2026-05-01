/**
 * Next.js Edge middleware. Runs before every matching request and gates every
 * `/api/*` path behind a valid session cookie. Public API paths (auth flows,
 * token portals, the public schedule share link) are explicitly allow-listed.
 *
 * What this DOES guarantee:
 *   - Any /api/* path NOT in the allow-list returns 401 without a valid JWT
 *     in the session cookie.
 *   - The JWT must carry the new `{ uid, sysrole, ws }` claims; legacy
 *     `{ authenticated: true }` JWTs minted by the pre-Phase-1 single-password
 *     login are rejected, forcing the user to re-login as a real account.
 *
 * What this does NOT do (per-route work, follow-up):
 *   - It does not enforce workspace scoping on individual queries inside
 *     route handlers. Each handler still has to add `WHERE workspace_id = ws`
 *     to its SQL — a sweep that is mechanical but invasive across ~120 files
 *     and is therefore deliberately staged as a separate effort.
 *   - It does not check that a session's `ws` matches the resource id in the
 *     URL. A logged-in user with one workspace can still try to fetch
 *     resources by id from another workspace until the WHERE clauses land —
 *     scoping is per-query authority for now, not per-URL.
 *
 * Edge runtime constraints respected: only `jose` is used for verification
 * (Edge-compatible, no Node crypto APIs). DB-aware checks live in the route
 * handlers themselves under Node runtime.
 */
import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const SESSION_COOKIE = 'yt_studio_session';

/**
 * Allow-list of /api/* paths that are intentionally public — auth flows
 * (a logged-out user must be able to hit /api/auth/login) and token-portal
 * routes that identify the caller via a path token instead of a session.
 *
 * Order matters only for readability; the patterns are tested with `some`.
 */
export const PUBLIC_API_PATTERNS: readonly RegExp[] = [
  // All auth flows — login, OAuth callback, forgot-password etc.
  /^\/api\/auth\//,

  // Token-based portal routes (see /editor/[token], /narrator/[token],
  // /review/[token], /share/[token] page surfaces). The path's second
  // segment IS the secret; replacing it with a session would defeat the
  // "share this link" UX that PR #1's audit explicitly preserved.
  /^\/api\/editor\/[^/]+\//,
  /^\/api\/editor-dashboard\/[^/]+(\/|$)/,
  /^\/api\/narrate\/[^/]+\//,
  /^\/api\/narrator-dashboard\/[^/]+(\/|$)/,
  /^\/api\/activity\/[^/]+(\/|$)/,
  /^\/api\/collaborator-prefs\/[^/]+(\/|$)/,
  // /api/review/[token]/* — but NOT /api/review/projects/* (which is
  // session-auth'd). The negative lookahead distinguishes them.
  /^\/api\/review\/(?!projects(\/|$))[^/]+(\/|$)/,

  // Public read surfaces.
  /^\/api\/public\//,

  // Email unsubscribe links use a per-collaborator unsubscribe_token.
  /^\/api\/notifications\/unsubscribe(\/|$)/,
];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATTERNS.some((re) => re.test(pathname));
}

let _secret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (!_secret) {
    const s = process.env.AUTH_SECRET;
    if (!s) {
      // Throwing in middleware on every request would be catastrophic. The
      // session check returns false instead, and all gated routes 401 — the
      // operator notices on the first hit, not silently in production.
      throw new Error('AUTH_SECRET is not set');
    }
    _secret = new TextEncoder().encode(s);
  }
  return _secret;
}

/**
 * Lightweight session check used by the middleware. Verifies the JWT
 * signature AND the claim shape. Returns false on any failure — including
 * expired tokens, foreign signing keys, missing claims, and the legacy
 * `{authenticated:true}` payload from pre-Phase-1 sessions.
 *
 * Exported for unit testing; not used outside this file.
 */
export async function isMiddlewareSessionValid(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return (
      typeof payload.uid === 'string' &&
      payload.uid.length > 0 &&
      (payload.sysrole === 'admin' || payload.sysrole === 'user') &&
      typeof payload.ws === 'string' &&
      payload.ws.length > 0
    );
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // The matcher already restricts us to /api/* but defend against future
  // matcher changes by re-checking here.
  if (!pathname.startsWith('/api/')) return NextResponse.next();

  if (isPublicApiPath(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  let valid: boolean;
  try {
    valid = await isMiddlewareSessionValid(token ?? '');
  } catch {
    // AUTH_SECRET missing in env, etc. Fail closed: 401 every gated request
    // until the operator fixes their env. Better than silent pass-through.
    valid = false;
  }
  if (!valid) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  // Run only on /api/* paths. Static assets and page renders bypass entirely.
  matcher: ['/api/:path*'],
};
