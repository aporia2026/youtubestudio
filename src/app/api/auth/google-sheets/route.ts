import { NextResponse } from 'next/server';
import { getAuthorizationUrlForSheets } from '@/lib/google-oauth';
import { ensureGoogleAuthSchema } from '@/lib/db';

export async function GET() {
  try {
    await ensureGoogleAuthSchema();
    const url = await getAuthorizationUrlForSheets();
    return NextResponse.redirect(url);
  } catch (err: unknown) {
    console.error('Google Sheets OAuth initiation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to start OAuth' },
      { status: 500 },
    );
  }
}
