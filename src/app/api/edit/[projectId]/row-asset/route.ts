/**
 * POST /api/edit/[projectId]/row-asset
 *
 * Atomic server-side merge for a single row's expensive asset
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
 *   reached the database. Confirmed by a real-world repro:
 *   `d244130f-bdfe-4d08-b886-c0c77893f5b9` had 181 shots saved but
 *   `imageCount = 0` and `version = 1`, meaning the row was written
 *   exactly once (initial doc save) and every subsequent client save
 *   missed.
 *
 * Why an endpoint vs. fixing the autosave:
 *   Generations cost real money. The user explicitly asked for a
 *   "robust" fix that doesn't depend on client state. Attaching the
 *   asset server-side in a single SQL statement removes every
 *   client-state dependency: no localStorage cache, no in-flight
 *   useProject GET, no debounce timer. The image lands on the server
 *   before the gen API call returns to the client. Tab close, device
 *   switch, storage eviction — none can lose the bytes once the
 *   POST has returned 200.
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
 *   413 { error: '...' }                — payload too large after merge
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
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URL_BYTES = 8192;
const MAX_ROW_INDEX = 1000;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

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

// Payload-path map. Kept here so the bare strings live in one place
// and a typo in jsonb_set's text-array literal is easy to spot.
const SLOT_KEY: Record<Slot, string> = {
  image: 'rowImages',
  overlay: 'rowOverlays',
  clip: 'rowVideoClips',
};

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

    // rowIndex validation — non-negative integer below an absurdity cap.
    // jsonb_set with a numeric path index needs a stringified integer;
    // negatives or non-integers are rejected here so the SQL never sees
    // an invalid path expression.
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

    // styleVersion is image-only metadata for drift detection. Validated
    // here but applied as a parallel jsonb_set further down so a
    // mismatched slot doesn't write a styleVersion under an overlay.
    let styleVersion: number | undefined;
    if (slot === 'image' && body.styleVersion !== undefined) {
      if (typeof body.styleVersion !== 'number' || !Number.isFinite(body.styleVersion) || !Number.isInteger(body.styleVersion) || body.styleVersion < 0) {
        return NextResponse.json({ error: 'styleVersion must be a non-negative integer' }, { status: 400 });
      }
      styleVersion = body.styleVersion;
    }

    // The merge: a single UPDATE that uses jsonb_set with
    // create_if_missing=true so the path is created when the slot map
    // didn't exist yet. The path is a text[] of two elements — the
    // slot key (rowImages/rowOverlays/rowVideoClips) and the stringified
    // rowIndex. Postgres jsonb_set treats numeric-string array indices
    // on objects as object keys, which is exactly what we want
    // (rowImages is shaped as `Record<number, string>` in the
    // ProjectPayload, serialized as a JSON object with string keys).
    //
    // When value === null we use jsonb_set to write JSON null; the
    // editor's render loop treats null and missing the same way.
    //
    // Atomicity: this is a single UPDATE on a single row. The Postgres
    // row-level lock during the UPDATE means two concurrent writers
    // serialize, and each merge sees the other's prior write — no
    // last-write-wins clobbering across slots or rows.
    const slotKey = SLOT_KEY[slot];
    const pathLiteral = `{${slotKey},${rowIndex}}`;
    const valueJson = JSON.stringify(validated.normalized);

    logger.info('[row-asset attach] start', {
      project_id: projectId,
      workspace_id: session.ws,
      slot,
      row_index: rowIndex,
      clears: validated.normalized === null,
      style_version: styleVersion,
    });

    // Cap the post-merge payload size by checking the projected size
    // before commit. Two-phase: first compute the merged payload in
    // a CTE, then either UPDATE or skip based on byte length.
    // pg_column_size on jsonb is the on-disk size; close enough to
    // application-layer bytes for our 2 MB ceiling and faster than
    // re-serializing in Node.
    let updateResult;
    if (styleVersion !== undefined) {
      // Image case w/ styleVersion — two jsonb_set calls nested so
      // both fields land in the same row write.
      const stylePathLiteral = `{rowImageStyleVersions,${rowIndex}}`;
      updateResult = await sql<{ new_version: number; bytes: number }>`
        WITH merged AS (
          SELECT id,
                 jsonb_set(
                   jsonb_set(COALESCE(payload, '{}'::jsonb), ${pathLiteral}::text[], ${valueJson}::jsonb, true),
                   ${stylePathLiteral}::text[], ${String(styleVersion)}::jsonb, true
                 ) AS new_payload
            FROM user_history
           WHERE id = ${projectId}::uuid
             AND workspace_id = ${session.ws}::uuid
             AND collaborator_id = ${session.uid}::uuid
             AND kind = 'production_doc'
        )
        UPDATE user_history h
           SET payload = m.new_payload,
               version = version + 1
          FROM merged m
         WHERE h.id = m.id
           AND pg_column_size(m.new_payload) <= ${MAX_PAYLOAD_BYTES}
         RETURNING h.version AS new_version,
                   pg_column_size(m.new_payload)::int AS bytes
      `;
    } else {
      updateResult = await sql<{ new_version: number; bytes: number }>`
        WITH merged AS (
          SELECT id,
                 jsonb_set(COALESCE(payload, '{}'::jsonb), ${pathLiteral}::text[], ${valueJson}::jsonb, true) AS new_payload
            FROM user_history
           WHERE id = ${projectId}::uuid
             AND workspace_id = ${session.ws}::uuid
             AND collaborator_id = ${session.uid}::uuid
             AND kind = 'production_doc'
        )
        UPDATE user_history h
           SET payload = m.new_payload,
               version = version + 1
          FROM merged m
         WHERE h.id = m.id
           AND pg_column_size(m.new_payload) <= ${MAX_PAYLOAD_BYTES}
         RETURNING h.version AS new_version,
                   pg_column_size(m.new_payload)::int AS bytes
      `;
    }

    if (updateResult.rows.length === 0) {
      // 0 rows could mean either: (a) the project doesn't exist in
      // this scope, or (b) the merge would have exceeded the size cap.
      // Disambiguate with a tiny probe so the client gets the right
      // toast.
      const probe = await sql<{ bytes: number }>`
        SELECT pg_column_size(payload)::int AS bytes
          FROM user_history
         WHERE id = ${projectId}::uuid
           AND workspace_id = ${session.ws}::uuid
           AND collaborator_id = ${session.uid}::uuid
           AND kind = 'production_doc'
         LIMIT 1
      `;
      if (probe.rows.length === 0) {
        logger.info('[row-asset attach] not found', { project_id: projectId });
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      logger.info('[row-asset attach] too large', {
        project_id: projectId,
        existing_bytes: probe.rows[0].bytes,
        cap: MAX_PAYLOAD_BYTES,
      });
      return NextResponse.json(
        { error: 'Payload would exceed size limit after merge', code: 'TOO_LARGE' },
        { status: 413 },
      );
    }

    const { new_version, bytes } = updateResult.rows[0]!;
    logger.info('[row-asset attach] committed', {
      project_id: projectId,
      slot,
      row_index: rowIndex,
      new_version,
      bytes,
    });
    return NextResponse.json({ ok: true, version: new_version });
  },
);
