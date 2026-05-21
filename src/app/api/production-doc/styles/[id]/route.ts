/**
 * PATCH  /api/production-doc/styles/[id]  — update a saved style. Body
 *                                           accepts any subset of the
 *                                           same fields POST accepts.
 *                                           Every mutating field bumps
 *                                           `version` so test renders
 *                                           and (later) generated
 *                                           images can pin to the
 *                                           exact incarnation that
 *                                           produced them.
 *
 *                                           Passing `{ save: true }`
 *                                           is the editor "Save style"
 *                                           click: flips `draft=false`,
 *                                           stamps `approved_at`, and
 *                                           backfills `ai_image_suffix`
 *                                           from `style_prompt` when
 *                                           the legacy column is empty.
 *
 * DELETE /api/production-doc/styles/[id]  — delete a saved style.
 *                                           Cascades to refs +
 *                                           test renders via FK CASCADE
 *                                           (migration 0080). R2 ref
 *                                           cleanup is best-effort —
 *                                           orphan blobs are tolerable
 *                                           short-term and a sweeper
 *                                           job can pick them up later.
 *
 * Built-in styles (cinematic, animation_2d, doodle_explainer, …) are
 * not in the table and cannot be modified — the routes 404 for any
 * non-UUID id.
 *
 * Ownership: owner-private styles (owner_id IS NOT NULL) are mutable
 * only by their owner. Workspace-wide styles (owner_id IS NULL) are
 * mutable by any workspace member, matching the v1 contract for shared
 * saved styles.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { assertStyleOwnership, type SavedStyleRow } from '@/lib/production-doc-styles';
import { logger } from '@/lib/logger';
import { deleteImagesObject } from '@/lib/r2';
import { validateStyleInput } from '../route';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Built-in styles cannot be edited' }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const validation = validateStyleInput(body, { requireName: false, requireSuffix: false });
    if ('error' in validation) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Ownership guard. assertStyleOwnership returns the current row so
    // we can read its current ai_image_suffix / style_prompt during the
    // save backfill below without an extra round-trip.
    let current: SavedStyleRow;
    try {
      current = await assertStyleOwnership(id, session.ws, session.uid);
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

    // Build the column set the caller actually wants to write. Every
    // mutating column lands here; `version`, `updated_at`, and the
    // optional save-lifecycle columns are appended unconditionally
    // when there's at least one mutating field.
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, val: unknown) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    // PATCH only writes name when caller sent a non-empty trimmed
    // string. Without this guard, `{ name: "" }` silently writes
    // empty + bumps version + collides with the NOT NULL on display
    // surfaces. Caller sending `null` (not a string) is rejected by
    // the validator earlier.
    if (typeof body.name === 'string' && validation.name.length > 0) {
      push('name', validation.name);
    }
    if ('description' in body) push('description', validation.description);
    if (typeof body.ai_image_suffix === 'string' && body.ai_image_suffix.trim().length > 0) {
      push('ai_image_suffix', validation.ai_image_suffix);
    }
    if ('mixing_rules' in body) push('mixing_rules', validation.mixing_rules);
    if ('allow_overlay_stock' in body) push('allow_overlay_stock', validation.allow_overlay_stock);
    if ('based_on_built_in' in body) push('based_on_built_in', validation.based_on_built_in);
    if ('style_prompt' in body) push('style_prompt', validation.style_prompt);
    if ('preferred_cloud_model' in body) push('preferred_cloud_model', validation.preferred_cloud_model);

    const saveRequested = body.save === true;

    // Save lifecycle: the editor's "Save style" button. Drafts flip to
    // visible (`draft=false`) and approved_at is stamped. If the legacy
    // ai_image_suffix is still empty, fall back to style_prompt so the
    // existing prompt-builder code path (which appends ai_image_suffix
    // to every generation) has something to work with. Refs carry the
    // aesthetic in v2, but the suffix remains a useful textual cue.
    if (saveRequested) {
      const nextSuffix =
        // explicit suffix in this request
        (typeof validation.ai_image_suffix === 'string' && validation.ai_image_suffix.length > 0)
          ? validation.ai_image_suffix
          // already-stored suffix
          : (current.ai_image_suffix && current.ai_image_suffix.length > 0)
            ? current.ai_image_suffix
            // backfill from style_prompt (new or existing)
            : (validation.style_prompt ?? current.style_prompt ?? '');
      // Only write the backfill if it differs from what's already there
      // (avoids a no-op overwrite that would still bump version).
      if (nextSuffix !== current.ai_image_suffix) {
        push('ai_image_suffix', nextSuffix);
      }
      sets.push('draft = FALSE');
      sets.push('approved_at = NOW()');
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: 'No updatable fields supplied' }, { status: 400 });
    }
    // Every PATCH bumps version + updated_at. Including these even
    // when only save:true was sent so a save-after-edit still pins
    // version monotonically forward.
    sets.push('version = version + 1');
    sets.push('updated_at = NOW()');

    values.push(id);
    values.push(session.ws);
    const idParam = values.length - 1;
    const wsParam = values.length;

    try {
      const { rows } = await sql.query<SavedStyleRow>(
        `UPDATE production_doc_styles
         SET ${sets.join(', ')}
         WHERE id = $${idParam}::uuid AND workspace_id = $${wsParam}::uuid
         RETURNING id, workspace_id, name, description,
                   ai_image_suffix, mixing_rules, allow_overlay_stock,
                   based_on_built_in, created_by, created_at, updated_at,
                   owner_id, draft, approved_at, version,
                   style_prompt, preferred_cloud_model`,
        values,
      );
      if (rows.length === 0) {
        return NextResponse.json({ error: 'Style not found' }, { status: 404 });
      }
      const updated = rows[0];
      logger.info('[style version bump]', {
        style_id: id,
        version_before: current.version,
        version_after: updated.version,
        save_requested: saveRequested,
        fields: Object.keys(body),
      });
      return NextResponse.json({ style: updated });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return NextResponse.json(
          { error: `A style named "${validation.name}" already exists in this workspace` },
          { status: 409 },
        );
      }
      throw err;
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Built-in styles cannot be deleted' }, { status: 404 });
    }

    // Ownership guard before any destructive op. STYLE_NOT_FOUND is
    // idempotent-ish (the row's already gone), STYLE_FORBIDDEN is a
    // hard 403 — another user owns this private style.
    try {
      await assertStyleOwnership(id, session.ws, session.uid);
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

    // Pull the ref keys before the DB cascade vaporises them, so we
    // can best-effort delete from R2 after the DB commit. We don't
    // block the DELETE response on R2 cleanup — orphan blobs cost
    // pennies a year and a sweeper job picks them up if anything
    // here fails.
    const { rows: refRows } = await sql<{ r2_bucket: string; r2_key: string }>`
      SELECT r2_bucket, r2_key FROM style_reference_images WHERE style_id = ${id}
    `;

    const { rowCount } = await sql`
      DELETE FROM production_doc_styles
      WHERE id = ${id} AND workspace_id = ${session.ws}
    `;
    if (rowCount === 0) {
      return NextResponse.json({ error: 'Style not found' }, { status: 404 });
    }

    // Fire-and-forget R2 deletes. Logged but not awaited on the
    // critical path — the user already has their 200 OK.
    for (const ref of refRows) {
      deleteImagesObject(ref.r2_key).catch((err) => {
        logger.warn('[style refs r2-delete failed]', {
          style_id: id,
          r2_key: ref.r2_key,
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    }

    logger.info('[style delete]', { style_id: id, refs_deleted: refRows.length });
    return NextResponse.json({ success: true });
  },
);

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}
