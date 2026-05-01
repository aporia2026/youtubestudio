import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { findUserById } from '@/lib/users';

/**
 * GET /api/auth/me — return the currently signed-in user.
 *
 * Strips secret columns (password_hash, encrypted_settings, invite_token,
 * password_reset_token + their expiries) before returning. Callers use this
 * to render the user's name / avatar / role in the chrome.
 *
 * 401 if no session OR if the session points at a user that no longer
 * exists / is suspended (treat as unauthenticated to force re-login).
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const user = await findUserById(session.uid);
  if (!user || user.status === 'suspended') {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    system_role: user.system_role,
    status: user.status,
    color: user.color,
    role: user.role,
    workspace_id: session.ws,
    last_login_at: user.last_login_at,
  });
}
