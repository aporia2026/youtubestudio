import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * GET  /api/production-doc/notes?docId=<user_history.id>
 *      → { notes: ProductionDocNote[] } scoped to the caller's workspace.
 *
 * POST /api/production-doc/notes
 *      Body: { docId, rowIndex, sceneTsMs?, text, tag? }
 *      → { note: ProductionDocNote } after the row is inserted.
 *
 * Notes pin to a (doc, row, ms-within-scene) tuple. Same surface backs the
 * production-doc grid view and the editor's Stage; both clients share one
 * `useNotes(docId)` store fed by these endpoints.
 *
 * Auth: `apiRoute.authed` provides `session.ws`. Every read filters by
 * `workspace_id = session.ws`; the POST verifies the target doc lives in
 * the caller's workspace before touching the table. The schema's CHECK
 * constraints catch malformed values from a broken client, so the route
 * itself only needs the shallow shape checks that produce useful 400s.
 */

const MAX_TEXT_LENGTH = 5000;
const ALLOWED_TAGS = new Set(['R', 'T', 'S', 'I', 'P', 'Q'] as const);
type AllowedTag = 'R' | 'T' | 'S' | 'I' | 'P' | 'Q';

export interface ProductionDocNote {
  id: string;
  docId: string;
  rowIndex: number;
  sceneTsMs: number;
  text: string;
  tag: AllowedTag | null;
  resolved: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface DbRow {
  id: string;
  doc_id: string;
  row_index: number;
  scene_ts_ms: number;
  text: string;
  tag: string | null;
  resolved: boolean;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function rowToNote(row: DbRow): ProductionDocNote {
  return {
    id: row.id,
    docId: row.doc_id,
    rowIndex: row.row_index,
    sceneTsMs: row.scene_ts_ms,
    text: row.text,
    tag: row.tag && ALLOWED_TAGS.has(row.tag as AllowedTag) ? (row.tag as AllowedTag) : null,
    resolved: row.resolved,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = apiRoute.authed(async (session, req) => {
  const url = new URL(req.url);
  const docId = url.searchParams.get('docId');
  if (!docId || !UUID_RE.test(docId)) {
    return NextResponse.json({ error: 'docId (UUID) required' }, { status: 400 });
  }

  // Workspace scope is enforced on the index-friendly `workspace_id`
  // column (matches the partial index on `idx_pdn_workspace`). We don't
  // need to join `user_history` to filter; the notes table carries the
  // workspace_id at INSERT time.
  const { rows } = await sql<DbRow>`
    SELECT id, doc_id, row_index, scene_ts_ms, text, tag, resolved,
           created_by, created_at, updated_at
    FROM production_doc_notes
    WHERE doc_id = ${docId}::uuid
      AND workspace_id = ${session.ws}::uuid
    ORDER BY row_index ASC, scene_ts_ms ASC, created_at ASC
  `;

  return NextResponse.json({ notes: rows.map(rowToNote) });
});

export const POST = apiRoute.authed(async (session, req) => {
  let body: {
    docId?: string;
    rowIndex?: number;
    sceneTsMs?: number;
    text?: string;
    tag?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const docId = typeof body.docId === 'string' ? body.docId.trim() : '';
  if (!docId || !UUID_RE.test(docId)) {
    return NextResponse.json({ error: 'docId (UUID) required' }, { status: 400 });
  }

  const rowIndex = Number(body.rowIndex);
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    return NextResponse.json({ error: 'rowIndex must be a non-negative integer' }, { status: 400 });
  }

  const sceneTsMs = body.sceneTsMs == null ? 0 : Number(body.sceneTsMs);
  if (!Number.isInteger(sceneTsMs) || sceneTsMs < 0) {
    return NextResponse.json({ error: 'sceneTsMs must be a non-negative integer' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `text exceeds ${MAX_TEXT_LENGTH} characters` },
      { status: 400 },
    );
  }

  let tag: AllowedTag | null = null;
  if (body.tag != null && body.tag !== '') {
    const candidate = String(body.tag).toUpperCase();
    if (!ALLOWED_TAGS.has(candidate as AllowedTag)) {
      return NextResponse.json(
        { error: 'tag must be one of R, T, S, I, P, Q' },
        { status: 400 },
      );
    }
    tag = candidate as AllowedTag;
  }

  // Verify the doc lives in the caller's workspace BEFORE inserting.
  // Don't leak existence to a different-workspace member — same 404 path
  // for "doc not found" and "doc belongs to someone else."
  const docCheck = await sql<{ workspace_id: string }>`
    SELECT workspace_id FROM user_history
    WHERE id = ${docId}::uuid AND kind = 'production_doc'
  `;
  if (docCheck.rows.length === 0 || docCheck.rows[0].workspace_id !== session.ws) {
    return NextResponse.json({ error: 'Doc not found' }, { status: 404 });
  }

  const inserted = await sql<DbRow>`
    INSERT INTO production_doc_notes (
      doc_id, workspace_id, created_by, row_index, scene_ts_ms, text, tag
    )
    VALUES (
      ${docId}::uuid, ${session.ws}::uuid, ${session.uid}::uuid,
      ${rowIndex}, ${sceneTsMs}, ${text}, ${tag}
    )
    RETURNING id, doc_id, row_index, scene_ts_ms, text, tag, resolved,
              created_by, created_at, updated_at
  `;
  const note = rowToNote(inserted.rows[0]);

  logger.info('production-doc-notes: created', {
    noteId: note.id,
    docId,
    rowIndex,
    tag,
  });

  return NextResponse.json({ note }, { status: 201 });
});
