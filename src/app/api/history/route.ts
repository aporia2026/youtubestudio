import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  HISTORY_KINDS,
  isHistoryKind,
  listUserHistory,
  saveUserHistory,
} from '@/lib/user-history';

/**
 * GET /api/history?kind=script
 *
 * Returns this user's recent entries of `kind`, newest first, up to
 * the per-kind cap (see KIND_CAPS in user-history.ts). Auth is
 * enforced by `apiRoute.authed` and the query is scoped to
 * `(session.ws, session.uid)` — collaborators cannot read each
 * other's history.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const kind = new URL(req.url).searchParams.get('kind');
  if (!isHistoryKind(kind)) {
    return NextResponse.json(
      { error: `kind is required and must be one of: ${HISTORY_KINDS.join(', ')}` },
      { status: 400 },
    );
  }
  const items = await listUserHistory(session.ws, session.uid, kind);
  return NextResponse.json({ items });
});

/**
 * POST /api/history
 *
 * Body: { kind: HistoryKind, payload: object, clientId?: string }
 *
 * Inserts one entry for this user. `clientId` is OPTIONAL and only
 * used by the one-shot localStorage→server migration in the client
 * library; supplying it makes the insert idempotent on retry. Any
 * other caller should omit it.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const kind = b.kind;
  if (!isHistoryKind(kind)) {
    return NextResponse.json(
      { error: `kind is required and must be one of: ${HISTORY_KINDS.join(', ')}` },
      { status: 400 },
    );
  }

  const payload = b.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json(
      { error: 'payload is required and must be a JSON object' },
      { status: 400 },
    );
  }

  const clientIdRaw = b.clientId;
  let clientId: string | undefined;
  if (clientIdRaw !== undefined && clientIdRaw !== null) {
    if (typeof clientIdRaw !== 'string' || clientIdRaw.length === 0 || clientIdRaw.length > 200) {
      return NextResponse.json(
        { error: 'clientId, when provided, must be a non-empty string of at most 200 characters' },
        { status: 400 },
      );
    }
    clientId = clientIdRaw;
  }

  try {
    const item = await saveUserHistory(session.ws, session.uid, kind, payload, clientId);
    return NextResponse.json({ item });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'user-history: save',
      knownPatterns: [
        // Surfaced as a 413-style error so the client can retry with
        // a smaller payload (e.g. truncate the script body harder).
        { match: /payload too large/i, status: 413 },
      ],
      fallbackMessage: 'Could not save to history — please try again.',
    });
  }
});
