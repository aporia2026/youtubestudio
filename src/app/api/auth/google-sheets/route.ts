import { NextResponse } from 'next/server';
import { getAuthorizationUrlForSheets } from '@/lib/google-oauth';
import { ensureGoogleAuthSchema } from '@/lib/db';
import { requireUser, SessionError } from '@/lib/session';

export async function GET() {
  try {
    const session = await requireUser();
    await ensureGoogleAuthSchema();
    const url = await getAuthorizationUrlForSheets(session.ws);
    return NextResponse.redirect(url);
  } catch (err: unknown) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('Google Sheets OAuth initiation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to start OAuth' },
      { status: 500 },
    );
  }
}
