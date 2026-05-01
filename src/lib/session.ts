/**
 * The Phase 1 session module.
 *
 * Replaces the legacy single-password session (src/lib/auth.ts) with a
 * per-user JWT carrying `{ uid, sysrole, ws }`. The cookie name is unchanged
 * (`yt_studio_session`) so legacy sessions verify cleanly under the old
 * `getSession()` boolean signature in auth.ts during the migration window —
 * but legacy sessions lack the new claims, so any new code that calls
 * `requireUser` here will correctly reject them and force a re-login.
 *
 * No DB I/O happens in this module. The only check on every request is JWT
 * signature + claim shape. Suspended-user revocation is best-effort via a
 * separate fresh-check helper added later (status flips don't invalidate
 * existing tokens until they expire — acceptable for Phase 1 since the
 * /admin "sign out all" button can rotate AUTH_SECRET to nuke every session
 * if needed).
 */
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

export const SESSION_COOKIE_NAME = 'yt_studio_session';
const SESSION_TTL = '30d';

export type SystemRole = 'admin' | 'user';

export interface SessionPayload {
  /** Collaborators.id — the authenticated user's UUID. */
  uid: string;
  /** System-level role (admin gates `/admin`). */
  sysrole: SystemRole;
  /** Primary workspace id. The route layer scopes every query by this. */
  ws: string;
}

let _secret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (!_secret) {
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      throw new Error(
        'AUTH_SECRET environment variable is not set. ' +
          'Add it to .env.local or Vercel project settings.',
      );
    }
    _secret = new TextEncoder().encode(secret);
  }
  return _secret;
}

/** For tests only — drop the cached secret so a new one can be picked up. */
export function _resetSecretCacheForTests(): void {
  _secret = null;
}

/** Sign a session token. Issued at = now, expires in 30 days. */
export async function createSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ uid: payload.uid, sysrole: payload.sysrole, ws: payload.ws })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(getSecret());
}

/** Verify a token and return its payload, or null if invalid / wrong shape. */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (
      typeof payload.uid === 'string' &&
      payload.uid.length > 0 &&
      (payload.sysrole === 'admin' || payload.sysrole === 'user') &&
      typeof payload.ws === 'string' &&
      payload.ws.length > 0
    ) {
      return { uid: payload.uid, sysrole: payload.sysrole, ws: payload.ws };
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the session cookie and verify. Returns null if missing or invalid. */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/**
 * Thrown by `requireUser` / `requireAdmin` when the caller fails the gate.
 * Route handlers should catch this and turn it into a JSON response with the
 * embedded status. (PR #4 wraps that into `withErrorHandler` so individual
 * routes don't have to.)
 */
export class SessionError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/** Throw 401 if there is no valid session, otherwise return its payload. */
export async function requireUser(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new SessionError(401, 'Authentication required');
  return session;
}

/** Throw 401 / 403 if the session is missing or not an admin. */
export async function requireAdmin(): Promise<SessionPayload> {
  const session = await requireUser();
  if (session.sysrole !== 'admin') throw new SessionError(403, 'Admin access required');
  return session;
}
