import { NextRequest, NextResponse } from 'next/server';
import { getValidSheetsToken } from '@/lib/google-oauth';
import { createScheduleSheet, type ScheduleSheetInput } from '@/lib/google-sheets-schedule';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { ensureGoogleAuthSchema, ensureScheduleSchema } from '@/lib/db';
import { requireUser, SessionError } from '@/lib/session';

export const maxDuration = 60;

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    const { limited } = checkRateLimit(`schedule-sheets:${getClientIP(req)}`, 10, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    let body: { exportData?: ScheduleSheetInput };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { exportData } = body;
    if (!exportData?.items?.length) {
      return NextResponse.json({ error: 'exportData with items is required' }, { status: 400 });
    }
    if (!Array.isArray(exportData.items) || !Array.isArray(exportData.statuses) || typeof exportData.scopeLabel !== 'string') {
      return NextResponse.json({ error: 'Invalid exportData shape' }, { status: 400 });
    }
    // Spot-check the first item's shape — a full schema check isn't worth the lines.
    const first = exportData.items[0] as Record<string, unknown>;
    if (typeof first.id !== 'string' || typeof first.title !== 'string') {
      return NextResponse.json({ error: 'Invalid item shape' }, { status: 400 });
    }

    await ensureScheduleSchema();
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

    const { spreadsheetId, sheetUrl } = await createScheduleSheet(token, exportData);
    return NextResponse.json({ spreadsheetId, sheetUrl });
  } catch (err: unknown) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('Schedule Sheets export error:', err);
    const msg = err instanceof Error ? err.message : 'Export failed';
    if (msg.startsWith('NEEDS_REAUTH')) {
      return NextResponse.json({ error: 'NEEDS_REAUTH', message: msg.replace('NEEDS_REAUTH: ', '') }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
