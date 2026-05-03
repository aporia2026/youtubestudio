import { NextResponse } from 'next/server';
import { getSheetsAccountInfo, deleteSheetsTokens } from '@/lib/google-oauth';
import { ensureGoogleAuthSchema } from '@/lib/db';
import { requireUser, SessionError } from '@/lib/session';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const session = await requireUser();
    await ensureGoogleAuthSchema();
    const info = await getSheetsAccountInfo(session.ws);
    if (!info) return NextResponse.json({ connected: false });
    return NextResponse.json({ connected: true, email: info.email, scopes: info.scopes });
  } catch (err) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('Google account status error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ connected: false });
  }
}

export async function DELETE() {
  try {
    const session = await requireUser();
    await deleteSheetsTokens(session.ws);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('Google account disconnect error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
