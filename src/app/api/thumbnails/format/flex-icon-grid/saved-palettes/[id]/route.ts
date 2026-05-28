import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteSavedPalette, getSavedPalette } from '@/lib/flex-icon-grid-saved-palettes-db';

/**
 * Flex Icon Grid — workspace-scoped saved palette by id.
 *
 *   GET     — fetch one palette (returns 404 on cross-workspace ids).
 *   DELETE  — remove the palette (returns 404 on cross-workspace ids).
 *
 * Pure workspace-tenancy: every query is gated on session.ws.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const palette = await getSavedPalette(id, session.ws);
  if (!palette) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(palette);
});

export const DELETE = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const removed = await deleteSavedPalette(id, session.ws);
  if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
});
