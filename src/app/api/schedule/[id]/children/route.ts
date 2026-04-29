import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { expandRecurrence } from '@/lib/schedule';

/** DELETE /api/schedule/[id]/children — remove only recurrence children, preserve the parent. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    const { rowCount } = await sql`DELETE FROM schedule_items WHERE recurrence_parent_id = ${id}`;
    return NextResponse.json({ removed: rowCount });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

function isRecurrenceRule(x: unknown): x is import('@/lib/schedule').RecurrenceRule {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return r.freq === 'DAILY' || r.freq === 'WEEKLY' || r.freq === 'MONTHLY';
}

/** POST /api/schedule/[id]/children — expand the parent's recurrence rule into fresh children
 *  (does NOT delete existing children; call DELETE first if you want a clean regenerate). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return expandChildren(await params);
}

/** PUT /api/schedule/[id]/children — delete existing children + re-expand in one request.
 *  Used by the "Regenerate" button so the client never leaves a half-regenerated state. */
export async function PUT(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const p = await params;
  try {
    await ensureScheduleSchema();
    await sql`DELETE FROM schedule_items WHERE recurrence_parent_id = ${p.id}`;
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to remove old children' }, { status: 500 });
  }
  return expandChildren(p);
}

async function expandChildren({ id }: { id: string }) {
  try {
    await ensureScheduleSchema();
    const parent = await sql`SELECT * FROM schedule_items WHERE id = ${id}`;
    if (!parent.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const p = parent.rows[0];
    if (!isRecurrenceRule(p.recurrence) || !p.scheduled_for) {
      return NextResponse.json({ error: 'Parent has no valid recurrence or start date' }, { status: 400 });
    }

    const channelRows = await sql`SELECT channel_id FROM schedule_item_channels WHERE item_id = ${id}`;
    const channelIds = channelRows.rows.map(r => r.channel_id as string);

    const dates = expandRecurrence(new Date(p.scheduled_for), p.recurrence);
    let created = 0;
    // Skip dates[0] — that's the parent's own date.
    for (const iso of dates.slice(1)) {
      const child = await sql`
        INSERT INTO schedule_items (title, scheduled_for, status, notes, tags, custom_fields, recurrence_parent_id)
        VALUES (${p.title}, ${iso}, ${p.status}, ${p.notes},
                ${JSON.stringify(p.tags ?? [])}, ${JSON.stringify(p.custom_fields ?? {})}, ${id})
        RETURNING id
      `;
      const cid = child.rows[0].id as string;
      if (channelIds.length > 0) {
        await sql.query(
          `INSERT INTO schedule_item_channels (item_id, channel_id)
           SELECT $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [cid, channelIds],
        );
      }
      created++;
    }
    return NextResponse.json({ created });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
