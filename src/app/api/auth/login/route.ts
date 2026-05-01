import { NextRequest, NextResponse } from 'next/server';
import { findUserByEmail, verifyPassword, markLoginSuccess } from '@/lib/users';
import { findPrimaryWorkspaceForUser } from '@/lib/workspaces';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/session';
import {
  checkAndIncrementRateLimit,
  pruneOldRateLimitBuckets,
  rateLimitHeaders,
} from '@/lib/rate-limit-db';
import { extractIp } from '@/lib/audit';

/**
 * Email + password login.
 *
 * Failure modes deliberately collapse to a single 401 with a vague message
 * to prevent email enumeration:
 *   - email unknown → 401 "Invalid email or password"
 *   - email known, password wrong → 401 (same)
 *   - email known, no password set (token-only collaborator) → 401 (same)
 * Suspended accounts return 403 with a distinct message — that's an
 * acceptable enumeration vector since being told you're suspended is itself
 * actionable for the user.
 *
 * Bcrypt cost 11 (~250ms) is the natural rate-limiter on this route until
 * PR #7 adds the Postgres-backed sliding window.
 */
export async function POST(req: NextRequest) {
  // Rate-limit gate first — counts every hit against the bucket so that even
  // 400-Bad-Request probes count toward the 10/5min/IP cap. Falls open if
  // the table is unreachable (logged but doesn't 500 the user).
  const ip = extractIp(req) || 'unknown';
  const rl = await checkAndIncrementRateLimit({
    key: `auth.login:${ip}`,
    limit: 10,
    windowMs: 5 * 60 * 1000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many sign-in attempts. Try again in a few minutes.' },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  // Best-effort cleanup of stale rate-limit buckets. Cheap (one DELETE per
  // request) and prevents the table from growing unboundedly under heavy
  // traffic; pruneOldRateLimitBuckets never throws so a slow DELETE can't
  // block the login. Buckets older than 7 days are well past the 5-minute
  // window — safe to drop.
  void pruneOldRateLimitBuckets(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: rateLimitHeaders(rl) });
  }

  const { email, password } =
    typeof body === 'object' && body !== null
      ? (body as { email?: unknown; password?: unknown })
      : {};

  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return NextResponse.json(
      { error: 'Email and password are required' },
      { status: 400, headers: rateLimitHeaders(rl) },
    );
  }

  // Constant-ish-time path: even on unknown email we still call verifyPassword
  // against a synthetic hash so the timing of failed-login attempts looks
  // identical regardless of whether the email exists.
  const user = await findUserByEmail(email);
  const passwordOk = await verifyPassword(
    password,
    user?.password_hash ?? '$2b$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva',
  );

  if (!user || !user.password_hash || !passwordOk) {
    return NextResponse.json(
      { error: 'Invalid email or password' },
      { status: 401, headers: rateLimitHeaders(rl) },
    );
  }

  if (user.status === 'suspended') {
    return NextResponse.json(
      { error: 'This account is suspended. Contact your administrator.' },
      { status: 403, headers: rateLimitHeaders(rl) },
    );
  }

  const workspace = await findPrimaryWorkspaceForUser(user.id);
  if (!workspace) {
    return NextResponse.json(
      {
        error:
          'Your account exists but isn’t a member of any workspace. Ask an administrator to add you.',
      },
      { status: 403, headers: rateLimitHeaders(rl) },
    );
  }

  const token = await createSession({
    uid: user.id,
    sysrole: user.system_role,
    ws: workspace.id,
  });

  await markLoginSuccess(user.id);

  const response = NextResponse.json({ ok: true }, { headers: rateLimitHeaders(rl) });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  });
  return response;
}
