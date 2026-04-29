import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { expandRecurrence, type RecurrenceRule } from '@/lib/schedule';

async function attachChannels(itemId: string, channelIds: string[]): Promise<void> {
  if (!channelIds.length) return;
  await sql.query(
    `INSERT INTO schedule_item_channels (item_id, channel_id)
     SELECT $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [itemId, channelIds],
  );
}

/** GET /api/schedule?channel_id=&from=&to=&status=&search= */
export async function GET(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const { searchParams } = new URL(req.url);
    const channelId = searchParams.get('channel_id');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const status = searchParams.get('status');
    const search = searchParams.get('search');

    // Compose with query builder since @vercel/postgres `sql` tag doesn't interpolate clauses.
    const clauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (channelId) {
      clauses.push(`EXISTS (SELECT 1 FROM schedule_item_channels sic WHERE sic.item_id = si.id AND sic.channel_id = $${idx}::uuid)`);
      values.push(channelId);
      idx++;
    }
    if (from) {
      clauses.push(`si.scheduled_for >= $${idx}::timestamptz`);
      values.push(from); idx++;
    }
    if (to) {
      clauses.push(`si.scheduled_for <= $${idx}::timestamptz`);
      values.push(to); idx++;
    }
    if (status) {
      clauses.push(`si.status = $${idx}`);
      values.push(status); idx++;
    }
    if (search) {
      clauses.push(`(si.title ILIKE $${idx} OR si.notes ILIKE $${idx})`);
      values.push(`%${search}%`); idx++;
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await sql.query(
      `SELECT si.*,
              COALESCE(
                (SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'account_color', c.account_color))
                 FROM schedule_item_channels sic
                 JOIN channels c ON c.id = sic.channel_id
                 WHERE sic.item_id = si.id),
                '[]'::json
              ) AS channels
       FROM schedule_items si
       ${where}
       ORDER BY si.scheduled_for NULLS LAST, si.position, si.created_at DESC`,
      values,
    );
    return NextResponse.json({ items: rows });
  } catch (err) {
    console.error('GET /api/schedule error:', err);
    return NextResponse.json({ items: [] });
  }
}

/** POST /api/schedule — create one item, or expand a recurrence into many. */
export async function POST(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const body = await req.json();
    const {
      title = '',
      scheduled_for = null,
      status = 'idea',
      notes = null,
      tags = [],
      custom_fields = {},
      idea_id = null,
      project_id = null,
      script_id = null,
      channel_ids = [],
      recurrence = null,
      from_idea = null,
    }: {
      title?: string;
      scheduled_for?: string | null;
      status?: string;
      notes?: string | null;
      tags?: string[];
      custom_fields?: Record<string, unknown>;
      idea_id?: string | null;
      project_id?: string | null;
      script_id?: string | null;
      channel_ids?: string[];
      recurrence?: RecurrenceRule | null;
      from_idea?: { id: string; title: string } | null;
    } = body;

    let resolvedTitle = title;
    let resolvedIdeaId = idea_id;
    if (from_idea) {
      resolvedIdeaId = from_idea.id;
      if (!resolvedTitle) resolvedTitle = from_idea.title;
    }

    // If recurrence is set + scheduled_for present, create parent + children.
    if (recurrence && scheduled_for) {
      const dates = expandRecurrence(new Date(scheduled_for), recurrence);
      const parent = await sql`
        INSERT INTO schedule_items (title, scheduled_for, status, notes, tags, custom_fields, idea_id, project_id, script_id, recurrence)
        VALUES (${resolvedTitle}, ${dates[0] ?? scheduled_for}, ${status}, ${notes},
                ${JSON.stringify(tags)}, ${JSON.stringify(custom_fields)},
                ${resolvedIdeaId}, ${project_id}, ${script_id},
                ${JSON.stringify(recurrence)})
        RETURNING id
      `;
      const parentId = parent.rows[0].id as string;
      await attachChannels(parentId, channel_ids);
      // Children (skip the first date — that's the parent)
      for (const iso of dates.slice(1)) {
        const child = await sql`
          INSERT INTO schedule_items (title, scheduled_for, status, notes, tags, custom_fields, recurrence_parent_id)
          VALUES (${resolvedTitle}, ${iso}, ${status}, ${notes},
                  ${JSON.stringify(tags)}, ${JSON.stringify(custom_fields)}, ${parentId})
          RETURNING id
        `;
        await attachChannels(child.rows[0].id as string, channel_ids);
      }
      return NextResponse.json({ id: parentId, expanded: dates.length });
    }

    const result = await sql`
      INSERT INTO schedule_items (title, scheduled_for, status, notes, tags, custom_fields, idea_id, project_id, script_id)
      VALUES (${resolvedTitle}, ${scheduled_for}, ${status}, ${notes},
              ${JSON.stringify(tags)}, ${JSON.stringify(custom_fields)},
              ${resolvedIdeaId}, ${project_id}, ${script_id})
      RETURNING *
    `;
    const itemId = result.rows[0].id as string;
    await attachChannels(itemId, channel_ids);
    return NextResponse.json({ item: result.rows[0] });
  } catch (err) {
    console.error('POST /api/schedule error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
