import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Editor telemetry probe — Phase 0 of `_plans/2026-05-18-shot-graph-editor.md`,
 * extended in Phase 0 of `_plans/2026-05-18-overlay-system-overhaul.md` to
 * also accept overlay-placement baseline events.
 *
 * Accepted event names:
 *   - `render_clicked`         — shot-graph editor probe.
 *   - `external_edit_intent`   — shot-graph editor probe.
 *   - `stayed_here`            — shot-graph editor probe.
 *   - `overlay_drag`           — user moved the overlay away from the
 *                                AI-planned placement before save.
 *                                Payload: { row_index, placement_model,
 *                                  prev_x_pct, prev_y_pct, prev_size_pct,
 *                                  new_x_pct, new_y_pct, new_size_pct,
 *                                  drag_distance_pct }.
 *   - `overlay_resize`         — user resized the overlay (corner/edge
 *                                handle, or slider). Fires alongside
 *                                overlay_drag if both changed in the same
 *                                save. Payload: { row_index,
 *                                  placement_model, prev_size_pct,
 *                                  new_size_pct, prev_stretched_height_pct,
 *                                  new_stretched_height_pct,
 *                                  free_aspect_used: boolean }.
 *   - `overlay_accept`         — user saved the editor without changing
 *                                position or size. Implicit "AI was right."
 *                                Payload: { row_index, placement_model,
 *                                  x_pct, y_pct, size_pct }.
 *   - `overlay_reset`          — user cleared their manual placement,
 *                                falling back to the AI's pick.
 *                                Payload: { row_index, placement_model }.
 *
 * Together these three events let us compute the per-`placement_model`
 * "drag rate" after ~100 docs in prod — the data Phase 2 needs to decide
 * whether to upgrade the placement model.
 *
 * Future editor events (`editor_open`, `edit_applied`, `otio_exported`,
 * `overlay_rethink`, …) will land here too; the allow-list grows as the
 * editor ships.
 *
 * Body: `{ event: string, project_id?: string, payload?: Record<string, unknown> }`.
 * `payload` is a small JSONB blob — counters and discriminators only,
 * never raw prompts / transcripts / PII (see migration 0078 header).
 *
 * Workspace + user are taken from the session, never from the body —
 * the client cannot falsify them.
 */

// Allow-list of accepted event names. Reject everything else so a malformed
// caller can't pollute the table with arbitrary strings.
const ALLOWED_EVENTS = new Set([
  'render_clicked',
  'external_edit_intent',
  'stayed_here',
  'overlay_drag',
  'overlay_resize',
  'overlay_accept',
  'overlay_reset',
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
