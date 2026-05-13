import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { ensureGoogleAuthSchema } from '@/lib/db';
import { getValidSheetsToken } from '@/lib/google-oauth';
import { createFavoritesSheet } from '@/lib/google-sheets-favorites';
import { buildSingleFavoriteInput } from '@/lib/niche-finder/favorites-sheets-export';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export const maxDuration = 60;

/**
 * POST /api/niche-finder/favorites/[slug]/export-sheet
 *   → { spreadsheetId, sheetUrl }
 *
 * Exports a single favorite + its proof videos + its active brief
 * as a compact Sheets workbook (Summary + Briefs sheets only — the
 * Proof Videos sheet is omitted in single mode since the same data
 * is right there on the Summary row).
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;
    const { limited } = checkRateLimit(
      `favorites-sheet-single:${getClientIP(req)}`,
      10,
      60_000,
    );
    if (limited) {
      return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });
    }

    await ensureGoogleAuthSchema();
    const tokenResult = await getValidSheetsToken(session.ws);
    if (!tokenResult) {
      return NextResponse.json(
        {
          error: 'NEEDS_GOOGLE_AUTH',
          message: 'Connect your Google account in Settings to export to Sheets.',
        },
        { status: 401 },
      );
    }
    if (!tokenResult.scopes.includes(SHEETS_SCOPE)) {
      return NextResponse.json(
        {
          error: 'NEEDS_REAUTH',
          message:
            'Your Google account does not have Sheets access. Reconnect in Settings → Google Account.',
        },
        { status: 403 },
      );
    }

    try {
      const input = await buildSingleFavoriteInput(session.ws, slug);
      if (!input) {
        return NextResponse.json({ error: 'Favorite not found' }, { status: 404 });
      }
      const { spreadsheetId, sheetUrl } = await createFavoritesSheet(tokenResult.token, input);
      return NextResponse.json({ spreadsheetId, sheetUrl });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'niche-finder: favorites export-sheet (single)',
        fallbackMessage: 'Sheets export failed — please try again.',
        knownPatterns: [{ match: /NEEDS_REAUTH/, status: 403 }],
      });
    }
  },
);
