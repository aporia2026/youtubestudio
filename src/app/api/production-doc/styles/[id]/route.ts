/**
 * PATCH  /api/production-doc/styles/[id]  — update a saved style. Body
 *                                           accepts any subset of the
 *                                           same fields POST accepts;
 *                                           only the fields present
 *                                           are written.
 *
 * DELETE /api/production-doc/styles/[id]  — delete a saved style.
 *
 * Built-in styles (cinematic, animation_2d, doodle_explainer, …) are
 * not in the table and cannot be modified — the routes 404 for any
 * non-UUID id.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import { validateStyleInput } from '../route';
import type { SavedStyleRow } from '@/lib/production-doc-styles';

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

    try {
      await assertOwnsResource('production_doc_styles', id, session.ws);
    } catch (err) {
      if (err instanceof ResourceNotInWorkspaceError) {
        return NextResponse.json({ error: 'Style not found' }, { status: 404 });
      }
      throw err;
    }

    // Only patch the fields the caller actually sent. We always update
    // updated_at so the picker re-orders correctly.
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, val: unknown) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    if (typeof body.name === 'string') push('name', validation.name);
    if ('description' in body) push('description', validation.description);
    if (typeof body.ai_image_suffix === 'string' && body.ai_image_suffix.trim().length > 0) {
      push('ai_image_suffix', validation.ai_image_suffix);
    }
    if ('mixing_rules' in body) push('mixing_rules', validation.mixing_rules);
    if ('allow_overlay_stock' in body) push('allow_overlay_stock', validation.allow_overlay_stock);
    if ('based_on_built_in' in body) push('based_on_built_in', validation.based_on_built_in);

    if (sets.length === 0) {
      return NextResponse.json({ error: 'No updatable fields supplied' }, { status: 400 });
    }
    sets.push(`updated_at = NOW()`);

    values.push(id);
    values.push(session.ws);
    const wsParam = values.length;
    const idParam = values.length - 1;

    try {
      const { rows } = await sql.query<SavedStyleRow>(
        `UPDATE production_doc_styles
         SET ${sets.join(', ')}
         WHERE id = $${idParam}::uuid AND workspace_id = $${wsParam}::uuid
         RETURNING id, workspace_id, name, description,
                   ai_image_suffix, mixing_rules, allow_overlay_stock,
                   based_on_built_in, created_by, created_at, updated_at`,
        values,
      );
      if (rows.length === 0) {
        return NextResponse.json({ error: 'Style not found' }, { status: 404 });
      }
      return NextResponse.json({ style: rows[0] });
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: unknown }).code === '23505'
      ) {
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
    const { rowCount } = await sql`
      DELETE FROM production_doc_styles
      WHERE id = ${id} AND workspace_id = ${session.ws}
    `;
    if (rowCount === 0) {
      return NextResponse.json({ error: 'Style not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  },
);
