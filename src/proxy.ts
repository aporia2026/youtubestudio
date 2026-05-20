/**
 * Next.js 16 edge proxy (formerly known as `middleware.ts` in older Next).
 * Runs before every matching request. Two responsibilities:
 *
 *   1. Page-route gate: send unauthenticated browsers to /login.
 *   2. API-route gate: return JSON 401 (not a redirect) for unauthenticated
 *      /api/* requests, so fetch() callers see an error instead of HTML.
 *
 * Public paths bypass both checks — auth flows themselves, token-portal
 * surfaces (editor / narrator / reviewer / share / unsubscribe), and the
 * public schedule-share endpoint.
 *
 * Session validity in Phase 1 means the JWT carries the new
 * { uid, sysrole, ws } claim shape. The legacy single-password
 * { authenticated: true } payload from the pre-Phase-1 deployment is
 * rejected here, forcing those users to re-login as a real account.
 *
 * Edge runtime: this file ONLY uses jose for verification; no Node crypto
 * APIs, no DB access. The /admin layout server-component does its own
 * admin role check (it has DB access), so this proxy doesn't gate on role.
 */
import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const COOKIE_NAME = 'yt_studio_session';

let _secret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (!_secret) {
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      throw new Error(
        'AUTH_SECRET environment variable is not set. Add it to your .env.local or Vercel project settings.',
      );
    }
    _secret = new TextEncoder().encode(secret);
  }
  return _secret;
}

/** Public paths matched by exact equality OR by `<path>/...` startsWith. */
const PUBLIC_PATHS: readonly string[] = [
  '/login',
  '/forgot-password',
  // Auth API surfaces — must be reachable while logged out.
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/accept-invite',
  '/api/auth/google',
  // /api/auth/google-sheets is NOT public — it must read the caller's
  // workspace from the session and bind it into the OAuth state JWT.
  // The callback below is public because the Google → app hop arrives
  // without a session cookie under SameSite=Strict (and even Lax has
  // edge cases on long redirect chains); the state JWT carries the
  // workspace forward instead.
  '/api/auth/google/callback',
  // Public share / unsubscribe surfaces.
  '/share',
  '/api/public',
  '/unsubscribe',
  '/api/notifications/unsubscribe',
  // Same-origin download proxy. Streams bytes from an allowlisted host
  // (R2 buckets we own, etc.) with `Content-Disposition: attachment` so
  // the browser saves instead of navigating. Public because the editor /
  // narrator portals — which hit it for voiceover + render downloads —
  // are themselves token-authenticated rather than session-authenticated.
  // The upstream URL is still authenticated by the presigned R2 signature
  // it carries, so this route grants no access the caller doesn't already
  // have.
  '/api/download-proxy',
];

/** Path prefixes that grant a token-portal exemption — anything matching any
 *  of these is reachable without a session. The portal endpoint authenticates
 *  the caller via a per-collaborator token in the URL, not via a cookie. */
const PUBLIC_PREFIXES: readonly string[] = [
  '/review/',
  '/narrate/',
  '/narrator/',
  '/editor/',
  '/reset-password/',
  '/accept-invite/',
  '/api/narrate/',
  '/api/narrator/',
  '/api/narrator-dashboard/',
  '/api/editor/',
  '/api/editor-dashboard/',
  '/api/activity/',
  '/api/collaborator-prefs/',
];

/**
 * Pure-logic predicate exported so tests can assert the allow-list directly
 * without spinning up a NextRequest.
 *
 * /api/review/[token]/* is a token-portal surface but /api/review/projects/*
 * is the owner-side admin surface — the two namespaces share a prefix, so we
 * match on the second path segment instead of a flat prefix.
 */
export function isPathPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) return true;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (pathname.startsWith('/api/review/')) {
    const after = pathname.slice('/api/review/'.length);
    // /api/review/projects[/...] is the owner-side admin surface — gate it.
    // Everything else under /api/review/ is the token-portal namespace.
    if (after !== 'projects' && !after.startsWith('projects/')) return true;
  }
  // Voiceover audio proxy: `/api/voiceovers/<uuid>/audio`. The UUID is
  // the access token — same posture as `/api/narrator/takes/[id]/audio`.
  // Public because server-side renderers and the alignment cache (both
  // run without the user's session cookie) fetch the same URL. The
  // sibling routes `/api/voiceovers/library` and `/api/voiceovers/align`
  // stay gated — only the `<uuid>/audio` shape matches.
  if (/^\/api\/voiceovers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/audio$/i.test(pathname)) {
    return true;
  }
  // B-roll video proxy: `/api/broll/<uuid>/video`. Same posture as the
  // voiceover audio proxy above — the random UUID is the access token,
  // and server-side renderers (Remotion local + Lambda) fetch this URL
  // without a session cookie. Without this exemption, every render
  // 401s in ~5ms and OffthreadVideo's helper proxy hangs for 28s
  // waiting for bytes that never come. Sibling routes under
  // `/api/broll/` (e.g. POST `/api/broll`, `/api/broll/<id>` metadata)
  // stay gated — only the `<uuid>/video` GET shape matches.
  if (/^\/api\/broll\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/video$/i.test(pathname)) {
    return true;
  }
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) return true;
  return false;
}

/**
 * Verify the session cookie's JWT signature AND claim shape. A token signed
 * with the right secret but missing uid / having a non-allowed sysrole / with
 * empty ws is rejected — this is what catches pre-Phase-1 sessions.
 *
 * Exported for unit testing.
 */
export async function isSessionValid(token: string | undefined): Promise<boolean> {
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

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (isPathPublic(pathname)) return NextResponse.next();

  const isApi = pathname.startsWith('/api/');
  const token = req.cookies.get(COOKIE_NAME)?.value;

  let valid: boolean;
  try {
    valid = await isSessionValid(token);
  } catch {
    // AUTH_SECRET missing / unreachable — fail closed.
    valid = false;
  }

  if (!valid) {
    if (isApi) {
      const r = NextResponse.json(
        { error: 'Session expired. Refresh the page and sign in again.' },
        { status: 401 },
      );
      // Clear the stale/legacy cookie so the next request lands logged-out
      // cleanly instead of replaying an invalid token forever.
      if (token) r.cookies.delete(COOKIE_NAME);
      return r;
    }
    const r = NextResponse.redirect(new URL('/login', req.url));
    if (token) r.cookies.delete(COOKIE_NAME);
    return r;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
