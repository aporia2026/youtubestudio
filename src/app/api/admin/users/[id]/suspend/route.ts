import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { findUserById, suspendUser, unsuspendUser } from '@/lib/users';
import { extractIp, writeAudit } from '@/lib/audit';

/**
 * POST /api/admin/users/[id]/suspend  body: { suspended: boolean }
 *
 * Toggle a user's suspended state. A suspended user can no longer log in
 * (the login route returns 403) and the /api/auth/me endpoint returns 401
 * to force any open tabs to redirect to /login on the next call.
 */
export const POST = apiRoute.admin(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (id === session.uid) {
      return NextResponse.json({ error: 'You cannot suspend your own account.' }, { status: 400 });
    }
    const target = await findUserById(id);
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const suspended = Boolean((body as { suspended?: unknown } | null)?.suspended);

    if (suspended) {
      await suspendUser(id);
      await writeAudit({
        actorUserId: session.uid,
        action: 'user.suspend',
        targetUserId: id,
        ipAddress: extractIp(req),
      });
    } else {
      await unsuspendUser(id);
      await writeAudit({
        actorUserId: session.uid,
        action: 'user.unsuspend',
        targetUserId: id,
        ipAddress: extractIp(req),
      });
    }
    return NextResponse.json({ ok: true });
  },
);
