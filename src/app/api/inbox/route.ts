import { NextRequest, NextResponse } from 'next/server';
import { requireUser, SessionError } from '@/lib/session';
import {
  listInboxComments,
  inboxDeepLink,
  type InboxAuthorRole,
  type InboxFilter,
} from '@/lib/inbox-db';
import { logger } from '@/lib/logger';

const VALID_FILTERS: ReadonlySet<InboxFilter> = new Set(['unresolved', 'resolved', 'all']);
const VALID_ROLES: ReadonlySet<InboxAuthorRole> = new Set(['owner', 'narrator', 'editor', 'reviewer']);

/**
 * Global comments inbox feed for the authenticated owner.
 *
 * Returns top-level comments across `narration_take_comments` and
 * `review_comments` scoped to the caller's workspace. Each row carries
 * its project + take/version context plus a pre-computed `deep_link` so
 * the page can render and route without follow-up requests.
 *
 * Query params:
 *   filter      — 'unresolved' (default) | 'resolved' | 'all'
 *   q           — substring search across text + author_name
 *   project_id  — restrict to one project
 *   role        — restrict to one role bucket
 *   author_name — restrict to one author (case-insensitive equality)
 *   limit       — max rows (capped server-side)
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireUser();

    const url = req.nextUrl;
    const rawFilter = url.searchParams.get('filter') as InboxFilter | null;
    const filter: InboxFilter = rawFilter && VALID_FILTERS.has(rawFilter) ? rawFilter : 'unresolved';

    const rawRole = url.searchParams.get('role') as InboxAuthorRole | null;
    const role: InboxAuthorRole | undefined = rawRole && VALID_ROLES.has(rawRole) ? rawRole : undefined;

    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Math.max(1, Math.min(1000, Number.parseInt(limitRaw, 10) || 0)) : undefined;

    const comments = await listInboxComments(session.ws, {
      filter,
      q: url.searchParams.get('q') ?? undefined,
      project_id: url.searchParams.get('project_id') ?? undefined,
      role,
      author_name: url.searchParams.get('author_name') ?? undefined,
      limit,
    });

    // Compute deep_link on the server so the client doesn't have to know
    // about the source-specific URL shape. Mirrors the pattern used by
    // /api/messages/threads which precomputes preview metadata.
    const rows = comments.map(c => ({ ...c, deep_link: inboxDeepLink(c) }));

    return NextResponse.json({ comments: rows });
  } catch (err: unknown) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('GET /api/inbox error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to load inbox' }, { status: 500 });
  }
}
