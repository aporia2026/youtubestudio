import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { deleteUserHistoryEntry, updateUserHistoryEntry } from '@/lib/user-history';
import { isUuid } from '@/lib/user-history-types';

/**
 * PATCH /api/history/[id]
 *
 * Body: { payload: object }
 *
 * Replace the payload of an existing entry. The client is responsible
 * for merging — this endpoint stores whatever payload it receives.
 * Used by the thumbnail/production-doc panels to attach generated
 * images after the initial save.
 *
 * Scoped to the caller's (workspace_id, collaborator_id), so a
 * leaked id from another scope returns 404 instead of mutating
 * cross-scope data.
 */
export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // Reject non-UUID ids as 404, matching the deliberate "no
    // existence leak" behaviour for cross-scope ids. A non-UUID id
    // would otherwise raise a Postgres syntax error and 500.
    // The most common source is the synthetic id from the client
    // lib's local-only fallback save path.
    if (!isUuid(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const payload = (body as { payload?: unknown } | null)?.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json(
        { error: 'payload is required and must be a JSON object' },
        { status: 400 },
      );
    }
    try {
      const ok = await updateUserHistoryEntry(session.ws, session.uid, id, payload);
      if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'user-history: update',
        knownPatterns: [{ match: /payload too large/i, status: 413 }],
        fallbackMessage: 'Could not update the history entry — please try again.',
      });
    }
  },
);

/**
 * DELETE /api/history/[id]
 *
 * Delete one history entry by id. Scoped to the caller's
 * (workspace_id, collaborator_id), so a leaked id from another
 * tenant or another user is silently a 404 — never a successful
 * cross-scope delete.
 */
export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // Same UUID guard as PATCH — see comment above. 404 (not 400) so
    // a non-existent id and a malformed id are indistinguishable to
    // the caller.
    if (!isUuid(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const ok = await deleteUserHistoryEntry(session.ws, session.uid, id);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
