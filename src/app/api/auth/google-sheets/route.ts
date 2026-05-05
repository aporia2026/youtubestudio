import { NextResponse } from 'next/server';
import { getAuthorizationUrlForSheets } from '@/lib/google-oauth';
import { ensureGoogleAuthSchema } from '@/lib/db';
import { requireUser, SessionError } from '@/lib/session';
import { domainErrorResponse } from '@/lib/route-helpers';

export async function GET() {
  try {
    const session = await requireUser();
    await ensureGoogleAuthSchema();
    const url = await getAuthorizationUrlForSheets(session.ws);
    return NextResponse.redirect(url);
  } catch (err) {
    // Preserve bespoke SessionError → 401/403 mapping; the helper handles everything else.
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return domainErrorResponse(err, {
      op: 'auth: google-sheets oauth start',
      fallbackMessage: 'Could not start Google Sheets sign-in — please try again.',
    });
  }
}
