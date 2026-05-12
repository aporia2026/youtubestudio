import { NextRequest, NextResponse } from 'next/server';
import { requireUser, SessionError } from '@/lib/session';
import {
  resolveInboxComment,
  unresolveInboxComment,
  type InboxSource,
} from '@/lib/inbox-db';
import { findUserById } from '@/lib/users';
import { logger } from '@/lib/logger';

const VALID_SOURCES: ReadonlySet<InboxSource> = new Set(['narration', 'review']);

/**
 * Flip a comment's resolved state from inside the inbox.
 *
 * Body: { source: 'narration' | 'review', commentId: string, resolved: boolean }
 *
 * Re-scopes the UPDATE by workspace_id (read from the session, never the
 * body) so a forged comment id from another workspace cannot be mutated.
 * Existing per-table PATCH routes scope by project_id, which works from
 * the project pages but isn't the right gate from a global inbox.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();

    let body: { source?: string; commentId?: string; resolved?: boolean };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { source, commentId, resolved } = body;
    if (typeof commentId !== 'string' || !commentId) {
      return NextResponse.json({ error: 'commentId required' }, { status: 400 });
    }
    if (typeof resolved !== 'boolean') {
      return NextResponse.json({ error: 'resolved (boolean) required' }, { status: 400 });
    }
    if (typeof source !== 'string' || !VALID_SOURCES.has(source as InboxSource)) {
      return NextResponse.json({ error: 'source must be "narration" or "review"' }, { status: 400 });
    }

    let ok: boolean;
    if (resolved) {
      // Look up the owner's display name once so resolved_by shows who hit
      // the button rather than a generic 'Owner'.
      const me = await findUserById(session.uid);
      const resolvedBy = me?.name || 'Owner';
      ok = await resolveInboxComment(session.ws, source as InboxSource, commentId, resolvedBy);
    } else {
      ok = await unresolveInboxComment(session.ws, source as InboxSource, commentId);
    }

    if (!ok) {
      return NextResponse.json({ error: 'Comment not found in this workspace' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('POST /api/inbox/resolve error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}
