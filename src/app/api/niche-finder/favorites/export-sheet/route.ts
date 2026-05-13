import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { ensureGoogleAuthSchema } from '@/lib/db';
import { getValidSheetsToken } from '@/lib/google-oauth';
import { createFavoritesSheet } from '@/lib/google-sheets-favorites';
import { buildAllFavoritesInput } from '@/lib/niche-finder/favorites-sheets-export';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export const maxDuration = 60;

/**
 * POST /api/niche-finder/favorites/export-sheet
 *   → { spreadsheetId, sheetUrl }
 *
 * Exports every live favorite in the workspace as a 2- or 3-sheet
 * Google Sheets workbook: Summary (with inline thumbnails) + Briefs +
 * (when applicable) Proof Videos. Mirrors the auth + rate-limit shape
 * of the production-doc Sheets export.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited } = checkRateLimit(`favorites-sheet:${getClientIP(req)}`, 10, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });
  }

  await ensureGoogleAuthSchema();
  const tokenResult = await getValidSheetsToken(session.ws);
  if (!tokenResult) {
    return NextResponse.json(
      { error: 'NEEDS_GOOGLE_AUTH', message: 'Connect your Google account in Settings to export to Sheets.' },
      { status: 401 },
    );
  }
  if (!tokenResult.scopes.includes(SHEETS_SCOPE)) {
    return NextResponse.json(
      {
        error: 'NEEDS_REAUTH',
        message: 'Your Google account does not have Sheets access. Reconnect in Settings → Google Account.',
      },
      { status: 403 },
    );
  }

  try {
    const input = await buildAllFavoritesInput(session.ws);
    if (input.favorites.length === 0) {
      return NextResponse.json(
        { error: 'No favorites to export. Save a niche or video first.' },
        { status: 400 },
      );
    }
    const { spreadsheetId, sheetUrl } = await createFavoritesSheet(tokenResult.token, input);
    return NextResponse.json({ spreadsheetId, sheetUrl });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: favorites export-sheet (all)',
      fallbackMessage: 'Sheets export failed — please try again.',
      knownPatterns: [{ match: /NEEDS_REAUTH/, status: 403 }],
    });
  }
});
