import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Editor telemetry probe — Phase 0 of `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Three event names are accepted in v0:
 *   - `render_clicked`
 *   - `external_edit_intent`
 *   - `stayed_here`
 *
 * Future editor events (`editor_open`, `edit_applied`, `otio_exported`,
 * …) will land here too; the allow-list grows as the editor ships.
 *
 * Body: `{ event: string, project_id?: string, payload?: Record<string, unknown> }`.
 * `payload` is a small JSONB blob — counters and discriminators only,
 * never raw prompts / transcripts / PII (see migration 0078 header).
 *
 * Workspace + user are taken from the session, never from the body —
 * the client cannot falsify them.
 */

// Allow-list of v0 event names. Reject everything else so a malformed
// caller can't pollute the table with arbitrary strings.
const ALLOWED_EVENTS = new Set([
  'render_clicked',
  'external_edit_intent',
  'stayed_here',
]);

// Hard upper bound on payload size after JSON.stringify. 4 KB is
// generous for the counters we expect; rejects accidental floods
// (e.g. a caller stuffing the full doc into payload).
const MAX_PAYLOAD_BYTES = 4 * 1024;

// Allow-list of `destination` values on `external_edit_intent` so we
// can grep + group cleanly during the Phase 0 readout without sanitising
// free-form strings later.
const ALLOWED_EXTERNAL_DESTINATIONS = new Set(['capcut', 'premiere', 'other']);

interface PostBody {
  event?: unknown;
  project_id?: unknown;
  payload?: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Telemetry is cheap but a runaway client could still flood. 60/min
  // per IP is plenty for a creator who clicks Render once + dismisses
  // a survey, and well below scripted abuse rates.
  const { limited } = checkRateLimit(`editor-telemetry:${getClientIP(req)}`, 60, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Too many telemetry events.' }, { status: 429 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const event = typeof body.event === 'string' ? body.event.trim() : '';
  if (!event || !ALLOWED_EVENTS.has(event)) {
    return NextResponse.json(
      { error: `Unknown event. Allowed: ${[...ALLOWED_EVENTS].join(', ')}` },
      { status: 400 },
    );
  }

  const projectId = typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null;
  const payload = isPlainObject(body.payload) ? body.payload : null;

  // Per-event payload validation. Catch obviously-wrong shapes here so
  // the Phase 0 readout doesn't need defensive parsing.
  if (event === 'external_edit_intent') {
    const destination = typeof payload?.destination === 'string' ? payload.destination.toLowerCase() : '';
    if (!destination || !ALLOWED_EXTERNAL_DESTINATIONS.has(destination)) {
      return NextResponse.json(
        { error: `external_edit_intent requires payload.destination ∈ ${[...ALLOWED_EXTERNAL_DESTINATIONS].join(', ')}` },
        { status: 400 },
      );
    }
  }

  // Size cap. Stringify once; if it blows the budget, reject — we'd
  // rather lose the event than store a megabyte of stray context.
  const payloadJson = payload ? JSON.stringify(payload) : null;
  if (payloadJson && payloadJson.length > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: `Payload exceeds ${MAX_PAYLOAD_BYTES} byte cap.` },
      { status: 413 },
    );
  }

  try {
    await sql`
      INSERT INTO editor_telemetry (workspace_id, collaborator_id, project_id, event, payload_jsonb)
      VALUES (
        ${session.ws}::uuid,
        ${session.uid}::uuid,
        ${projectId}::uuid,
        ${event},
        ${payloadJson}::jsonb
      )
    `;
  } catch (err) {
    // Telemetry must never break the calling UX. Log + 200 so the
    // client treats it as success and moves on. A missing-row in the
    // analytics table is acceptable; a broken Render button is not.
    logger.warn('[editor telemetry] insert failed', {
      event,
      workspace_id: session.ws,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: true, recorded: false }, { status: 200 });
  }

  logger.info('[editor telemetry] event recorded', {
    event,
    project_id: projectId,
    workspace_id: session.ws,
  });

  return NextResponse.json({ ok: true, recorded: true }, { status: 201 });
});
