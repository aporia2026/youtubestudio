import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureSeriesSchema } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

/** GET /api/series — list all series ordered by most recently updated.
 *  `part_count` is MAX(part_number) across all three part-bearing tables
 *  (scripts, video_ideas, schedule_items) so the SeriesPicker's "next part"
 *  auto-suggestion is correct even when earlier parts live as ideas or
 *  calendar items that haven't been scripted yet. */
export async function GET(req: NextRequest) {
  try {
    await ensureSeriesSchema();
    const { searchParams } = new URL(req.url);
    const niche = searchParams.get('niche');
    const channelId = searchParams.get('channel_id');

    const where: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (niche) { where.push(`s.niche = $${i++}`); values.push(niche); }
    if (channelId) { where.push(`s.channel_id = $${i++}::uuid`); values.push(channelId); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await sql.query(
      `SELECT s.*,
              GREATEST(
                COALESCE((SELECT MAX(part_number) FROM scripts        WHERE series_id = s.id), 0),
                COALESCE((SELECT MAX(part_number) FROM video_ideas    WHERE series_id = s.id), 0),
                COALESCE((SELECT MAX(part_number) FROM schedule_items WHERE series_id = s.id), 0)
              )::int AS part_count
       FROM series s
       ${whereClause}
       ORDER BY s.updated_at DESC`,
      values,
    );

    return NextResponse.json({ series: result.rows });
  } catch (err) {
    logger.error('GET /api/series error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ series: [] });
  }
}

/** POST /api/series — create a new series in the caller's workspace.
 *  Authed because `series` is a root tenant table and workspace_id is
 *  NOT NULL post the multi-tenant rollout. */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  try {
    await ensureSeriesSchema();
    const { title, niche, description, totalPartsPlanned, channelId } = await req.json();
    if (!title || typeof title !== 'string' || !title.trim()) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }
    const result = await sql`
      INSERT INTO series (title, niche, description, total_parts_planned, channel_id, workspace_id)
      VALUES (
        ${title.trim()},
        ${niche || null},
        ${description || null},
        ${totalPartsPlanned || null},
        ${channelId || null},
        ${session.ws}::uuid
      )
      RETURNING *
    `;
    return NextResponse.json({ series: result.rows[0] });
  } catch (err) {
    logger.error('POST /api/series error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to create series' }, { status: 500 });
  }
});
