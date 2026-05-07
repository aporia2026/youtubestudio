import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { HISTORY_KINDS, isHistoryKind } from '@/lib/user-history-types';
import { clearUserHistory } from '@/lib/user-history';
import { logger } from '@/lib/logger';

/**
 * POST /api/history/clear
 *
 * Body: { kind: HistoryKind }
 *
 * Wipes every entry of one kind for this user in this workspace.
 * POST (not DELETE) because the action takes a body to specify which
 * kind to clear, and the legacy "Clear all" button on the panel
 * already prompts for confirmation client-side.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const kind = (body as { kind?: unknown } | null)?.kind;
  if (!isHistoryKind(kind)) {
    return NextResponse.json(
      { error: `kind is required and must be one of: ${HISTORY_KINDS.join(', ')}` },
      { status: 400 },
    );
  }
  try {
    const removed = await clearUserHistory(session.ws, session.uid, kind);
    // Telemetry — "user wiped 47 script entries" is the kind of
    // signal we want when debugging "where did my history go".
    logger.info('user-history: cleared', { kind, removed });
    return NextResponse.json({ removed });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'user-history: clear',
      fallbackMessage: 'Could not clear history — please try again.',
    });
  }
});
