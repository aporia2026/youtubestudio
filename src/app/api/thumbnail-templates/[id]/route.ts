import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  getThumbnailTemplate,
  updateThumbnailTemplate,
  deleteThumbnailTemplate,
  validateThumbnailTemplateInput,
} from '@/lib/thumbnail-templates';

/**
 * GET / PATCH / DELETE for a single thumbnail-template preset.
 *
 * Workspace tenancy at the lib layer — cross-workspace ids return
 * `null` which we map to 404 with no body leakage (Phase 8.1).
 */

export const GET = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id } = await ctx.params;
  const tpl = await getThumbnailTemplate(id, session.ws);
  if (!tpl) return NextResponse.json({ error: 'Template not found.' }, { status: 404 });
  return NextResponse.json({ template: tpl });
});

export const PATCH = apiRoute.authed<{ id: string }>(async (session, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const validation = validateThumbnailTemplateInput(body, { allowPartial: true });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }
  try {
    const updated = await updateThumbnailTemplate({
      id,
      workspaceId: session.ws,
      patch: validation.value,
    });
    if (!updated) return NextResponse.json({ error: 'Template not found.' }, { status: 404 });
    return NextResponse.json({ template: updated });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'thumbnail-template: update',
      knownPatterns: [
        { match: /thumbnail_template_presets_workspace_id_name_key|duplicate key/i, status: 409 },
      ],
      fallbackMessage: 'Failed to update thumbnail template.',
    });
  }
});

export const DELETE = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id } = await ctx.params;
  const ok = await deleteThumbnailTemplate(id, session.ws);
  if (!ok) return NextResponse.json({ error: 'Template not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
});
