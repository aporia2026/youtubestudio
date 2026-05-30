import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  deleteSavedTopicCardGridPreset,
  getSavedTopicCardGridPreset,
} from '@/lib/topic-card-grid-saved-presets-db';

/**
 * Topic Card Grid — workspace-scoped saved preset by id.
 *
 *   GET     — fetch one preset (returns 404 on cross-workspace ids).
 *   DELETE  — remove the preset (returns 404 on cross-workspace ids).
 *
 * Mirrors the Flex Icon Grid saved-template [id] route's contract.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const preset = await getSavedTopicCardGridPreset(id, session.ws);
  if (!preset) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(preset);
});

export const DELETE = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const removed = await deleteSavedTopicCardGridPreset(id, session.ws);
  if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
});
