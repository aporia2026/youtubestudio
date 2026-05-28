import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteSavedTemplate, getSavedTemplate } from '@/lib/flex-icon-grid-saved-templates-db';

/**
 * Flex Icon Grid — workspace-scoped saved template by id.
 *
 *   GET     — fetch one template (returns 404 on cross-workspace ids).
 *   DELETE  — remove the template (returns 404 on cross-workspace ids).
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const template = await getSavedTemplate(id, session.ws);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(template);
});

export const DELETE = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const removed = await deleteSavedTemplate(id, session.ws);
  if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
});
