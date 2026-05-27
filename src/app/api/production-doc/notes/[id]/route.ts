import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * PATCH  /api/production-doc/notes/<id>
 *        Body: { text?, tag?, resolved? } — any subset.
 *        Returns the updated row.
 *
 * DELETE /api/production-doc/notes/<id>
 *        Hard delete. Soft-delete / archive is out of v1 scope; the
 *        `resolved` flag covers the common "don't surface in the review
 *        queue" case without forcing actual deletion.
 *
 * Both endpoints scope by `workspace_id = session.ws` so a member of a
 * different workspace can't address rows by guessing their UUID. We use
 * the same 404 status for "not found" and "different workspace" so the
 * endpoint can't be used as a workspace-membership probe.
 */

const MAX_TEXT_LENGTH = 5000;
const ALLOWED_TAGS = new Set(['R', 'T', 'S', 'I', 'P', 'Q'] as const);
type AllowedTag = 'R' | 'T' | 'S' | 'I' | 'P' | 'Q';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function rowToNote(row: DbRow) {
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

export const PATCH = apiRoute.authed(async (session, req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid note id' }, { status: 400 });
  }

  let body: { text?: string; tag?: string | null; resolved?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Each field is independently optional. We assemble the SET clause via
  // COALESCE-style fallbacks below so an absent key keeps the existing
  // value — same shape the codebase's other PATCH endpoints use.
  let text: string | null = null;
  if (body.text !== undefined) {
    const trimmed = String(body.text).trim();
    if (!trimmed) {
      return NextResponse.json({ error: 'text cannot be empty' }, { status: 400 });
    }
    if (trimmed.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `text exceeds ${MAX_TEXT_LENGTH} characters` },
        { status: 400 },
      );
    }
    text = trimmed;
  }

  // tag accepts:
  //   - undefined: keep current value
  //   - null / empty string: clear the tag
  //   - one of R/T/S/I/P/Q: set
  let tagAction: 'keep' | 'clear' | { set: AllowedTag } = 'keep';
  if (body.tag !== undefined) {
    if (body.tag === null || body.tag === '') {
      tagAction = 'clear';
    } else {
      const candidate = String(body.tag).toUpperCase();
      if (!ALLOWED_TAGS.has(candidate as AllowedTag)) {
        return NextResponse.json(
          { error: 'tag must be one of R, T, S, I, P, Q' },
          { status: 400 },
        );
      }
      tagAction = { set: candidate as AllowedTag };
    }
  }

  let resolved: boolean | null = null;
  if (body.resolved !== undefined) {
    if (typeof body.resolved !== 'boolean') {
      return NextResponse.json({ error: 'resolved must be a boolean' }, { status: 400 });
    }
    resolved = body.resolved;
  }

  if (text === null && tagAction === 'keep' && resolved === null) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  // We compose the UPDATE as a single statement using NULLIF/COALESCE so
  // unset fields preserve their existing value. The `tag` column needs a
  // three-way branch (keep / clear-to-null / set) which COALESCE can't
  // express alone — we encode "clear" as the literal sentinel value
  // '__CLEAR__' that the CASE statement maps to NULL.
  const tagParam =
    tagAction === 'keep' ? null : tagAction === 'clear' ? '__CLEAR__' : tagAction.set;
  const tagDirective = tagAction === 'keep' ? 'keep' : tagAction === 'clear' ? 'clear' : 'set';

  const updated = await sql<DbRow>`
    UPDATE production_doc_notes
    SET text = COALESCE(${text}, text),
        tag = CASE
          WHEN ${tagDirective} = 'keep'  THEN tag
          WHEN ${tagDirective} = 'clear' THEN NULL
          ELSE ${tagParam}
        END,
        resolved = COALESCE(${resolved}, resolved),
        updated_at = NOW()
    WHERE id = ${id}::uuid
      AND workspace_id = ${session.ws}::uuid
    RETURNING id, doc_id, row_index, scene_ts_ms, text, tag, resolved,
              created_by, created_at, updated_at
  `;
  if (updated.rows.length === 0) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 });
  }

  logger.info('production-doc-notes: updated', {
    noteId: id,
    fields: {
      text: text !== null,
      tag: tagAction !== 'keep',
      resolved: resolved !== null,
    },
  });

  return NextResponse.json({ note: rowToNote(updated.rows[0]) });
});

export const DELETE = apiRoute.authed(async (session, _req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid note id' }, { status: 400 });
  }

  const deleted = await sql<{ id: string }>`
    DELETE FROM production_doc_notes
    WHERE id = ${id}::uuid
      AND workspace_id = ${session.ws}::uuid
    RETURNING id
  `;
  if (deleted.rows.length === 0) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 });
  }

  logger.info('production-doc-notes: deleted', { noteId: id });
  return NextResponse.json({ ok: true });
});
