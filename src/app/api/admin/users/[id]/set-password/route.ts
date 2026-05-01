import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  findUserById,
  PasswordTooShortError,
  setUserPassword,
} from '@/lib/users';
import { extractIp, writeAudit } from '@/lib/audit';

/**
 * POST /api/admin/users/[id]/set-password  body: { password: string }
 *
 * Admin-set initial / replacement password. Bypasses the email-roundtrip
 * "forgot password" flow — useful for bootstrapping users who don't have
 * email yet, or for support recovery when a user has lost access to their
 * email. The action is logged to the audit table with a `password_set` true
 * metadata flag — the password value itself is never logged.
 */
export const POST = apiRoute.admin(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const target = await findUserById(id);
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const password = typeof (body as { password?: unknown } | null)?.password === 'string'
      ? (body as { password: string }).password
      : '';

    try {
      await setUserPassword(id, password);
    } catch (err) {
      if (err instanceof PasswordTooShortError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    await writeAudit({
      actorUserId: session.uid,
      action: 'user.set_password',
      targetUserId: id,
      ipAddress: extractIp(req),
    });

    return NextResponse.json({ ok: true });
  },
);
