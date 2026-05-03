import { NextRequest, NextResponse } from 'next/server';
import { getNotificationSettings } from '@/lib/notifications-db';
import { sendEmail, getAppUrl } from '@/lib/email';
import { testEmailTemplate } from '@/lib/email-templates';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest) {
  try {
    // Allow optional override email via body, otherwise use the saved owner email
    const body = await req.json().catch(() => ({}));
    const settings = await getNotificationSettings();
    const to = body.to || settings.owner_email;

    if (!to) {
      return NextResponse.json({ error: 'No owner email set. Save your email first.' }, { status: 400 });
    }

    const tpl = testEmailTemplate({ appUrl: getAppUrl() });
    const result = await sendEmail({ to, subject: tpl.subject, html: tpl.html });

    if (result.skipped) {
      return NextResponse.json({
        sent: false,
        skipped: true,
        reason: result.reason,
        message: result.reason === 'no api key'
          ? 'SENDGRID_API_KEY is not set. Add it to your Vercel env vars.'
          : result.reason === 'no from address'
            ? 'SENDGRID_FROM_EMAIL is not set. Add a verified sender address (e.g. yoavm7@gmail.com).'
            : 'Email skipped',
      }, { status: 200 });
    }
    if (!result.ok) {
      return NextResponse.json({ sent: false, error: result.error }, { status: 502 });
    }
    return NextResponse.json({ sent: true, to, id: result.id });
  } catch (err) {
    logger.error('test notification error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to send test email' }, { status: 500 });
  }
}
