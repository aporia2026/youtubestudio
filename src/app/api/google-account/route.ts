import { NextResponse } from 'next/server';
import { getSheetsAccountInfo, deleteSheetsTokens } from '@/lib/google-oauth';
import { ensureGoogleAuthSchema } from '@/lib/db';

export async function GET() {
  try {
    await ensureGoogleAuthSchema();
    const info = await getSheetsAccountInfo();
    if (!info) return NextResponse.json({ connected: false });
    return NextResponse.json({ connected: true, email: info.email, scopes: info.scopes });
  } catch (err) {
    console.error('Google account status error:', err);
    return NextResponse.json({ connected: false });
  }
}

export async function DELETE() {
  try {
    await deleteSheetsTokens();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Google account disconnect error:', err);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
