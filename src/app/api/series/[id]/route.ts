import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureSeriesSchema } from '@/lib/db';

/** GET /api/series/:id — series metadata plus all parts (scripts + ideas + schedule items). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureSeriesSchema();
    const seriesRes = await sql`SELECT * FROM series WHERE id = ${id}::uuid`;
    if (!seriesRes.rows.length) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const scripts = await sql`
      SELECT id, part_number, word_count, estimated_duration_seconds, ai_model,
             created_at, series_summary, project_id
      FROM scripts
      WHERE series_id = ${id}::uuid
      ORDER BY part_number ASC NULLS LAST, created_at ASC
    `;
    const ideas = await sql`
      SELECT id, title, hook, description, part_number, created_at
      FROM video_ideas
      WHERE series_id = ${id}::uuid
      ORDER BY part_number ASC NULLS LAST, created_at ASC
    `;
    const scheduleItems = await sql`
      SELECT id, title, scheduled_for, status, part_number, created_at
      FROM schedule_items
      WHERE series_id = ${id}::uuid
      ORDER BY part_number ASC NULLS LAST, scheduled_for ASC NULLS LAST
    `;
    return NextResponse.json({
      series: seriesRes.rows[0],
      scripts: scripts.rows,
      ideas: ideas.rows,
      scheduleItems: scheduleItems.rows,
    });
  } catch (err) {
    console.error('GET /api/series/:id error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

/** PATCH /api/series/:id — update title/description/etc. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureSeriesSchema();
    const patch = await req.json();
    const title = patch.title !== undefined ? patch.title : null;
    const niche = patch.niche !== undefined ? patch.niche : null;
    const description = patch.description !== undefined ? patch.description : null;
    const totalPartsPlanned = patch.totalPartsPlanned !== undefined ? patch.totalPartsPlanned : null;
    const channelId = patch.channelId !== undefined ? patch.channelId : null;

    const result = await sql`
      UPDATE series SET
        title = COALESCE(${title}, title),
        niche = COALESCE(${niche}, niche),
        description = COALESCE(${description}, description),
        total_parts_planned = COALESCE(${totalPartsPlanned}, total_parts_planned),
        channel_id = COALESCE(${channelId}::uuid, channel_id),
        updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING *
    `;
    if (!result.rows.length) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ series: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/series/:id error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

/** DELETE /api/series/:id — delete the series. Linked rows keep their content
 *  but have series_id set to NULL (via the FK's ON DELETE SET NULL). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureSeriesSchema();
    await sql`DELETE FROM series WHERE id = ${id}::uuid`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/series/:id error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
