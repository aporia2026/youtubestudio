import { NextRequest, NextResponse } from 'next/server';
import { getValidAccessToken } from '@/lib/google-oauth';
import { createProductionDocSheet, SheetsExportInput } from '@/lib/google-sheets';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export const maxDuration = 60;

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`sheets-export:${getClientIP(req)}`, 10, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    let body: { channelId?: string; exportData?: SheetsExportInput };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { channelId, exportData } = body;

    if (!channelId) {
      return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
    }
    if (!exportData?.rows?.length) {
      return NextResponse.json({ error: 'exportData with rows is required' }, { status: 400 });
    }

    // Get access token with scope information
    const tokenResult = await getValidAccessToken(channelId, true);
    if (!tokenResult) {
      return NextResponse.json(
        { error: 'No connected Google account found for this channel. Please connect via OAuth first.' },
        { status: 401 },
      );
    }

    const { token, scopes } = tokenResult;

    // Check if Sheets scope is present (user may have authorized before we added it)
    if (!scopes.includes(SHEETS_SCOPE)) {
      return NextResponse.json(
        {
          error: 'NEEDS_REAUTH',
          message: 'Your Google account does not have Sheets access yet. Please re-authorize your channel to add Google Sheets permissions.',
        },
        { status: 403 },
      );
    }

    const { spreadsheetId, sheetUrl } = await createProductionDocSheet(token, exportData);

    return NextResponse.json({ spreadsheetId, sheetUrl });
  } catch (err: unknown) {
    console.error('Google Sheets export error:', err);
    const msg = err instanceof Error ? err.message : 'Export failed';

    // Surface re-auth requirement clearly
    if (msg.startsWith('NEEDS_REAUTH')) {
      return NextResponse.json(
        { error: 'NEEDS_REAUTH', message: msg.replace('NEEDS_REAUTH: ', '') },
        { status: 403 },
      );
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
