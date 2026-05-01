import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { findUserById, issueInviteToken } from '@/lib/users';
import { sendInviteEmail } from '@/lib/email-magic-link';
import { extractIp, writeAudit } from '@/lib/audit';

/**
 * POST /api/admin/users/[id]/issue-invite
 *
 * Re-issue an invite-token email to a user. Useful when the original invite
 * expired (7-day TTL) or the user lost the email. Generates a fresh token,
 * stores its hash, emails the link. The previous invite token (if any) is
 * implicitly invalidated by the overwrite.
 */
export const POST = apiRoute.admin(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const user = await findUserById(id);
    if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!user.email) {
      return NextResponse.json(
        { error: 'User has no email address. Set one first.' },
        { status: 400 },
      );
    }

    const { token, expiresAt } = await issueInviteToken(id);
    const result = await sendInviteEmail({
      recipientName: user.name,
      recipientEmail: user.email,
      token,
      expiresAt,
    });

    await writeAudit({
      actorUserId: session.uid,
      action: 'user.issue_invite',
      targetUserId: id,
      metadata: { email_ok: result.ok, email_skipped: result.skipped ?? false },
      ipAddress: extractIp(req),
    });

    return NextResponse.json({
      ok: true,
      email_sent: result.ok,
      email_skipped: result.skipped ?? false,
    });
  },
);
