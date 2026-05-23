/**
 * PATCH /api/edit/[projectId]/generation-events/[eventId]
 *
 * Update an in-flight history entry once its underlying clip reaches a
 * terminal status. Fired from the editor's poll loop in
 * `EditorClient.tsx` immediately after `setRowVideoClip(..., false)`
 * commits the terminal state.
 *
 * Idempotency: the UPDATE only fires for events still in
 * `status='generating'`. Once an event is terminal, subsequent PATCHes
 * are no-ops (return 200 with `ok: false`). This makes it safe to
 * retry the client call without polluting `completed_at` with the
 * second-attempt timestamp.
 *
 * Ownership gate: joined through `user_history` with the full
 * (workspace_id, collaborator_id, kind) bind so a leaked eventId from
 * another scope returns 404, indistinguishable from a non-existent
 * row. Same convention as POST in the parent route.
 *
 * Failure mode contract: same as POST — this is best-effort
 * observability. The client wrapper catches and swallows so the poll
 * loop's terminal-state commit is never blocked by an audit-log write.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ERROR_MESSAGE_LEN = 2000;

interface PatchBody {
  status?: unknown;       // 'ready' | 'failed'
  errorMessage?: unknown; // optional
}

export const PATCH = apiRoute.authed(
  async (
    session,
    req: NextRequest,
    ctx: { params: Promise<{ projectId: string; eventId: string }> },
  ) => {
    const { limited } = checkRateLimit(`gen-events-patch:${getClientIP(req)}`, 240, 60_000);
    if (limited) {
      return NextResponse.json({ error: 'Too many history updates — slow down.' }, { status: 429 });
    }

    const { projectId, eventId } = await ctx.params;
    if (!UUID_RE.test(projectId) || !UUID_RE.test(eventId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (body.status !== 'ready' && body.status !== 'failed') {
      return NextResponse.json(
        { error: "status must be 'ready' or 'failed'" },
        { status: 400 },
      );
    }
    const status = body.status;

    let errorMessage: string | null = null;
    if (body.errorMessage !== undefined && body.errorMessage !== null) {
      if (typeof body.errorMessage !== 'string') {
        return NextResponse.json(
          { error: 'errorMessage must be a string when present' },
          { status: 400 },
        );
      }
      errorMessage = body.errorMessage.slice(0, MAX_ERROR_MESSAGE_LEN);
    }

    logger.info('[api generation-events patch] start', {
      project_id: projectId,
      event_id: eventId,
      status,
      has_error: errorMessage !== null,
    });

    // Single statement: UPDATE … FROM user_history WHERE …
    // The user_history join enforces project ownership without a
    // separate probe. `status = 'generating'` predicate makes the
    // PATCH idempotent — a second call after the entry already went
    // terminal updates zero rows and returns `ok: false`.
    const updated = await sql<{ id: string }>`
      UPDATE generation_events ge
         SET status        = ${status},
             error_message = ${errorMessage},
             completed_at  = NOW()
        FROM user_history uh
       WHERE ge.id = ${eventId}::uuid
         AND ge.project_id = ${projectId}::uuid
         AND ge.project_id = uh.id
         AND uh.workspace_id = ${session.ws}::uuid
         AND uh.collaborator_id = ${session.uid}::uuid
         AND uh.kind = 'production_doc'
         AND ge.status = 'generating'
       RETURNING ge.id
    `;

    if (updated.rows.length === 0) {
      // Two reasons we end up here: (1) ownership failed (treat as
      // 404 — same as POST), or (2) the event is already terminal
      // (idempotent no-op, return 200 ok:false). Disambiguate with
      // a tiny probe — cheap, covered by the project_created index.
      const probe = await sql<{ status: string }>`
        SELECT ge.status
          FROM generation_events ge
          JOIN user_history uh ON uh.id = ge.project_id
         WHERE ge.id = ${eventId}::uuid
           AND ge.project_id = ${projectId}::uuid
           AND uh.workspace_id = ${session.ws}::uuid
           AND uh.collaborator_id = ${session.uid}::uuid
           AND uh.kind = 'production_doc'
         LIMIT 1
      `;
      if (probe.rows.length === 0) {
        logger.info('[api generation-events patch] not found', {
          project_id: projectId,
          event_id: eventId,
        });
        return NextResponse.json({ error: 'Event not found' }, { status: 404 });
      }
      logger.info('[api generation-events patch] noop (already terminal)', {
        project_id: projectId,
        event_id: eventId,
        existing_status: probe.rows[0]!.status,
      });
      return NextResponse.json({ ok: false, reason: 'already-terminal' });
    }

    logger.info('[api generation-events patch] committed', {
      project_id: projectId,
      event_id: eventId,
      status,
    });
    return NextResponse.json({ ok: true });
  },
);
