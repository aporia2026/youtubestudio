import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { loadProject, saveProjectPatch, MAX_PAYLOAD_BYTES } from '@/lib/project/persist';

/**
 * Project payload endpoint — Phase 1 of
 * `_plans/2026-05-19-editor-production-doc-parity.md`.
 *
 * `PATCH /api/edit/:projectId` writes the canonical `ProjectPayload`
 * back to `user_history` with an optimistic version check. The
 * earlier shape (doc + rowImages + voiceoverUrl only) is migrated
 * server-side via `migratePayload`, so older clients that PATCH the
 * partial shape still succeed — the validator runs on the migrated
 * output, not the raw body.
 *
 * `GET /api/edit/:projectId` re-reads the row + migrates. Used by the
 * editor's load path AND by the `useProject` client hook on both
 * pages (production-doc + editor share this endpoint after Phase 2).
 *
 * Workspace + collaborator scoping is enforced inside `loadProject` /
 * `saveProjectPatch` (defense-in-depth on top of `apiRoute.authed`).
 * Cross-scope ids are indistinguishable from non-existent rows.
 *
 * No feature flag on the API route: both pages now persist through
 * this endpoint. The page route at `/edit/[projectId]` keeps its
 * `EDITOR_V1_ENABLED` gate so the editor's UI surface stays private
 * while the data API stays open.
 */

interface PatchBody {
  payload?: unknown;
  version?: unknown;
}

export const PATCH = apiRoute.authed(async (
  session,
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => {
  // Per-IP rate limit. Auto-save fires every ~800 ms while a user is
  // typing; 120/min absorbs a busy session without flagging a normal
  // operator while still capping a scripted abuser.
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
    return NextResponse.json(
      { error: 'version is required and must be a positive integer' },
      { status: 400 },
    );
  }

  const result = await saveProjectPatch({
    id: projectId,
    session,
    payload: body.payload,
    expectedVersion: body.version,
  });

  switch (result.kind) {
    case 'saved':
      return NextResponse.json({ ok: true, version: result.newVersion });
    case 'invalid':
      return NextResponse.json(
        { error: `Invalid payload at ${result.field}: ${result.reason}` },
        { status: 400 },
      );
    case 'too_large':
      return NextResponse.json(
        { error: `Payload exceeds ${MAX_PAYLOAD_BYTES} byte cap (${result.bytes} bytes).` },
        { status: 413 },
      );
    case 'not_found':
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    case 'conflict':
      return NextResponse.json(
        {
          error: 'Version conflict — the project was edited elsewhere.',
          reason: 'stale_version',
          currentVersion: result.currentVersion,
          currentPayload: result.currentPayload,
        },
        { status: 409 },
      );
  }
});

export const GET = apiRoute.authed(async (
  session,
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  const result = await loadProject(projectId, session);
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  return NextResponse.json({ version: result.version, payload: result.payload });
});
