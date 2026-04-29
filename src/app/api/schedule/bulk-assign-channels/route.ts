import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

// Hard ceilings so a runaway client (or a crafted request) can't pin a DB
// connection for minutes. Tuned generously for a solo-creator with a huge
// backlog — raise if that's ever not enough.
const MAX_ITEM_IDS = 500;
const MAX_CHANNEL_IDS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function allUuids(xs: unknown[]): xs is string[] {
  return xs.every(x => typeof x === 'string' && UUID_RE.test(x));
}

/** POST /api/schedule/bulk-assign-channels
 *  Body: {
 *    item_ids: string[],
 *    channel_ids: string[],
 *    mode: 'add' | 'replace',
 *    allow_clear?: boolean   // required for mode='replace' with empty channel_ids
 *  }
 *
 *  - add:     attach each channel to each item, leaving existing links intact.
 *  - replace: set each item's channel set to exactly `channel_ids`. Empty
 *             `channel_ids` un-assigns everything — guarded behind
 *             `allow_clear: true` because it's destructive.
 */
export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`bulk-assign:${getClientIP(req)}`, 30, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    await ensureScheduleSchema();
    const body = await req.json().catch(() => ({}));
    const itemIds: unknown[] = Array.isArray(body.item_ids) ? body.item_ids : [];
    const channelIds: unknown[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
    const mode: 'add' | 'replace' = body.mode === 'replace' ? 'replace' : 'add';
    const allowClear: boolean = body.allow_clear === true;

    if (itemIds.length === 0) {
      return NextResponse.json({ error: 'item_ids is required' }, { status: 400 });
    }
    if (itemIds.length > MAX_ITEM_IDS) {
      return NextResponse.json({ error: `item_ids exceeds ${MAX_ITEM_IDS}` }, { status: 400 });
    }
    if (channelIds.length > MAX_CHANNEL_IDS) {
      return NextResponse.json({ error: `channel_ids exceeds ${MAX_CHANNEL_IDS}` }, { status: 400 });
    }
    if (!allUuids(itemIds)) {
      return NextResponse.json({ error: 'item_ids must all be valid UUIDs' }, { status: 400 });
    }
    if (!allUuids(channelIds)) {
      return NextResponse.json({ error: 'channel_ids must all be valid UUIDs' }, { status: 400 });
    }
    if (mode === 'add' && channelIds.length === 0) {
      return NextResponse.json({ error: 'channel_ids is required for add mode' }, { status: 400 });
    }
    if (mode === 'replace' && channelIds.length === 0 && !allowClear) {
      return NextResponse.json({
        error: 'replace mode with empty channel_ids would un-assign all selected items — pass allow_clear:true to confirm',
      }, { status: 400 });
    }

    if (mode === 'replace') {
      // Single statement: delete every join row for the targeted items whose
      // channel_id isn't in the new set, then upsert the new set for each item.
      // O(items × channels) rows processed in one round-trip instead of N.
      await sql.query(
        `WITH
           items AS (SELECT unnest($1::uuid[]) AS item_id),
           channels AS (SELECT unnest($2::uuid[]) AS channel_id),
           pruned AS (
             DELETE FROM schedule_item_channels sic
             WHERE sic.item_id IN (SELECT item_id FROM items)
               AND sic.channel_id NOT IN (SELECT channel_id FROM channels)
           )
         INSERT INTO schedule_item_channels (item_id, channel_id)
         SELECT i.item_id, c.channel_id
         FROM items i CROSS JOIN channels c
         ON CONFLICT DO NOTHING`,
        [itemIds, channelIds],
      );
    } else {
      // add-only — single statement for the whole batch.
      await sql.query(
        `INSERT INTO schedule_item_channels (item_id, channel_id)
         SELECT i.item_id, c.channel_id
         FROM unnest($1::uuid[]) AS i(item_id)
         CROSS JOIN unnest($2::uuid[]) AS c(channel_id)
         ON CONFLICT DO NOTHING`,
        [itemIds, channelIds],
      );
    }

    return NextResponse.json({ updated: itemIds.length });
  } catch (err) {
    console.error('POST /api/schedule/bulk-assign-channels', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
