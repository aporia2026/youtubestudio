import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema, DEFAULT_SCHEDULE_STATUSES } from '@/lib/db';

/** GET /api/schedule/statuses?channel_id=
 *  Returns per-channel statuses, or the default global list when the channel has no config. */
export async function GET(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const { searchParams } = new URL(req.url);
    const channelId = searchParams.get('channel_id');

    if (channelId) {
      const result = await sql`
        SELECT key, label, color, position FROM channel_statuses
        WHERE channel_id = ${channelId}
        ORDER BY position
      `;
      if (result.rows.length > 0) {
        return NextResponse.json({ statuses: result.rows });
      }
    }

    // Fall back to defaults (also returned when no channel is specified).
    return NextResponse.json({ statuses: DEFAULT_SCHEDULE_STATUSES });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ statuses: DEFAULT_SCHEDULE_STATUSES });
  }
}

/** PUT /api/schedule/statuses — replace a channel's status pipeline wholesale.
 *  body: { channel_id: string, statuses: [{ key, label, color }] } */
export async function PUT(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const { channel_id, statuses } = await req.json() as {
      channel_id: string;
      statuses: Array<{ key: string; label: string; color?: string }>;
    };
    if (!channel_id) return NextResponse.json({ error: 'channel_id required' }, { status: 400 });

    await sql`DELETE FROM channel_statuses WHERE channel_id = ${channel_id}`;
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i];
      await sql`
        INSERT INTO channel_statuses (channel_id, key, label, color, position)
        VALUES (${channel_id}, ${s.key}, ${s.label}, ${s.color ?? '#7c3aed'}, ${i})
      `;
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
