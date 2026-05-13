import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { ensureGoogleAuthSchema } from '@/lib/db';
import { getValidSheetsToken } from '@/lib/google-oauth';
import { createFavoritesSheet } from '@/lib/google-sheets-favorites';
import { buildCompareInput } from '@/lib/niche-finder/favorites-sheets-export';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export const maxDuration = 60;

/**
 * POST /api/niche-finder/favorites/export-compare-sheet
 *   Body: { slugs: string[] }   // 2–3 niche slugs to compare
 *   → { spreadsheetId, sheetUrl }
 *
 * Side-by-side Compare export. Same template as the single export but
 * with the selected favorites — the Summary sheet treats each niche
 * as a row (so the operator can scan across) and the Briefs sheet
 * keeps the full memos for deep reading.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited } = checkRateLimit(
    `favorites-sheet-compare:${getClientIP(req)}`,
    10,
    60_000,
  );
  if (limited) {
    return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });
  }

  let body: { slugs?: unknown };
  try {
    body = (await req.json()) as { slugs?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const slugsRaw = body.slugs;
  if (
    !Array.isArray(slugsRaw) ||
    slugsRaw.length < 2 ||
    slugsRaw.length > 3 ||
    !slugsRaw.every((s) => typeof s === 'string' && s.length > 0)
  ) {
    return NextResponse.json(
      { error: 'slugs must be an array of 2–3 non-empty strings' },
      { status: 400 },
    );
  }
  const slugs = slugsRaw as string[];

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
    const input = await buildCompareInput(session.ws, slugs);
    if (!input) {
      return NextResponse.json(
        { error: 'One or more favorites not found.' },
        { status: 404 },
      );
    }
    const { spreadsheetId, sheetUrl } = await createFavoritesSheet(tokenResult.token, input);
    return NextResponse.json({ spreadsheetId, sheetUrl });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: favorites export-sheet (compare)',
      fallbackMessage: 'Sheets export failed — please try again.',
      knownPatterns: [{ match: /NEEDS_REAUTH/, status: 403 }],
    });
  }
});
