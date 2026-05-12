import { NextRequest, NextResponse } from 'next/server';
import { requireUser, SessionError } from '@/lib/session';
import { resolveInboxCommentsBulk, type InboxBulkItem, type InboxSource } from '@/lib/inbox-db';
import { findUserById } from '@/lib/users';
import { logger } from '@/lib/logger';

const VALID_SOURCES: ReadonlySet<InboxSource> = new Set(['narration', 'review']);

/**
 * Bulk resolve / reopen from the inbox. Body:
 *   { items: Array<{ source, commentId }>, resolved: boolean }
 *
 * Hard-caps the batch at 500 items so a runaway selection can't lock the
 * tables for an extended period. Re-scopes the UPDATE by workspace_id so
 * forged ids from other tenants are silently dropped. Returns the number
 * of rows actually updated so the client can warn if the count differs
 * from what the user asked for (e.g. some items resolved by a concurrent
 * session in another tab).
 */
const MAX_BULK = 500;

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();

    let body: { items?: unknown; resolved?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (typeof body.resolved !== 'boolean') {
      return NextResponse.json({ error: 'resolved (boolean) required' }, { status: 400 });
    }
    if (!Array.isArray(body.items)) {
      return NextResponse.json({ error: 'items (array) required' }, { status: 400 });
    }
    if (body.items.length === 0) {
      return NextResponse.json({ updated: 0 });
    }
    if (body.items.length > MAX_BULK) {
      return NextResponse.json({ error: `Too many items — max ${MAX_BULK} per request` }, { status: 400 });
    }

    // Validate each entry; reject the whole batch if any item is malformed
    // rather than silently partial-applying.
    const items: InboxBulkItem[] = [];
    for (const raw of body.items as Array<{ source?: unknown; commentId?: unknown }>) {
      if (!raw || typeof raw.source !== 'string' || !VALID_SOURCES.has(raw.source as InboxSource)) {
        return NextResponse.json({ error: 'each item.source must be "narration" or "review"' }, { status: 400 });
      }
      if (typeof raw.commentId !== 'string' || !raw.commentId) {
        return NextResponse.json({ error: 'each item.commentId required' }, { status: 400 });
      }
      items.push({ source: raw.source as InboxSource, commentId: raw.commentId });
    }

    const me = await findUserById(session.uid);
    const resolvedBy = me?.name || 'Owner';

    const updated = await resolveInboxCommentsBulk(session.ws, items, body.resolved, resolvedBy);
    return NextResponse.json({ updated });
  } catch (err: unknown) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('POST /api/inbox/resolve-bulk error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update comments' }, { status: 500 });
  }
}
