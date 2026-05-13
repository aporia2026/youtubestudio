import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// Hard ceilings so a runaway client can't pin a DB connection for minutes.
// Tuned for a solo-creator with a huge backlog — mirror the schedule endpoint.
const MAX_ITEM_IDS = 500;
const MAX_CHANNEL_IDS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function allUuids(xs: unknown[]): xs is string[] {
  return xs.every((x) => typeof x === 'string' && UUID_RE.test(x));
}

/** POST /api/projects/bulk-assign-channels
 *  Body: {
 *    item_ids: string[],       // project ids
 *    channel_ids: string[],    // channel ids to (add | replace) per project
 *    mode: 'add' | 'replace',
 *    allow_clear?: boolean     // required for mode='replace' with empty channel_ids
 *  }
 *
 *  Shape and CTE pattern intentionally mirror
 *  /api/schedule/bulk-assign-channels. Project artifacts (scripts,
 *  voiceovers, B-roll, critics, reviews, narrator takes, shorts) inherit
 *  the assignment transitively via their parent project — see
 *  `_plans/2026-05-13-channel-assignment-everywhere.md`.
 */
export const POST = apiRoute.authed(async (session, req) => {
  const { limited } = checkRateLimit(`bulk-assign:${getClientIP(req)}`, 30, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });
  }

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
    return NextResponse.json(
      {
        error:
          'replace mode with empty channel_ids would un-assign all selected projects — pass allow_clear:true to confirm',
      },
      { status: 400 },
    );
  }

  // Workspace verification — every id MUST belong to the caller's workspace.
  // Reject the whole request if a single id is foreign; no partial writes.
  // SELECT counts beat ANY-EXISTS because we want to report which array is
  // wrong — a foreign channel id and a foreign project id are different
  // operator mistakes.
  const projCheck = await sql.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM projects
       WHERE id = ANY($1::uuid[]) AND workspace_id = $2::uuid`,
    [itemIds, session.ws],
  );
  if (parseInt(projCheck.rows[0]!.n, 10) !== itemIds.length) {
    return NextResponse.json(
      { error: 'one or more item_ids do not belong to your workspace' },
      { status: 403 },
    );
  }
  if (channelIds.length > 0) {
    const chanCheck = await sql.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM channels
         WHERE id = ANY($1::uuid[]) AND workspace_id = $2::uuid`,
      [channelIds, session.ws],
    );
    if (parseInt(chanCheck.rows[0]!.n, 10) !== channelIds.length) {
      return NextResponse.json(
        { error: 'one or more channel_ids do not belong to your workspace' },
        { status: 403 },
      );
    }
  }

  try {
    if (mode === 'replace') {
      // One round-trip: drop join rows for these projects whose channel
      // isn't in the new set, then upsert the cross-product. The DELETE
      // sits inside a CTE so the INSERT sees the same statement-level
      // snapshot — no race against itself.
      await sql.query(
        `WITH
           items AS (SELECT unnest($1::uuid[]) AS project_id),
           channels AS (SELECT unnest($2::uuid[]) AS channel_id),
           pruned AS (
             DELETE FROM project_channels pc
             WHERE pc.project_id IN (SELECT project_id FROM items)
               AND pc.channel_id NOT IN (SELECT channel_id FROM channels)
           )
         INSERT INTO project_channels (project_id, channel_id)
         SELECT i.project_id, c.channel_id
         FROM items i CROSS JOIN channels c
         ON CONFLICT DO NOTHING`,
        [itemIds, channelIds],
      );
    } else {
      // add-only — single statement.
      await sql.query(
        `INSERT INTO project_channels (project_id, channel_id)
         SELECT i.project_id, c.channel_id
         FROM unnest($1::uuid[]) AS i(project_id)
         CROSS JOIN unnest($2::uuid[]) AS c(channel_id)
         ON CONFLICT DO NOTHING`,
        [itemIds, channelIds],
      );
    }

    return NextResponse.json({ updated: itemIds.length });
  } catch (err) {
    logger.error('POST /api/projects/bulk-assign-channels', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
});
