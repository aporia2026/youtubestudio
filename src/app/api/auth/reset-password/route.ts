import { NextRequest, NextResponse } from 'next/server';
import { consumePasswordResetToken, PasswordTooShortError } from '@/lib/users';

/**
 * POST /api/auth/reset-password
 *
 * Body: { token, password }
 *   token — the plaintext one-shot token from the URL.
 *   password — the new password the user has chosen.
 *
 * Atomically consumes the reset token and sets the password. Returns 200
 * on success, 400 on a too-short password, and 401 on an invalid or
 * expired token (deliberately the same response so a probing client can't
 * tell which).
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

  try {
    const user = await consumePasswordResetToken(token, password);
    if (!user) {
      return NextResponse.json(
        { error: 'This reset link is invalid or has expired.' },
        { status: 401 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PasswordTooShortError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
