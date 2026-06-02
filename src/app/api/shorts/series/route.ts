import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import {
  SHORTS_SERIES_LIMITS,
  createSeries,
  listSeries,
  normalizeOptionalText,
  validateLockedStyleId,
  validateSeriesName,
} from '@/lib/shorts-series';

/**
 * GET  /api/shorts/series           — list this workspace's series
 * POST /api/shorts/series           — create a new series
 */
export const GET = apiRoute.authed(async (session) => {
  try {
    const series = await listSeries(session.ws);
    return NextResponse.json({ series });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: list series',
      fallbackMessage: 'Failed to load Shorts series.',
    });
  }
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: {
    name?: unknown;
    locked_style_id?: unknown;
    cadence?: unknown;
    channel_db_id?: unknown;
    intro_text?: unknown;
    outro_text?: unknown;
    notes?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = validateSeriesName(body.name);
  if (!name) {
    return NextResponse.json(
      { error: `name required (1-${SHORTS_SERIES_LIMITS.MAX_NAME_CHARS} chars)` },
      { status: 400 },
    );
  }
  const lockedStyleId = validateLockedStyleId(body.locked_style_id);
  if (!lockedStyleId) {
    return NextResponse.json(
      { error: 'locked_style_id must reference a registered Short style.' },
      { status: 400 },
    );
  }

  const channelDbId =
    typeof body.channel_db_id === 'string' && body.channel_db_id.trim().length > 0
      ? body.channel_db_id.trim()
      : null;

  try {
    const series = await createSeries({
      workspaceId: session.ws,
      name,
      lockedStyleId,
      cadence: normalizeOptionalText(body.cadence, SHORTS_SERIES_LIMITS.MAX_CADENCE_CHARS),
      channelDbId,
      introText: normalizeOptionalText(body.intro_text, SHORTS_SERIES_LIMITS.MAX_INTRO_OUTRO_CHARS),
      outroText: normalizeOptionalText(body.outro_text, SHORTS_SERIES_LIMITS.MAX_INTRO_OUTRO_CHARS),
      notes: normalizeOptionalText(body.notes, SHORTS_SERIES_LIMITS.MAX_NOTES_CHARS),
    });
    logger.info('[shorts series create]', {
      workspaceId: session.ws,
      seriesId: series.id,
    });
    return NextResponse.json({ series }, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: create series',
      knownPatterns: [
        { match: /already exists/i, status: 409 },
      ],
      fallbackMessage: 'Failed to create the Shorts series.',
    });
  }
});
