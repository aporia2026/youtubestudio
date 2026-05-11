import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// Cap to keep a runaway client from pinning a DB connection. A real queue
// rarely runs into the hundreds; raise if it ever does.
const MAX_ITEM_IDS = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function allUuids(xs: unknown[]): xs is string[] {
  return xs.every((x) => typeof x === 'string' && UUID_RE.test(x));
}

/**
 * POST /api/schedule/reorder
 *   Body: { ids: string[] }
 *
 * Reassigns `position` on each schedule item to its 1-based index in the
 * supplied array, in a single transaction so the column ordering is
 * never half-applied if the request is killed mid-flight. Used by the
 * Kanban "Upload Queue" column to capture the creator's manual ordering
 * of the items they intend to ship next.
 *
 * The order is the array order — not the `position` value the caller
 * sends — which keeps the API trivially correct: whatever the client
 * shows after a drop is exactly what the next GET will return. The
 * `WHERE id IN (...)` filter scopes the update to the items the caller
 * referenced, so other columns / other workspaces never get repositioned
 * as a side effect.
 */
export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`schedule-reorder:${getClientIP(req)}`, 30, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    await ensureScheduleSchema();
    const body = await req.json().catch(() => ({}));
    const rawIds: unknown[] = Array.isArray(body.ids) ? body.ids : [];
    if (rawIds.length === 0) {
      return NextResponse.json({ error: 'ids is required' }, { status: 400 });
    }
    if (rawIds.length > MAX_ITEM_IDS) {
      return NextResponse.json({ error: `ids exceeds ${MAX_ITEM_IDS}` }, { status: 400 });
    }
    if (!allUuids(rawIds)) {
      return NextResponse.json({ error: 'ids must all be valid UUIDs' }, { status: 400 });
    }
    // Deduplicate so a buggy client sending the same id twice doesn't
    // produce ambiguous positions. First occurrence wins (matches what
    // a drag UI would intuitively do).
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of rawIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    // One round-trip: WITH ordinality numbers each id in array order
    // (1-based, signed so it fits the INTEGER column without overflow),
    // and the UPDATE … FROM joins back on item id. Single transaction by
    // default, so a connection drop mid-statement leaves the column
    // unchanged.
    await sql.query(
      `UPDATE schedule_items si
         SET position = ordered.idx::int
        FROM unnest($1::uuid[]) WITH ORDINALITY AS ordered(id, idx)
        WHERE si.id = ordered.id`,
      [ids],
    );

    return NextResponse.json({ updated: ids.length });
  } catch (err) {
    logger.error('POST /api/schedule/reorder', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
