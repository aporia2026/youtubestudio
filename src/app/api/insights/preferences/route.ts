import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

/**
 * GET /api/insights/preferences
 *   → { enabled: boolean, email_recipients: string|null }
 * POST /api/insights/preferences
 *   body: { enabled?: boolean, email_recipients?: string|null }
 *
 * Phase 9.6 — workspace-level opt-in for the weekly insight digest.
 * Surfaced inline on `/insights/[week]` so users can toggle without
 * leaving the page; the same backend underpins any future settings-
 * page toggle.
 */
export const GET = apiRoute.authed(async (session) => {
  const { rows } = await sql<{
    weekly_digest_enabled: boolean;
    weekly_digest_email_recipients: string | null;
  }>`
    SELECT weekly_digest_enabled, weekly_digest_email_recipients
      FROM workspaces
     WHERE id = ${session.ws}::uuid
     LIMIT 1
  `;
  const row = rows[0] ?? { weekly_digest_enabled: false, weekly_digest_email_recipients: null };
  return NextResponse.json({
    enabled: row.weekly_digest_enabled,
    email_recipients: row.weekly_digest_email_recipients,
  });
});

const EMAIL_LIST_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?:\s*,\s*[\w.+-]+@[\w-]+(?:\.[\w-]+)+)*$/;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const enabled = typeof b.enabled === 'boolean' ? b.enabled : null;
  const recipientsRaw =
    b.email_recipients === null
      ? null
      : typeof b.email_recipients === 'string'
        ? b.email_recipients.trim()
        : undefined; // means "leave unchanged"

  // Validate the email list when provided + non-empty. NULL or empty
  // string is a valid "clear the override" signal.
  if (recipientsRaw && recipientsRaw.length > 0 && !EMAIL_LIST_RE.test(recipientsRaw)) {
    return NextResponse.json(
      { error: 'email_recipients must be a comma-separated list of valid email addresses.' },
      { status: 400 },
    );
  }
  if (recipientsRaw && recipientsRaw.length > 1024) {
    return NextResponse.json({ error: 'email_recipients exceeds 1KB cap.' }, { status: 400 });
  }

  try {
    if (enabled !== null && recipientsRaw !== undefined) {
      await sql`
        UPDATE workspaces
           SET weekly_digest_enabled = ${enabled},
               weekly_digest_email_recipients = ${recipientsRaw && recipientsRaw.length > 0 ? recipientsRaw : null}
         WHERE id = ${session.ws}::uuid
      `;
    } else if (enabled !== null) {
      await sql`
        UPDATE workspaces
           SET weekly_digest_enabled = ${enabled}
         WHERE id = ${session.ws}::uuid
      `;
    } else if (recipientsRaw !== undefined) {
      await sql`
        UPDATE workspaces
           SET weekly_digest_email_recipients = ${recipientsRaw && recipientsRaw.length > 0 ? recipientsRaw : null}
         WHERE id = ${session.ws}::uuid
      `;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'insights: preferences',
      fallbackMessage: 'Could not save preferences — please try again.',
    });
  }
});
