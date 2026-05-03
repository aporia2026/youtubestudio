import { NextRequest, NextResponse } from 'next/server';
import { getValidSheetsToken } from '@/lib/google-oauth';
import { createProductionDocSheet, SheetsExportInput } from '@/lib/google-sheets';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { ensureGoogleAuthSchema } from '@/lib/db';
import { requireUser, SessionError } from '@/lib/session';
import { logger } from '@/lib/logger';

export const maxDuration = 60;

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    const { limited } = checkRateLimit(`sheets-export:${getClientIP(req)}`, 10, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    let body: { exportData?: SheetsExportInput };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { exportData } = body;
    if (!exportData?.rows?.length) {
      return NextResponse.json({ error: 'exportData with rows is required' }, { status: 400 });
    }

    await ensureGoogleAuthSchema();
    const tokenResult = await getValidSheetsToken(session.ws);
    if (!tokenResult) {
      return NextResponse.json(
        { error: 'NEEDS_GOOGLE_AUTH', message: 'Connect your Google account in Settings to export to Sheets.' },
        { status: 401 },
      );
    }

    const { token, scopes } = tokenResult;
    if (!scopes.includes(SHEETS_SCOPE)) {
      return NextResponse.json(
        { error: 'NEEDS_REAUTH', message: 'Your Google account does not have Sheets access. Reconnect in Settings → Google Account.' },
        { status: 403 },
      );
    }

    const { spreadsheetId, sheetUrl } = await createProductionDocSheet(token, exportData);
    return NextResponse.json({ spreadsheetId, sheetUrl });
  } catch (err: unknown) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('Google Sheets export error', { detail: err instanceof Error ? err.message : String(err) });
    const msg = err instanceof Error ? err.message : 'Export failed';
    if (msg.startsWith('NEEDS_REAUTH')) {
      return NextResponse.json({ error: 'NEEDS_REAUTH', message: msg.replace('NEEDS_REAUTH: ', '') }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
