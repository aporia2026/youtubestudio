import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

/**
 * GET /api/shorts/inspiration?channelDbId=...&kind=top|recent&limit=N
 *
 * Phase 15.8 — feeds the Create surface's "Inspired by" + "Avoid these"
 * pickers. Reads from the existing `video_analytics` table (Phase 2.3
 * ingest) and ranks:
 *
 *   - kind='top'    — by views ÷ max(subscriber_count, 1000) so a small
 *                     channel's hits surface alongside a big channel's,
 *                     same outlier ratio used in `/cannibalization` +
 *                     `/insights/catalog`. Defaults to the last 90 days.
 *   - kind='recent' — by published_at DESC (no performance filter).
 *                     The "Avoid these — recently covered" use case.
 *
 * Workspace-scoped via video_analytics.workspace_id; cross-tenant
 * channel ids return an empty array (no info leak — same as the rest
 * of the codebase's 404-not-403 posture on resource reads).
 *
 * Limit clamped to [1, 25]. Default 8 (matches the "How many" cap on
 * the Ideas count picker).
 */
const LIMIT_MIN = 1;
const LIMIT_MAX = 25;
const LIMIT_DEFAULT = 8;

const RECENT_WINDOW_DAYS = 90;

export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const channelDbId = searchParams.get('channelDbId');
  const kind = searchParams.get('kind') === 'recent' ? 'recent' : 'top';
  const limitRaw = Number.parseInt(searchParams.get('limit') ?? `${LIMIT_DEFAULT}`, 10);
  const limit = Math.max(
    LIMIT_MIN,
    Math.min(LIMIT_MAX, Number.isFinite(limitRaw) ? limitRaw : LIMIT_DEFAULT),
  );

  if (!channelDbId) {
    return NextResponse.json({ error: 'channelDbId required' }, { status: 400 });
  }

  try {
    // Tenant gate on the channel BEFORE the join — returns empty on
    // cross-workspace so no analytics rows leak.
    const { rows: channelRows } = await sql<{ subscriber_count: number | null }>`
      SELECT subscriber_count
        FROM channels
       WHERE id = ${channelDbId}::uuid
         AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (channelRows.length === 0) {
      return NextResponse.json({ titles: [] });
    }

    if (kind === 'recent') {
      const { rows } = await sql<{ title: string | null }>`
        SELECT title
          FROM video_analytics
         WHERE workspace_id = ${session.ws}::uuid
           AND channel_id = ${channelDbId}::uuid
           AND title IS NOT NULL
         ORDER BY published_at DESC NULLS LAST, fetched_at DESC
         LIMIT ${limit}
      `;
      const titles = rows.map((r) => r.title).filter((t): t is string => !!t);
      return NextResponse.json({ titles });
    }

    // kind === 'top' — outlier-ratio over the recent window. The Math.max
    // floor on subs (1000) makes the ratio sensible for tiny channels.
    const subsFloor = Math.max(1000, channelRows[0]!.subscriber_count ?? 0);
    const { rows } = await sql<{ title: string | null }>`
      SELECT title
        FROM video_analytics
       WHERE workspace_id = ${session.ws}::uuid
         AND channel_id = ${channelDbId}::uuid
         AND title IS NOT NULL
         AND views IS NOT NULL
         AND published_at >= NOW() - INTERVAL '${RECENT_WINDOW_DAYS} days'
       ORDER BY (views::numeric / ${subsFloor}) DESC
       LIMIT ${limit}
    `;
    const titles = rows.map((r) => r.title).filter((t): t is string => !!t);
    return NextResponse.json({ titles });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: inspiration',
      fallbackMessage: 'Failed to load inspiration titles.',
    });
  }
});
