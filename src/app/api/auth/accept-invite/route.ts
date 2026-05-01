import { NextRequest, NextResponse } from 'next/server';
import { consumeInviteToken, PasswordTooShortError, markLoginSuccess } from '@/lib/users';
import { findPrimaryWorkspaceForUser } from '@/lib/workspaces';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/session';

/**
 * POST /api/auth/accept-invite
 *
 * Body: { token, password }
 *
 * The user's first login. Atomically consumes the invite, sets their initial
 * password, marks the account active, and issues a session cookie so they
 * land logged-in on the dashboard.
 *
 * Returns 401 on bad/expired token (same response shape as other auth
 * routes so a probing client cannot distinguish the failure modes).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { token, password } = typeof body === 'object' && body !== null
    ? (body as { token?: unknown; password?: unknown })
    : {};

  if (typeof token !== 'string' || !token || typeof password !== 'string') {
    return NextResponse.json({ error: 'Token and password are required' }, { status: 400 });
  }

  let user;
  try {
    user = await consumeInviteToken(token, password);
  } catch (err) {
    if (err instanceof PasswordTooShortError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  if (!user) {
    return NextResponse.json(
      { error: 'This invitation is invalid or has expired.' },
      { status: 401 },
    );
  }

  const workspace = await findPrimaryWorkspaceForUser(user.id);
  if (!workspace) {
    return NextResponse.json(
      {
        error:
          'Your account is set up but no workspace membership was found. Ask the administrator to add you.',
      },
      { status: 403 },
    );
  }

  const sessionToken = await createSession({
    uid: user.id,
    sysrole: user.system_role,
    ws: workspace.id,
  });
  await markLoginSuccess(user.id);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
  return response;
}
