/**
 * Magic-link emails — invite acceptance and password reset.
 *
 * Both flows are intentionally narrow: the email contains exactly one link
 * that lands on a single-purpose page. The token in the URL is the plaintext
 * one-shot token; its sha-256 hash is what's stored in the DB so a database
 * dump is useless to an attacker.
 *
 * Tone is plain text-y / conservative — these are auth emails, not marketing.
 * Tracking pixels and click-tracking are disabled at the email.ts boundary.
 */
import { sendEmail, getAppUrl, type SendEmailResult } from './email';

interface CommonContext {
  recipientName: string;
  recipientEmail: string;
}

export async function sendInviteEmail(
  ctx: CommonContext & { token: string; expiresAt: Date; inviterName?: string },
): Promise<SendEmailResult> {
  const url = `${getAppUrl()}/accept-invite/${encodeURIComponent(ctx.token)}`;
  const expires = ctx.expiresAt.toISOString().replace('T', ' ').replace(/\..+$/, ' UTC');
  const inviterLine = ctx.inviterName
    ? `${escapeHtml(ctx.inviterName)} has invited you`
    : `You've been invited`;
  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #0f172a; background: #f8fafc;">
  <div style="background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
    <h1 style="font-size: 20px; margin: 0 0 12px;">You're invited to YT Studio</h1>
    <p style="margin: 0 0 16px; line-height: 1.5;">Hi ${escapeHtml(ctx.recipientName)},</p>
    <p style="margin: 0 0 20px; line-height: 1.5;">
      ${inviterLine} to join YT Studio. Click below to set your password and sign in.
    </p>
    <p style="margin: 24px 0;">
      <a href="${url}"
         style="display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">
        Accept invitation
      </a>
    </p>
    <p style="margin: 0 0 8px; font-size: 13px; color: #64748b; line-height: 1.5;">
      This invitation expires on <strong>${expires}</strong>.
    </p>
    <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
      If the button doesn't work, paste this link into your browser:<br>
      <span style="word-break: break-all;">${url}</span>
    </p>
  </div>
  <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 16px 0 0;">
    If you didn't expect this email, you can safely ignore it.
  </p>
</body></html>
  `.trim();

  return sendEmail({
    to: ctx.recipientEmail,
    subject: `You're invited to YT Studio`,
    html,
  });
}

export async function sendPasswordResetEmail(
  ctx: CommonContext & { token: string; expiresAt: Date },
): Promise<SendEmailResult> {
  const url = `${getAppUrl()}/reset-password/${encodeURIComponent(ctx.token)}`;
  const minutes = Math.max(1, Math.round((ctx.expiresAt.getTime() - Date.now()) / 60000));
  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #0f172a; background: #f8fafc;">
  <div style="background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
    <h1 style="font-size: 20px; margin: 0 0 12px;">Reset your YT Studio password</h1>
    <p style="margin: 0 0 16px; line-height: 1.5;">Hi ${escapeHtml(ctx.recipientName)},</p>
    <p style="margin: 0 0 20px; line-height: 1.5;">
      Click below to choose a new password. This link expires in <strong>${minutes} minute${minutes === 1 ? '' : 's'}</strong>.
    </p>
    <p style="margin: 24px 0;">
      <a href="${url}"
         style="display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">
        Reset password
      </a>
    </p>
    <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
      If the button doesn't work, paste this link into your browser:<br>
      <span style="word-break: break-all;">${url}</span>
    </p>
  </div>
  <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 16px 0 0;">
    If you didn't request this, you can ignore the email — your password won't change.
  </p>
</body></html>
  `.trim();

  return sendEmail({
    to: ctx.recipientEmail,
    subject: `Reset your YT Studio password`,
    html,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
