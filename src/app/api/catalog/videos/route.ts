import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  listCatalogVideos,
  normaliseFilter,
  normaliseSort,
} from '@/lib/catalog-explorer';

/**
 * POST /api/catalog/videos
 * Body: { filter?: CatalogFilter, sort?: CatalogSort, limit?: number, offset?: number }
 *
 * Phase 9.7 — the main catalog read endpoint. POST (not GET) because
 * the filter object can have many array fields and stuffing them
 * into a query string is fiddly + URL-length-bound. The filters AND
 * sort are normalised through the lib's defensive parser before
 * reaching the DB, so any garbage in the request body just falls
 * back to the defaults.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const filter = normaliseFilter(b.filter);
  const sort = normaliseSort(b.sort);
  const limit = typeof b.limit === 'number' ? b.limit : undefined;
  const offset = typeof b.offset === 'number' ? b.offset : undefined;

  try {
    const result = await listCatalogVideos({
      workspaceId: session.ws,
      filter,
      sort,
      limit,
      offset,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'catalog: list videos',
      fallbackMessage: 'Could not load the catalog — please try again.',
    });
  }
});
