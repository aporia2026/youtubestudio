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
];

// Paths that bypass auth entirely (public review pages + their API endpoints)
const PUBLIC_PREFIXES = ['/review/', '/narrate/'];

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

  // Allow static files
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;

  if (!token) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  try {
    await jwtVerify(token, getSecret());
    return NextResponse.next();
  } catch {
    const response = NextResponse.redirect(new URL('/login', req.url));
    response.cookies.delete(COOKIE_NAME);
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
