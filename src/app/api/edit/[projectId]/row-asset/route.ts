/**
 * POST /api/edit/[projectId]/row-asset
 *
 * Atomic server-side write for a single row's expensive asset
 * (generated image / fetched overlay / B-roll clip).
 *
 * Why this exists:
 *   The production-doc page used to persist these assets through the
 *   debounced parity-bridge effect — image-gen completes, client sets
 *   `rowImages[i] = url`, the effect fires, projectPatch arms an
 *   800 ms debounce, /api/edit/[projectId] PATCH lands eventually.
 *   That path silently dropped saves in three real failure modes:
 *     1. Image gen finishes BEFORE `historyEntryId` is set (race
 *        during initial doc creation) → effect bails on the null
 *        check at `page.tsx:3816`.
 *     2. Image gen finishes BEFORE useProject's GET resolved (race
 *        during history-entry switch) → effect bails on the null
 *        `currentPayload` at `page.tsx:3823`.
 *     3. User navigates / closes the tab inside the 800 ms debounce
 *        window → setTimeout dies with the page, save never fires.
 *   Result: the user paid for a generation and the URL never
 *   reached the database.
 *
 * Why server-side vs. fixing the autosave:
 *   Generations cost real money. Attaching the asset server-side in
 *   a single SQL statement removes every client-state dependency:
 *   no localStorage cache, no in-flight useProject GET, no debounce
 *   timer. The image lands on the server before the gen API call
 *   returns to the client. Tab close, device switch, storage
 *   eviction — none can lose the bytes once the POST has returned 200.
 *
 * Storage backend (2026-05-24):
 *   Asset URLs live in the dedicated `project_assets` table now,
 *   not in `user_history.payload`. Eliminates the payload-size cap
 *   class entirely (the 413 issue on the 184-shot NotPetya project).
 *   See `_plans/2026-05-24-project-assets-extraction.md`. The
 *   per-image `rowImageStyleVersions` field stays on the payload —
 *   it's a small integer per row, not a size-bloat source, and the
 *   editor still reads it from there.
 *
 * Body:
 *   {
 *     rowIndex: number,           // index into doc.rows
 *     slot:     'image' | 'overlay' | 'clip',
 *     value:    string | OverlayValue | ClipValue | null,
 *     styleVersion?: number,      // image-only: pin the row to the
 *                                  // style version at gen time so
 *                                  // future style edits can flag drift
 *   }
 *
 *   slot = 'image'   → value is the imageUrl string (or null to clear)
 *   slot = 'overlay' → value is { status: 'done'|'skipped', url?: string }
 *   slot = 'clip'    → value is { status, videoUrl?, durationSeconds?, brollClipId? }
 *
 * Response:
 *   200 { ok: true, version: number }   — newly-bumped row version
 *   404 { error: '...' }                — project missing or out of scope
 *   400 { error: '...' }                — invalid body shape
 *
 * Auth: standard editor-project ownership via `apiRoute.authed` plus
 * the SQL WHERE clause's workspace_id + collaborator_id bind so a
 * leaked project id from another scope is indistinguishable from a
 * non-existent row.
 *
 * Per-IP rate limit: 240/min — same ceiling as the editor PATCH route
 * (120/min) doubled because legitimate batch generations can fire
 * one POST per row, and a 30-row doc with 8 rapid retries should not
 * trip the limit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { writeProjectAsset, bumpProjectVersion } from '@/lib/project/assets';
import { classifyDbError, FAILURE_CLASS_USER_MESSAGES } from '@/lib/db-error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URL_BYTES = 8192;
const MAX_ROW_INDEX = 1000;

type Slot = 'image' | 'overlay' | 'clip';

interface OverlayValue {
  status: string;
  url?: string;
}

interface ClipValue {
  status: string;
  videoUrl?: string;
  durationSeconds?: number;
  brollClipId?: string;
}

interface Body {
  rowIndex?: unknown;
  slot?: unknown;
  value?: unknown;
  styleVersion?: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validateValue(slot: Slot, value: unknown): { ok: true; normalized: unknown } | { ok: false; reason: string } {
  // null clears the slot — always accepted (e.g. user removes an image).
  if (value === null) return { ok: true, normalized: null };

  if (slot === 'image') {
    if (typeof value !== 'string') return { ok: false, reason: 'value must be a string for slot=image' };
    if (value.length === 0) return { ok: false, reason: 'value must be non-empty (pass null to clear)' };
    if (value.length > MAX_URL_BYTES) return { ok: false, reason: `value too long (${value.length} > ${MAX_URL_BYTES})` };
    // Allow http(s) and data: — the existing dispatcher returns either.
    if (!/^(https?:|data:image\/)/i.test(value)) return { ok: false, reason: 'value must be http(s) or data:image URL' };
    return { ok: true, normalized: value };
  }

  if (slot === 'overlay') {
    if (!isPlainObject(value)) return { ok: false, reason: 'value must be an object for slot=overlay' };
    if (typeof value.status !== 'string') return { ok: false, reason: 'value.status must be a string' };
    if (value.url !== undefined && typeof value.url !== 'string') return { ok: false, reason: 'value.url must be a string when present' };
    if (typeof value.url === 'string' && value.url.length > MAX_URL_BYTES) return { ok: false, reason: 'value.url too long' };
    const normalized: OverlayValue = { status: value.status };
    if (typeof value.url === 'string') normalized.url = value.url;
    return { ok: true, normalized };
  }

  if (slot === 'clip') {
    if (!isPlainObject(value)) return { ok: false, reason: 'value must be an object for slot=clip' };
    if (typeof value.status !== 'string') return { ok: false, reason: 'value.status must be a string' };
    if (value.videoUrl !== undefined && typeof value.videoUrl !== 'string') return { ok: false, reason: 'value.videoUrl must be a string when present' };
    if (value.durationSeconds !== undefined && (typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds))) {
      return { ok: false, reason: 'value.durationSeconds must be a finite number when present' };
    }
    if (value.brollClipId !== undefined && typeof value.brollClipId !== 'string') return { ok: false, reason: 'value.brollClipId must be a string when present' };
    const normalized: ClipValue = { status: value.status };
    if (typeof value.videoUrl === 'string') normalized.videoUrl = value.videoUrl;
    if (typeof value.durationSeconds === 'number') normalized.durationSeconds = value.durationSeconds;
    if (typeof value.brollClipId === 'string') normalized.brollClipId = value.brollClipId;
    return { ok: true, normalized };
  }

  return { ok: false, reason: `unknown slot: ${String(slot)}` };
}

export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) => {
    // Per-IP rate limit — see header comment for ceiling rationale.
    const { limited } = checkRateLimit(`row-asset:${getClientIP(req)}`, 240, 60_000);
    if (limited) {
      return NextResponse.json({ error: 'Too many asset attaches — slow down.' }, { status: 429 });
    }

    const { projectId } = await ctx.params;
    if (!UUID_RE.test(projectId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (typeof body.rowIndex !== 'number' || !Number.isInteger(body.rowIndex) || body.rowIndex < 0 || body.rowIndex > MAX_ROW_INDEX) {
      return NextResponse.json(
        { error: `rowIndex must be an integer in [0, ${MAX_ROW_INDEX}]` },
        { status: 400 },
      );
    }
    const rowIndex = body.rowIndex;

    if (body.slot !== 'image' && body.slot !== 'overlay' && body.slot !== 'clip') {
      return NextResponse.json(
        { error: "slot must be 'image' | 'overlay' | 'clip'" },
        { status: 400 },
      );
    }
    const slot = body.slot as Slot;

    const validated = validateValue(slot, body.value);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.reason }, { status: 400 });
    }

    // styleVersion is image-only metadata for drift detection. Stays
    // on the payload (it's a small integer per row, doesn't bloat the
    // payload like asset URLs do); written via a separate jsonb_set
    // after the asset write succeeds.
    let styleVersion: number | undefined;
    if (slot === 'image' && body.styleVersion !== undefined) {
      if (typeof body.styleVersion !== 'number' || !Number.isFinite(body.styleVersion) || !Number.isInteger(body.styleVersion) || body.styleVersion < 0) {
        return NextResponse.json({ error: 'styleVersion must be a non-negative integer' }, { status: 400 });
      }
      styleVersion = body.styleVersion;
    }

    logger.info('[row-asset attach] start', {
      project_id: projectId,
      workspace_id: session.ws,
      slot,
      row_index: rowIndex,
      clears: validated.normalized === null,
      style_version: styleVersion,
    });

    // Verify project ownership + scope BEFORE touching project_assets.
    // The FK on project_assets is ON DELETE CASCADE but doesn't enforce
    // workspace/collaborator scoping, so the auth check lives here.
    // Step-scoped try/catch so a connection blip on ownership doesn't
    // get attributed to the asset write below — distinct log lines +
    // failureClass per step.
    const ownershipStart = Date.now();
    let ownership: { rows: Array<{ id: string }> };
    try {
      ownership = await sql<{ id: string }>`
        SELECT id
          FROM user_history
         WHERE id = ${projectId}::uuid
           AND workspace_id = ${session.ws}::uuid
           AND collaborator_id = ${session.uid}::uuid
           AND kind = 'production_doc'
         LIMIT 1
      `;
    } catch (err) {
      return dbStepFailure('ownership_check', err, { projectId, slot, rowIndex });
    }
    if (ownership.rows.length === 0) {
      logger.info('[row-asset attach] not found', { project_id: projectId });
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Asset write goes to project_assets (UPSERT on the composite PK).
    // Each slot write is one statement — image to row N doesn't touch
    // overlay on row N or image on any other row. No payload size cap
    // class to hit because the asset URLs no longer live in the payload.
    const writeStart = Date.now();
    try {
      await writeProjectAsset(
        projectId,
        rowIndex,
        slot,
        validated.normalized as string | { status: string; url?: string } | { status: string; videoUrl?: string; durationSeconds?: number; brollClipId?: string } | null,
      );
    } catch (err) {
      return dbStepFailure('asset_write', err, {
        projectId,
        slot,
        rowIndex,
        durationMs: Date.now() - writeStart,
        ownershipMs: writeStart - ownershipStart,
      });
    }

    // Image-only: persist styleVersion onto the payload alongside the
    // asset write. Tiny integer, stays in JSONB — no bloat concern.
    // Failure here is non-fatal: the asset already landed, drift
    // detection is a soft signal — log + classify but don't 500.
    if (styleVersion !== undefined) {
      const stylePathLiteral = `{rowImageStyleVersions,${rowIndex}}`;
      try {
        await sql`
          UPDATE user_history
             SET payload = jsonb_set(
                   COALESCE(payload, '{}'::jsonb),
                   ${stylePathLiteral}::text[],
                   ${String(styleVersion)}::jsonb,
                   true
                 )
           WHERE id = ${projectId}::uuid
             AND workspace_id = ${session.ws}::uuid
             AND collaborator_id = ${session.uid}::uuid
             AND kind = 'production_doc'
        `;
      } catch (err) {
        const classified = classifyDbError(err);
        logger.warn('[row-asset attach] styleVersion write failed (non-fatal)', {
          project_id: projectId,
          row_index: rowIndex,
          failure_class: classified.failureClass,
          pg_code: classified.pg_code,
          detail: classified.serverMessage.slice(0, 300),
        });
      }
    }

    // Bump user_history.version so the editor's optimistic-sync
    // contract keeps working. The asset write didn't touch the payload
    // (asset URLs live elsewhere now); without this manual bump, the
    // editor would never observe that the project changed.
    let newVersion: number;
    try {
      newVersion = await bumpProjectVersion(projectId);
    } catch (err) {
      return dbStepFailure('version_bump', err, { projectId, slot, rowIndex });
    }

    logger.info('[row-asset attach] committed', {
      project_id: projectId,
      slot,
      row_index: rowIndex,
      new_version: newVersion,
      total_ms: Date.now() - ownershipStart,
    });
    return NextResponse.json({ ok: true, version: newVersion });
  },
);

/** Centralised classify-log-respond for a failed DB step. Returns
 *  a 500 with the classified failureClass + a client-safe user
 *  message; full PG fields (code, table, constraint, hint) land in
 *  the server log at ERROR level for triage. */
function dbStepFailure(
  step: 'ownership_check' | 'asset_write' | 'version_bump',
  err: unknown,
  ctx: { projectId: string; slot: string; rowIndex: number; durationMs?: number; ownershipMs?: number },
): NextResponse {
  const classified = classifyDbError(err);
  logger.error('[row-asset attach] step failed', {
    step,
    project_id: ctx.projectId,
    slot: ctx.slot,
    row_index: ctx.rowIndex,
    failure_class: classified.failureClass,
    pg_code: classified.pg_code,
    pg_severity: classified.pg_severity,
    pg_table: classified.pg_table,
    pg_constraint: classified.pg_constraint,
    pg_detail: classified.pg_detail?.slice(0, 300),
    pg_hint: classified.pg_hint?.slice(0, 300),
    raw_message: classified.raw_message.slice(0, 300),
    duration_ms: ctx.durationMs,
    ownership_ms: ctx.ownershipMs,
  });
  return NextResponse.json(
    {
      error: FAILURE_CLASS_USER_MESSAGES[classified.failureClass],
      failureClass: classified.failureClass,
      step,
    },
    { status: 500 },
  );
}
