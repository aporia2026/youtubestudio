import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

let _secret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (!_secret) {
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error('AUTH_SECRET environment variable is not set. Add it to your .env.local or Vercel project settings.');
    _secret = new TextEncoder().encode(secret);
  }
  return _secret;
}
const COOKIE_NAME = 'yt_studio_session';

const PUBLIC_PATHS = [
  '/login', '/api/auth/login', '/api/auth/logout', '/api/auth/google/callback',
  // Public schedule share tokens — readable without session when a valid token is provided.
  '/share', '/api/public',
  // Public unsubscribe link from emails (token-based)
  '/unsubscribe', '/api/notifications/unsubscribe',
];

// Paths that bypass auth entirely (public review pages + their API endpoints)
const PUBLIC_PREFIXES = [
  '/review/',
  '/narrate/',
  '/narrator/',
  '/api/narrate/',
  '/api/narrator/',
  '/api/narrator-dashboard/',
  '/editor/',
  '/api/editor-dashboard/',
  '/api/editor/',
  // Personal-token-authenticated endpoints used from collaborator dashboards.
  '/api/activity/',
  '/api/collaborator-prefs/',
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths (exact match or startsWith for /login page)
  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  // Allow public review pages and their token-based API endpoints
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Token-side review API routes (`/api/review/<token>/...`) are public —
  // they authenticate via the share-link token, not a session cookie.
  // BUT `/api/review/projects/<id>/...` is the owner-side admin surface and
  // MUST stay auth-gated. The two namespaces share a prefix, so we match
  // on the second path segment instead of relying on a flat prefix list.
  if (pathname.startsWith('/api/review/') && !pathname.startsWith('/api/review/projects/')) {
    return NextResponse.next();
  }

  // Allow static files
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;

  // For API routes, return a JSON 401 instead of a 30x redirect to /login.
  // fetch() transparently follows the redirect — the browser then sees 200 OK
  // with the login page HTML, and our streaming/JSON consumers happily parse
  // login HTML as if it were data. A 401 with a clear error body lets the
  // client surface 'session expired' and stop trying to read the body as
  // script content.
  const isApi = pathname.startsWith('/api/');

  if (!token) {
    if (isApi) {
      return NextResponse.json(
        { error: 'Session expired. Refresh the page and sign in again.' },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  try {
    await jwtVerify(token, getSecret());
    return NextResponse.next();
  } catch {
    if (isApi) {
      const response = NextResponse.json(
        { error: 'Session expired. Refresh the page and sign in again.' },
        { status: 401 },
      );
      response.cookies.delete(COOKIE_NAME);
      return response;
    }
    const response = NextResponse.redirect(new URL('/login', req.url));
    response.cookies.delete(COOKIE_NAME);
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
