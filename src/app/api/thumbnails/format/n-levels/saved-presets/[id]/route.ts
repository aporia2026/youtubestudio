import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  deleteSavedNLevelsPreset,
  getSavedNLevelsPreset,
} from '@/lib/n-levels-saved-presets-db';

/**
 * N Levels Explained — workspace-scoped saved preset by id.
 *
 *   GET     — fetch one preset (returns 404 on cross-workspace ids).
 *   DELETE  — remove the preset (returns 404 on cross-workspace ids).
 *
 * Sibling to the Topic Card Grid saved-preset [id] route.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const preset = await getSavedNLevelsPreset(id, session.ws);
  if (!preset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(preset);
});

export const DELETE = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const removed = await deleteSavedNLevelsPreset(id, session.ws);
  if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
});
