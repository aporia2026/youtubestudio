import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { EDITOR_V1_ENABLED } from '@/lib/feature-flags';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Shot-graph editor save endpoint — Phase 2 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * `PATCH /api/edit/:projectId` writes the editor's `payload` JSONB
 * back to `user_history`. Optimistic locking via the `version`
 * integer added in migration 0079 — the request carries the version
 * the client read on load; the UPDATE only fires when that version
 * still matches. A mismatch returns 409 plus the current row so the
 * client can show "newer version exists — reload?".
 *
 * `GET /api/edit/:projectId` re-reads the doc — used by the
 * conflict-recovery flow ("reload" button on the 409 toast).
 *
 * Single-owner-edits for v1 (operator confirmed): only the row's
 * `collaborator_id` can mutate. Workspace + owner are taken from the
 * session, never the body.
 *
 * The route is gated by `EDITOR_V1_ENABLED`. A 404 from a disabled
 * flag is indistinguishable from a non-existent route; the editor's
 * presence stays private.
 */

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB — generous for the doc + image-URL map

interface PatchBody {
  payload?: unknown;
  version?: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Light structural check on the payload before it hits Postgres.
 * The full shape is enforced by the client-side TypeScript types;
 * this is a defense-in-depth gate that drops obvious garbage and
 * prevents the row from being clobbered with `null` or an array
 * (both would deserialize cleanly but break the read path).
 */
function payloadLooksValid(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) return false;
  const doc = payload.doc;
  if (!isPlainObject(doc) || !Array.isArray((doc as { rows?: unknown[] }).rows)) {
    return false;
  }
  return true;
}

export const PATCH = apiRoute.authed(async (
  session,
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => {
  if (!EDITOR_V1_ENABLED) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Per-IP rate limit. Auto-save runs every ~800ms when the user is
  // editing; 120/min absorbs a busy session without flagging. A
  // scripted abuser still gets stopped well below the SQL planner's
  // notice threshold.
  const { limited } = checkRateLimit(`editor-save:${getClientIP(req)}`, 120, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Too many save attempts — slow down.' }, { status: 429 });
  }

  const { projectId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.version !== 'number' || !Number.isFinite(body.version) || body.version < 1) {
    return NextResponse.json({ error: 'version is required and must be a positive integer' }, { status: 400 });
  }
  if (!payloadLooksValid(body.payload)) {
    return NextResponse.json({ error: 'payload missing required `doc.rows` array' }, { status: 400 });
  }

  const payloadJson = JSON.stringify(body.payload);
  if (payloadJson.length > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: `Payload exceeds ${MAX_PAYLOAD_BYTES} byte cap.` },
      { status: 413 },
    );
  }

  // Optimistic-locking UPDATE. Workspace + owner are the same
  // constraints the read path enforces (see /edit/[projectId]/page.tsx):
  // a row that's missing OR not owned OR stale returns 0 affected rows,
  // and we branch on the cause below.
  const updateResult = await sql<{ new_version: number }>`
    UPDATE user_history
       SET payload = ${payloadJson}::jsonb,
           version = version + 1
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
       AND version = ${body.version}
     RETURNING (version) AS new_version
  `;

  if (updateResult.rows.length === 1) {
    logger.info('[editor save] success', {
      project_id: projectId,
      new_version: updateResult.rows[0].new_version,
    });
    return NextResponse.json({
      ok: true,
      version: updateResult.rows[0].new_version,
    });
  }

  // 0 rows affected — could be: row gone, not owned, or stale version.
  // Disambiguate so the client can react correctly. A stale-version
  // hit returns the current row so the client can offer "reload".
  const probe = await sql<{ version: number; payload: unknown }>`
    SELECT version, payload
      FROM user_history
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `;

  if (probe.rows.length === 0) {
    logger.info('[editor save] target row missing', {
      project_id: projectId,
      workspace_id: session.ws,
    });
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  logger.info('[editor save] version conflict', {
    project_id: projectId,
    client_version: body.version,
    server_version: probe.rows[0].version,
  });
  return NextResponse.json(
    {
      error: 'Version conflict — the project was edited elsewhere.',
      reason: 'stale_version',
      currentVersion: probe.rows[0].version,
      currentPayload: probe.rows[0].payload,
    },
    { status: 409 },
  );
});

export const GET = apiRoute.authed(async (
  session,
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => {
  if (!EDITOR_V1_ENABLED) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { projectId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  const { rows } = await sql<{ payload: unknown; version: number }>`
    SELECT payload, version
      FROM user_history
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `;

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  return NextResponse.json({ version: rows[0].version, payload: rows[0].payload });
});
