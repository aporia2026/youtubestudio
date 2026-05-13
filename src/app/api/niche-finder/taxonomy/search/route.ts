/**
 * Cross-category sweet-spot scanner.
 *
 *   POST /api/niche-finder/taxonomy/search
 *   Body: {
 *     spec: BrowseFilters,
 *     language?: string,    // default 'en'
 *     region?: string,      // default 'US'
 *     limit?: number,       // default 50, max 200
 *     searchSlug?: string,  // optional — when re-running a saved search,
 *                           //   stamps last_match_count + last_rescored_at
 *   }
 *
 * Returns every scored sub-niche + micro-niche in the requested
 * locale that matches the spec, sorted by the spec's sortBy (default
 * sweet-spot). Pure DB read over cached scores — no YouTube quota
 * burn, no AI cost.
 *
 * Used by:
 *   - "Find sweet spot across all" button on the Browse Categories tab
 *   - "Run now" on a saved search from the watchlist page
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  filterAndSortDiscoveries,
  type BrowseFilters,
} from '@/lib/niche-finder/browse-filters';
import { listScoredLeavesForLocale } from '@/lib/niche-finder/taxonomy-db';
import { updateSavedSearchRunStamp } from '@/lib/niche-finder/watchlist';
import type { DiscoveryResultItem } from '@/lib/niche-finder/discoveries-db';

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const REGION_RE = /^[A-Z]{2}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface MatchPayload {
  nodeId: string;
  slug: string;
  name: string;
  level: 'subniche' | 'microniche';
  rationale: string | null;
  /** Breadcrumb-style ancestors, oldest first. For a sub-niche this is
   *  `[categoryName]`; for a micro-niche `[categoryName, subnicheName]`. */
  path: string[];
  scores: DiscoveryResultItem['scores'];
  sampleSize: number;
  scoredAt: string;
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

  const specRaw = raw.spec;
  if (!specRaw || typeof specRaw !== 'object' || Array.isArray(specRaw)) {
    return NextResponse.json({ error: 'spec is required' }, { status: 400 });
  }
  const spec = specRaw as BrowseFilters;

  const language = typeof raw.language === 'string' ? raw.language.trim() : 'en';
  const region = typeof raw.region === 'string' ? raw.region.trim().toUpperCase() : 'US';
  if (!LANG_RE.test(language) || !REGION_RE.test(region)) {
    return NextResponse.json({ error: 'Invalid language or region' }, { status: 400 });
  }

  const limitRaw = typeof raw.limit === 'number' ? Math.floor(raw.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, limitRaw));

  const searchSlug = typeof raw.searchSlug === 'string' ? raw.searchSlug : null;

  try {
    const leaves = await listScoredLeavesForLocale({
      workspaceId: session.ws,
      language,
      region,
    });

    // Adapt to DiscoveryResultItem-shape so the same client/server
    // filter function applies. Build a side-map for the path info that
    // the filtered output looks up by slug.
    const adapted: DiscoveryResultItem[] = leaves.map((l) => ({
      slug: l.id, // use id-as-slug so two niches with the same name across categories don't collide
      name: l.name,
      rationale: l.rationale ?? undefined,
      scores: l.scores,
    }));
    const filtered = filterAndSortDiscoveries(adapted, spec);
    const top = filtered.slice(0, limit);

    const byId = new Map(leaves.map((l) => [l.id, l]));
    const matches: MatchPayload[] = top.map((r) => {
      const leaf = byId.get(r.slug)!;
      const path: string[] = [];
      if (leaf.grandparent_name) path.push(leaf.grandparent_name);
      if (leaf.parent_name) path.push(leaf.parent_name);
      return {
        nodeId: leaf.id,
        slug: leaf.slug,
        name: leaf.name,
        level: leaf.level as 'subniche' | 'microniche',
        rationale: leaf.rationale,
        path,
        scores: leaf.scores,
        sampleSize: leaf.sample_size,
        scoredAt: leaf.scored_at,
      };
    });

    // If this was triggered from a saved search, stamp the run.
    if (searchSlug) {
      // Best-effort — never block the response on the stamp update.
      void updateSavedSearchRunStamp({
        workspaceId: session.ws,
        searchSlug,
        matchCount: filtered.length,
      });
    }

    return NextResponse.json({
      matches,
      totalCached: leaves.length,
      totalMatching: filtered.length,
      language,
      region,
    });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: taxonomy/search',
      fallbackMessage: 'Could not run this search.',
    });
  }
});
