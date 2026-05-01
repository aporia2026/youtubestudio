import { NextRequest, NextResponse } from 'next/server';
import { findUserByEmail, verifyPassword, markLoginSuccess } from '@/lib/users';
import { findPrimaryWorkspaceForUser } from '@/lib/workspaces';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/session';

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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { email, password } =
    typeof body === 'object' && body !== null
      ? (body as { email?: unknown; password?: unknown })
      : {};

  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
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
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  if (user.status === 'suspended') {
    return NextResponse.json(
      { error: 'This account is suspended. Contact your administrator.' },
      { status: 403 },
    );
  }

  const workspace = await findPrimaryWorkspaceForUser(user.id);
  if (!workspace) {
    return NextResponse.json(
      {
        error:
          'Your account exists but isn’t a member of any workspace. Ask an administrator to add you.',
      },
      { status: 403 },
    );
  }

  const token = await createSession({
    uid: user.id,
    sysrole: user.system_role,
    ws: workspace.id,
  });

  await markLoginSuccess(user.id);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  });
  return response;
}
