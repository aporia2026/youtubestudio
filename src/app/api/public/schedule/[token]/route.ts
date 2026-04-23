import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';

/** GET /api/public/schedule/[token] — read-only data for a share link.
 *  Validates the token, checks expiry, and returns items scoped to the linked channel
 *  (or all items if channel_id is null on the token). Intentionally minimal fields. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    await ensureScheduleSchema();
    const tokenRow = await sql`
      SELECT channel_id, label, expires_at
      FROM schedule_share_tokens
      WHERE token = ${token}
      LIMIT 1
    `;
    if (!tokenRow.rows.length) return NextResponse.json({ error: 'Invalid token' }, { status: 404 });
    const { channel_id, label, expires_at } = tokenRow.rows[0];
    if (expires_at && new Date(expires_at) < new Date()) {
      return NextResponse.json({ error: 'Expired' }, { status: 410 });
    }

    const channel = channel_id
      ? await sql`SELECT id, name, account_color FROM channels WHERE id = ${channel_id}`
      : { rows: [] as Array<{ id: string; name: string; account_color: string | null }> };

    const items = channel_id
      ? await sql`
          SELECT si.id, si.title, si.scheduled_for, si.status, si.notes, si.tags,
                 COALESCE(
                   (SELECT json_agg(json_build_object('name', c.name, 'account_color', c.account_color))
                    FROM schedule_item_channels sic JOIN channels c ON c.id = sic.channel_id
                    WHERE sic.item_id = si.id),
                   '[]'::json
                 ) AS channels
          FROM schedule_items si
          JOIN schedule_item_channels sic ON sic.item_id = si.id
          WHERE sic.channel_id = ${channel_id}
          ORDER BY si.scheduled_for NULLS LAST
        `
      : await sql`
          SELECT si.id, si.title, si.scheduled_for, si.status, si.notes, si.tags,
                 COALESCE(
                   (SELECT json_agg(json_build_object('name', c.name, 'account_color', c.account_color))
                    FROM schedule_item_channels sic JOIN channels c ON c.id = sic.channel_id
                    WHERE sic.item_id = si.id),
                   '[]'::json
                 ) AS channels
          FROM schedule_items si
          ORDER BY si.scheduled_for NULLS LAST
        `;

    return NextResponse.json({
      label,
      channel: channel.rows[0] ?? null,
      items: items.rows,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
