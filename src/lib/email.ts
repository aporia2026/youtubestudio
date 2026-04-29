import sgMail from '@sendgrid/mail';

let _initialized = false;
let _warnedNoKey = false;
let _warnedNoFrom = false;

function initSendGrid(): boolean {
  if (_initialized) return true;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) {
    if (!_warnedNoKey) {
      console.warn('[email] SENDGRID_API_KEY not set — emails will be skipped');
      _warnedNoKey = true;
    }
    return false;
  }
  sgMail.setApiKey(key);
  _initialized = true;
  return true;
}

function getFromAddress(): string | null {
  const from = process.env.SENDGRID_FROM_EMAIL;
  if (!from) {
    if (!_warnedNoFrom) {
      console.warn('[email] SENDGRID_FROM_EMAIL not set — emails will be skipped. Set it to a verified single sender (e.g. yoavm7@gmail.com).');
      _warnedNoFrom = true;
    }
    return null;
  }
  return from;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  id?: string;
  error?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  if (!params.to || !params.to.includes('@')) {
    return { ok: false, skipped: true, reason: 'no recipient' };
  }
  if (!initSendGrid()) return { ok: false, skipped: true, reason: 'no api key' };
  const from = getFromAddress();
  if (!from) return { ok: false, skipped: true, reason: 'no from address' };

  // Strip HTML tags for plain-text fallback if not provided
  const plainText = params.text || params.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  try {
    const [response] = await sgMail.send({
      from: { email: from, name: 'YT Studio' },
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: plainText,
      replyTo: params.replyTo,
      // Disable SendGrid's tracking pixels/click tracking — they look spammy and break links
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
        openTracking: { enable: false },
      },
    });
    const id = response?.headers?.['x-message-id'] as string | undefined;
    return { ok: true, id };
  } catch (e) {
    // SendGrid throws an error with .response.body containing detail
    const err = e as { message?: string; response?: { body?: { errors?: Array<{ message?: string }> } } };
    const detail = err?.response?.body?.errors?.[0]?.message || err?.message || 'unknown error';
    console.error('[email] SendGrid send failed:', detail);
    return { ok: false, error: detail };
  }
}

/** Get the public-facing app URL used to build action links in emails. */
export function getAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.NEXT_PUBLIC_VERCEL_URL && `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`) ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    'http://localhost:3000'
  );
}
