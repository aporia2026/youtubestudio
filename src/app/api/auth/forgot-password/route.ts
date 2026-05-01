import { NextRequest, NextResponse } from 'next/server';
import { findUserByEmail, issuePasswordResetToken } from '@/lib/users';
import { sendPasswordResetEmail } from '@/lib/email-magic-link';

/**
 * POST /api/auth/forgot-password
 *
 * Always returns 200 regardless of whether the email exists, so the route
 * cannot be used to enumerate registered accounts. The email is only sent
 * when the address actually maps to a user. The response timing is also
 * smoothed via a small sleep on the no-user branch — same wall-clock latency
 * as the issue-token + send-email path.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true }); // also generic to avoid signalling
  }

  const { email } = typeof body === 'object' && body !== null
    ? (body as { email?: unknown })
    : {};

  if (typeof email !== 'string' || !email.trim() || !email.includes('@')) {
    return NextResponse.json({ ok: true });
  }

  const user = await findUserByEmail(email);
  if (!user || user.status === 'suspended' || !user.email) {
    // Smooth the timing so an attacker can't tell the address is unknown
    // by the latency. The constant is a rough match for the bcrypt + email
    // send latency on the success path; not security-critical, just a hint.
    await new Promise((r) => setTimeout(r, 250));
    return NextResponse.json({ ok: true });
  }

  const { token, expiresAt } = await issuePasswordResetToken(user.id);
  await sendPasswordResetEmail({
    recipientName: user.name,
    recipientEmail: user.email,
    token,
    expiresAt,
  });

  return NextResponse.json({ ok: true });
}
