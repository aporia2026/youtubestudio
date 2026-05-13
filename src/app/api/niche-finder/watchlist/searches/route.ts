/**
 * Saved Browse-Categories searches.
 *
 *   GET  /api/niche-finder/watchlist/searches  → { rows: SavedSearchRow[] }
 *   POST /api/niche-finder/watchlist/searches  → { row: SavedSearchRow }
 *     Body: { label: string, spec: BrowseFilters }
 *
 * Saved searches live in the same table as the niche watchlist
 * (per migration 0062), distinguished by `kind = 'search'` and a
 * synthetic slug `search-<uuid>`. Workspace-scoped; per-workspace cap
 * of 50 rows enforced at insert time.
 *
 * The BrowseFilters spec is stored verbatim as JSONB. The client-side
 * filter applier (`filterAndSortDiscoveries`) is already tolerant of
 * unknown fields, so a future spec evolution doesn't require a
 * migration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  addSavedSearch,
  listSavedSearches,
} from '@/lib/niche-finder/watchlist';
import type { BrowseFilters } from '@/lib/niche-finder/browse-filters';

const MAX_LABEL_LEN = 80;
const MAX_SEARCHES_PER_WORKSPACE = 50;

export const GET = apiRoute.authed(async (session) => {
  const rows = await listSavedSearches(session.ws);
  return NextResponse.json({ rows });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;

  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (label.length === 0) {
    return NextResponse.json({ error: 'A name is required.' }, { status: 400 });
  }
  if (label.length > MAX_LABEL_LEN) {
    return NextResponse.json(
      { error: `Name must be ${MAX_LABEL_LEN} characters or fewer.` },
      { status: 400 },
    );
  }

  const specRaw = raw.spec;
  if (!specRaw || typeof specRaw !== 'object' || Array.isArray(specRaw)) {
    return NextResponse.json({ error: 'spec must be an object' }, { status: 400 });
  }
  // Trust the spec shape — filterAndSortDiscoveries ignores unknown
  // fields and clamps obviously-bad values. Storing arbitrary JSONB.
  const spec = specRaw as BrowseFilters;

  // Per-workspace cap. Avoids a runaway client bloating the table.
  const existing = await listSavedSearches(session.ws);
  if (existing.length >= MAX_SEARCHES_PER_WORKSPACE) {
    return NextResponse.json(
      {
        error: `You've already saved ${MAX_SEARCHES_PER_WORKSPACE} searches. Delete one before adding another.`,
      },
      { status: 409 },
    );
  }

  try {
    const row = await addSavedSearch({
      workspaceId: session.ws,
      label,
      spec,
    });
    return NextResponse.json({ row });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: watchlist/searches POST',
      fallbackMessage: 'Could not save this search.',
    });
  }
});
