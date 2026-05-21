/**
 * PATCH  /api/production-doc/styles/[id]/refs/[refId]
 *   Body: any subset of:
 *     - position: integer (0..MAX_REFS_PER_STYLE-1) — drag-reorder
 *     - role: 'style' | 'character' | 'palette' | 'composition'
 *             (forward-compat; v1 UI never sends this)
 *     - weight: number 0..1 (forward-compat; v1 UI never sends this)
 *     - clear_rejection: true — resets rejected_by_provider so the
 *             next generation tries this ref again. Editor's
 *             "Clear rejection" affordance maps here.
 *   Returns: { ref }
 *
 * DELETE /api/production-doc/styles/[id]/refs/[refId]
 *   Removes the row and best-effort deletes the R2 object. The
 *   parent style's version bumps so any downstream pin can detect
 *   the change.
 *
 * Both routes 404 when the refId doesn't belong to the styleId or
 * the caller doesn't own the parent style.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { sql } from '@vercel/postgres';
import { assertStyleOwnership } from '@/lib/production-doc-styles';
import {
  clearReferenceRejection,
  deleteStyleReference,
  type StyleReferenceImage,
} from '@/lib/production-doc-styles-refs';
import { deleteImagesObject } from '@/lib/r2';
import { logger } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(['style', 'character', 'palette', 'composition']);

interface PatchRefBody {
  position?: unknown;
  role?: unknown;
  weight?: unknown;
  clear_rejection?: unknown;
}

export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string; refId: string }> }) => {
    const { id: styleId, refId } = await ctx.params;
    if (!UUID_RE.test(styleId) || !UUID_RE.test(refId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    try {
      await assertStyleOwnership(styleId, session.ws, session.uid);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'STYLE_NOT_FOUND') {
        return NextResponse.json({ error: 'Style not found' }, { status: 404 });
      }
      if (code === 'STYLE_FORBIDDEN') {
        return NextResponse.json({ error: 'Style is private to another user' }, { status: 403 });
      }
      throw err;
    }

    let body: PatchRefBody;
    try {
      body = (await req.json()) as PatchRefBody;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // clear_rejection is its own opcode — distinct from position /
    // role / weight which mutate the ref. Handled first so a request
    // that mixes both still produces a sensible final state.
    if (body.clear_rejection === true) {
      await clearReferenceRejection(refId, styleId);
      logger.info('[style refs rejection clear]', { style_id: styleId, ref_id: refId });
    }

    // Build dynamic SET list for the remaining mutating fields.
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, val: unknown) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    if (body.position !== undefined) {
      if (typeof body.position !== 'number' || !Number.isFinite(body.position) || body.position < 0 || body.position > 7) {
        return NextResponse.json({ error: 'position must be an integer between 0 and 7' }, { status: 400 });
      }
      push('position', Math.floor(body.position));
    }
    if (body.role !== undefined) {
      if (typeof body.role !== 'string' || !ALLOWED_ROLES.has(body.role)) {
        return NextResponse.json({ error: `role must be one of: ${[...ALLOWED_ROLES].join(', ')}` }, { status: 400 });
      }
      push('role', body.role);
    }
    if (body.weight !== undefined) {
      if (typeof body.weight !== 'number' || !Number.isFinite(body.weight) || body.weight < 0 || body.weight > 1) {
        return NextResponse.json({ error: 'weight must be a number between 0 and 1' }, { status: 400 });
      }
      push('weight', body.weight);
    }

    // If neither set of mutations nor a clear_rejection was supplied,
    // there's nothing to do. Returning 400 surfaces malformed clients
    // instead of pretending success.
    if (sets.length === 0 && body.clear_rejection !== true) {
      return NextResponse.json({ error: 'No updatable fields supplied' }, { status: 400 });
    }

    let updatedRef: StyleReferenceImage | undefined;
    if (sets.length > 0) {
      values.push(refId);
      values.push(styleId);
      const refIdParam = values.length - 1;
      const styleIdParam = values.length;
      try {
        const { rows } = await sql.query<StyleReferenceImage>(
          `UPDATE style_reference_images
              SET ${sets.join(', ')}
            WHERE id = $${refIdParam}::uuid
              AND style_id = $${styleIdParam}::uuid
            RETURNING id, style_id, workspace_id, position, role, weight,
                      r2_bucket, r2_key, size_bytes, mime_type, width, height,
                      rejected_by_provider, rejection_reason, rejection_provider,
                      rejected_at, created_at`,
          values,
        );
        if (rows.length === 0) {
          return NextResponse.json({ error: 'Reference not found' }, { status: 404 });
        }
        updatedRef = rows[0];
      } catch (err) {
        // 23505 — unique position collision on (style_id, position).
        // Drag-reorder UIs need to swap two refs in a transaction;
        // surfacing the collision lets the client retry with a sane
        // sequence instead of half-committing.
        if (
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: unknown }).code === '23505'
        ) {
          return NextResponse.json(
            { error: 'Another reference already occupies that position' },
            { status: 409 },
          );
        }
        throw err;
      }
    } else {
      // clear_rejection only — re-read the row to return the current state.
      const { rows } = await sql<StyleReferenceImage>`
        SELECT id, style_id, workspace_id, position, role, weight,
               r2_bucket, r2_key, size_bytes, mime_type, width, height,
               rejected_by_provider, rejection_reason, rejection_provider,
               rejected_at, created_at
        FROM style_reference_images
        WHERE id = ${refId} AND style_id = ${styleId}
        LIMIT 1
      `;
      if (rows.length === 0) {
        return NextResponse.json({ error: 'Reference not found' }, { status: 404 });
      }
      updatedRef = rows[0];
    }

    return NextResponse.json({ ref: updatedRef });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req: NextRequest, ctx: { params: Promise<{ id: string; refId: string }> }) => {
    const { id: styleId, refId } = await ctx.params;
    if (!UUID_RE.test(styleId) || !UUID_RE.test(refId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    try {
      await assertStyleOwnership(styleId, session.ws, session.uid);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'STYLE_NOT_FOUND') {
        return NextResponse.json({ error: 'Style not found' }, { status: 404 });
      }
      if (code === 'STYLE_FORBIDDEN') {
        return NextResponse.json({ error: 'Style is private to another user' }, { status: 403 });
      }
      throw err;
    }

    // deleteStyleReference now enforces the (refId, styleId) binding
    // internally — if the ref belongs to a different style, the
    // DELETE matches zero rows and returns null, which we surface
    // as a 404. No separate bind check needed.
    const deleted = await deleteStyleReference(refId, styleId);
    if (!deleted) {
      // Race: the row vanished between the bind check and the delete.
      // Idempotent — return 404 once.
      return NextResponse.json({ error: 'Reference not found' }, { status: 404 });
    }

    // Best-effort R2 cleanup. Logged but not awaited on the user
    // path — the DB row is gone and the orphan blob is harmless.
    deleteImagesObject(deleted.r2_key).catch((err) => {
      logger.warn('[style refs r2-delete failed]', {
        style_id: styleId,
        ref_id: refId,
        r2_key: deleted.r2_key,
        detail: err instanceof Error ? err.message : String(err),
      });
    });

    // Bump the style's version — removing a ref changes the style's
    // identity, same as adding one.
    await sql`
      UPDATE production_doc_styles
         SET version = version + 1, updated_at = NOW()
       WHERE id = ${styleId}
    `;

    logger.info('[style refs delete]', {
      style_id: styleId,
      ref_id: refId,
      role: deleted.role,
    });

    return NextResponse.json({ success: true });
  },
);
