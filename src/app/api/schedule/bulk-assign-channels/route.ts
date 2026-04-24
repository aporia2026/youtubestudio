import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';

/** POST /api/schedule/bulk-assign-channels
 *  Body: { item_ids: string[], channel_ids: string[], mode: 'add' | 'replace' }
 *
 *  - add:     attach each channel to each item, leaving existing links intact.
 *  - replace: set each item's channel set to exactly `channel_ids` (delete the rest).
 *
 *  Single-statement upsert pattern per item so a crash mid-batch doesn't leave
 *  partially-assigned rows.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const body = await req.json().catch(() => ({}));
    const itemIds: string[] = Array.isArray(body.item_ids) ? body.item_ids : [];
    const channelIds: string[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
    const mode: 'add' | 'replace' = body.mode === 'replace' ? 'replace' : 'add';

    if (itemIds.length === 0) {
      return NextResponse.json({ error: 'item_ids is required' }, { status: 400 });
    }
    if (mode === 'add' && channelIds.length === 0) {
      return NextResponse.json({ error: 'channel_ids is required for add mode' }, { status: 400 });
    }

    for (const itemId of itemIds) {
      if (mode === 'replace') {
        await sql.query(
          `WITH new_ids AS (SELECT unnest($2::uuid[]) AS cid),
                pruned AS (
                  DELETE FROM schedule_item_channels
                  WHERE item_id = $1::uuid
                    AND channel_id NOT IN (SELECT cid FROM new_ids)
                )
           INSERT INTO schedule_item_channels (item_id, channel_id)
           SELECT $1::uuid, cid FROM new_ids
           ON CONFLICT DO NOTHING`,
          [itemId, channelIds],
        );
      } else {
        // add-only — leave existing assignments, just upsert new ones
        await sql.query(
          `INSERT INTO schedule_item_channels (item_id, channel_id)
           SELECT $1::uuid, unnest($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [itemId, channelIds],
        );
      }
    }

    return NextResponse.json({ updated: itemIds.length });
  } catch (err) {
    console.error('POST /api/schedule/bulk-assign-channels', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
