import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createSavedView,
  listSavedViews,
  normaliseFilter,
  normaliseSort,
  parseSavedViewName,
} from '@/lib/catalog-explorer';

/**
 * GET  /api/catalog/saved-views — list workspace's saved views.
 * POST /api/catalog/saved-views — create. Body: { name, filter, sort }.
 *
 * Phase 9.7 — saved views are workspace-scoped (any teammate can read
 * any saved view in their workspace). created_by_user_id is informational.
 */
export const GET = apiRoute.authed(async (session) => {
  try {
    const views = await listSavedViews(session.ws);
    return NextResponse.json({ views });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'catalog: list saved views',
      fallbackMessage: 'Could not load saved views.',
    });
  }
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const name = parseSavedViewName(b.name);
  if (!name) {
    return NextResponse.json(
      { error: 'name is required (1-80 chars).' },
      { status: 400 },
    );
  }
  const filter = normaliseFilter(b.filter);
  const sort = normaliseSort(b.sort);

  try {
    const view = await createSavedView({
      workspaceId: session.ws,
      createdByUserId: session.uid,
      name,
      filter,
      sort,
    });
    return NextResponse.json({ view });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'catalog: create saved view',
      fallbackMessage: 'Could not save view — please try again.',
    });
  }
});
