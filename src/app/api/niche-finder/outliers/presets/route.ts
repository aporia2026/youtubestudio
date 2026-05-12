import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createPreset,
  countPresets,
  listPresets,
  normalizePresetName,
  MAX_PRESETS_PER_WORKSPACE,
} from '@/lib/niche-finder/presets-db';
import type { OutlierFilters } from '@/lib/niche-finder/outlier-filters';

/**
 * GET  /api/niche-finder/outliers/presets        → { rows: SavedPresetRow[] }
 * POST /api/niche-finder/outliers/presets        → { row }
 *   Body: { name, nicheQuery, filters }
 *
 * Cross-workspace presets are invisible (PK is workspace-scoped).
 * Hitting the 100-row cap returns 409 with a clear message rather
 * than silently dropping the insert.
 */
export const GET = apiRoute.authed(async (session) => {
  const rows = await listPresets(session.ws);
  return NextResponse.json({ rows });
});

function parseFilters(value: unknown): OutlierFilters {
  if (!value || typeof value !== 'object') return {};
  // We re-emit through a JSON round-trip rather than trust the
  // exact shape — a defence against accidental SQL/JS injection
  // via unexpected keys. The route never *acts* on filters; it
  // just persists them as JSONB. The filter helper validates at
  // apply time client-side.
  try {
    return JSON.parse(JSON.stringify(value)) as OutlierFilters;
  } catch {
    return {};
  }
}

function parseOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

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
  const name = normalizePresetName(raw.name);
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  const nicheQuery = parseOptionalString(raw.nicheQuery, 200) ?? '';
  const filters = parseFilters(raw.filters);

  try {
    const count = await countPresets(session.ws);
    if (count >= MAX_PRESETS_PER_WORKSPACE) {
      return NextResponse.json(
        {
          error: `Too many saved searches (cap is ${MAX_PRESETS_PER_WORKSPACE}). Delete one first.`,
        },
        { status: 409 },
      );
    }
    const row = await createPreset({
      workspaceId: session.ws,
      name,
      nicheQuery,
      filters,
    });
    return NextResponse.json({ row });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: outlier presets create',
      knownPatterns: [
        // UNIQUE (workspace_id, name) collision — surface the
        // conflict so the UI can prompt to rename.
        {
          match: /duplicate key|unique constraint|niche_search_presets.*name/i,
          status: 409,
        },
      ],
      fallbackMessage: 'Could not save this search.',
    });
  }
});
