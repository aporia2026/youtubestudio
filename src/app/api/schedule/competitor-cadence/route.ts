import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';

/** GET /api/schedule/competitor-cadence?from=&to=
 *  Returns competitor upload events within a date range so the calendar can
 *  ghost them on top of the user's own schedule. */
export async function GET(req: NextRequest) {
  try {
    await ensureCompetitorSchema();
    const from = req.nextUrl.searchParams.get('from');
    const to = req.nextUrl.searchParams.get('to');

    const rows = from && to
      ? await sql`
          SELECT cv.published_at, cv.title, cv.view_count, cc.title AS channel_name, cv.outlier_score
          FROM competitor_videos cv
          JOIN competitor_channels cc ON cc.id = cv.competitor_id
          WHERE cv.published_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz
          ORDER BY cv.published_at ASC
          LIMIT 500
        `
      : await sql`
          SELECT cv.published_at, cv.title, cv.view_count, cc.title AS channel_name, cv.outlier_score
          FROM competitor_videos cv
          JOIN competitor_channels cc ON cc.id = cv.competitor_id
          WHERE cv.published_at >= NOW() - INTERVAL '90 days'
          ORDER BY cv.published_at ASC
          LIMIT 500
        `;

    return NextResponse.json({ events: rows.rows });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ events: [] });
  }
}
