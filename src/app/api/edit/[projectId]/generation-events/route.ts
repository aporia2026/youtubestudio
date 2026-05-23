/**
 * POST /api/edit/[projectId]/generation-events
 *
 * Insert a new entry into the editor's animation-generation history
 * log. Fired by the client immediately after a successful kickoff
 * (POST /api/broll has returned a `brollClipId`). The entry starts
 * in `status='generating'` and is later PATCHed by the route in
 * `./[eventId]/route.ts` once polling reaches a terminal state.
 *
 * Auth model: standard editor-project ownership — the WHERE clause on
 * `user_history` binds `workspace_id` + `collaborator_id` so a leaked
 * project id from another scope is indistinguishable from a
 * non-existent row. Same convention as `row-asset/route.ts`.
 *
 * Failure mode contract: a logging-table insert that fails MUST NOT
 * break the actual generation. The client's helper (`generation-events.ts`)
 * wraps every call in a try/catch and never throws to the kickoff
 * handler — this route is best-effort observability, not load-bearing
 * for the clip itself.
 *
 * GET /api/edit/[projectId]/generation-events?limit=200
 *
 * List the project's history events, newest first. Reconciles stuck
 * `generating` entries on read: if the underlying `broll_clips.status`
 * is `ready` / `failed` but the event is still `generating` (e.g.
 * client crashed mid-poll), the GET response surfaces the broll_clips
 * status so the UI shows the truth. The reconciliation does NOT write
 * back to the events row — the next PATCH (or the next session's
 * poll loop) will. This keeps GET strictly read-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROW_INDEX = 1000;
const MAX_MODEL_ID_LEN = 200;
const MAX_PROMPT_EXCERPT_LEN = 140;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

interface PostBody {
  rowIndex?: unknown;
  brollClipId?: unknown;
  modelId?: unknown;
  eventType?: unknown;     // 'generate' | 'regenerate'
  promptExcerpt?: unknown; // optional, will be truncated to 140 chars
}

interface ProjectProbeRow {
  exists: number;
}

interface EventRow {
  id: string;
  project_id: string;
  row_index: number;
  broll_clip_id: string;
  model_id: string;
  event_type: 'generate' | 'regenerate';
  status: 'generating' | 'ready' | 'failed';
  error_message: string | null;
  prompt_excerpt: string | null;
  created_at: string;
  completed_at: string | null;
  // Joined from broll_clips for reconciliation on GET.
  clip_status: string | null;
  clip_error_message: string | null;
  clip_completed_at: string | null;
}

export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) => {
    const { limited } = checkRateLimit(`gen-events-post:${getClientIP(req)}`, 240, 60_000);
    if (limited) {
      return NextResponse.json({ error: 'Too many history writes — slow down.' }, { status: 429 });
    }

    const { projectId } = await ctx.params;
    if (!UUID_RE.test(projectId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (
      typeof body.rowIndex !== 'number' ||
      !Number.isInteger(body.rowIndex) ||
      body.rowIndex < 0 ||
      body.rowIndex > MAX_ROW_INDEX
    ) {
      return NextResponse.json(
        { error: `rowIndex must be an integer in [0, ${MAX_ROW_INDEX}]` },
        { status: 400 },
      );
    }
    const rowIndex = body.rowIndex;

    if (typeof body.brollClipId !== 'string' || !UUID_RE.test(body.brollClipId)) {
      return NextResponse.json({ error: 'brollClipId must be a UUID string' }, { status: 400 });
    }
    const brollClipId = body.brollClipId;

    if (typeof body.modelId !== 'string' || body.modelId.length === 0 || body.modelId.length > MAX_MODEL_ID_LEN) {
      return NextResponse.json(
        { error: `modelId must be a non-empty string under ${MAX_MODEL_ID_LEN} chars` },
        { status: 400 },
      );
    }
    const modelId = body.modelId;

    if (body.eventType !== 'generate' && body.eventType !== 'regenerate') {
      return NextResponse.json(
        { error: "eventType must be 'generate' or 'regenerate'" },
        { status: 400 },
      );
    }
    const eventType = body.eventType;

    let promptExcerpt: string | null = null;
    if (body.promptExcerpt !== undefined && body.promptExcerpt !== null) {
      if (typeof body.promptExcerpt !== 'string') {
        return NextResponse.json(
          { error: 'promptExcerpt must be a string when present' },
          { status: 400 },
        );
      }
      promptExcerpt = body.promptExcerpt.slice(0, MAX_PROMPT_EXCERPT_LEN);
    }

    // Ownership gate. We probe user_history with the full
    // (workspace_id, collaborator_id, kind) bind before the insert so
    // a leaked projectId from another scope yields 404, not a
    // foreign-key violation surface that would distinguish "exists in
    // another scope" from "doesn't exist."
    const probe = await sql<ProjectProbeRow>`
      SELECT 1 AS exists
        FROM user_history
       WHERE id = ${projectId}::uuid
         AND workspace_id = ${session.ws}::uuid
         AND collaborator_id = ${session.uid}::uuid
         AND kind = 'production_doc'
       LIMIT 1
    `;
    if (probe.rows.length === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    logger.info('[api generation-events post] start', {
      project_id: projectId,
      workspace_id: session.ws,
      row_index: rowIndex,
      broll_clip_id: brollClipId,
      model_id: modelId,
      event_type: eventType,
    });

    const inserted = await sql<{ id: string; created_at: string }>`
      INSERT INTO generation_events
        (project_id, row_index, broll_clip_id, model_id, event_type, status, prompt_excerpt)
      VALUES
        (${projectId}::uuid, ${rowIndex}, ${brollClipId}::uuid, ${modelId},
         ${eventType}, 'generating', ${promptExcerpt})
      RETURNING id, created_at
    `;

    const row = inserted.rows[0]!;
    logger.info('[api generation-events post] committed', {
      project_id: projectId,
      event_id: row.id,
      row_index: rowIndex,
    });
    return NextResponse.json({ ok: true, id: row.id, createdAt: row.created_at });
  },
);

export const GET = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) => {
    const { limited } = checkRateLimit(`gen-events-get:${getClientIP(req)}`, 240, 60_000);
    if (limited) {
      return NextResponse.json({ error: 'Too many history reads — slow down.' }, { status: 429 });
    }

    const { projectId } = await ctx.params;
    if (!UUID_RE.test(projectId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const limitRaw = req.nextUrl.searchParams.get('limit');
    let limit = DEFAULT_LIST_LIMIT;
    if (limitRaw !== null) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_LIST_LIMIT) {
        return NextResponse.json(
          { error: `limit must be an integer in (0, ${MAX_LIST_LIMIT}]` },
          { status: 400 },
        );
      }
      limit = parsed;
    }

    // Single query that lists events for the project AND verifies
    // ownership in the same WHERE — joining through user_history with
    // the full scope bind means a leaked projectId returns zero rows
    // (indistinguishable from "no events yet"), matching POST's 404
    // semantics for ownership failure but biased toward not leaking
    // existence on a read.
    const rows = await sql<EventRow>`
      SELECT ge.id,
             ge.project_id,
             ge.row_index,
             ge.broll_clip_id,
             ge.model_id,
             ge.event_type,
             ge.status,
             ge.error_message,
             ge.prompt_excerpt,
             ge.created_at,
             ge.completed_at,
             bc.status        AS clip_status,
             bc.error_message AS clip_error_message,
             bc.completed_at  AS clip_completed_at
        FROM generation_events ge
        JOIN user_history uh ON uh.id = ge.project_id
        LEFT JOIN broll_clips bc ON bc.id = ge.broll_clip_id
       WHERE ge.project_id = ${projectId}::uuid
         AND uh.workspace_id = ${session.ws}::uuid
         AND uh.collaborator_id = ${session.uid}::uuid
         AND uh.kind = 'production_doc'
       ORDER BY ge.created_at DESC
       LIMIT ${limit}
    `;

    // Reconcile on read — see header comment. If the event is stuck
    // in 'generating' but the clip has moved on, surface the clip's
    // status / error / completed_at so the UI shows the truth even
    // when no PATCH ever lands.
    const events = rows.rows.map((r) => {
      const isStuck =
        r.status === 'generating' &&
        r.clip_status !== null &&
        r.clip_status !== 'generating' &&
        r.clip_status !== 'pending';
      return {
        id: r.id,
        rowIndex: r.row_index,
        brollClipId: r.broll_clip_id,
        modelId: r.model_id,
        eventType: r.event_type,
        status: isStuck ? (r.clip_status as 'ready' | 'failed') : r.status,
        errorMessage: isStuck ? r.clip_error_message : r.error_message,
        promptExcerpt: r.prompt_excerpt,
        createdAt: r.created_at,
        completedAt: isStuck ? r.clip_completed_at : r.completed_at,
        reconciled: isStuck,
      };
    });

    logger.info('[api generation-events get] served', {
      project_id: projectId,
      count: events.length,
      reconciled: events.filter((e) => e.reconciled).length,
    });
    return NextResponse.json({ events });
  },
);
