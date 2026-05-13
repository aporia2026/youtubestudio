/**
 * Hierarchical niche-taxonomy API.
 *
 *   GET  /api/niche-finder/taxonomy?parent=<id|"">&lang=&region=
 *        Returns the children of `parent` in (language, region) joined
 *        with each one's score for the requesting workspace.
 *
 *        On first touch for a locale:
 *          - parent="" (root): seeds the 12 curated categories from
 *            `categories.ts` and returns them. No AI call.
 *          - parent=<category-id>: seeds the curated sub-niches AND
 *            asks the AI to brainstorm ~10 more. Returns the merged
 *            list. ONE AI call, capped by `INITIAL_AI_EXPAND_COUNT`.
 *          - parent=<subniche-id>: AI-only — there's no curated micro-
 *            niche list. Generates ~15 and returns them.
 *
 *        Scoring is NOT triggered here; the client follows up with
 *        POST /taxonomy/score for nodes without a fresh score row.
 *
 *   POST /api/niche-finder/taxonomy
 *        Body: { parentId, language, region, count? }
 *        Force-brainstorms `count` more AI children (up to a per-
 *        parent cap) and returns the new rows. Rate-limited.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { checkAndIncrementRateLimit } from '@/lib/rate-limit-db';
import {
  countChildren,
  getNode,
  listChildrenWithScores,
  upsertNode,
  type TaxonomyLevel,
  type TaxonomyNodeRow,
  type TaxonomyNodeWithScoreRow,
} from '@/lib/niche-finder/taxonomy-db';
import {
  seedCategories,
  seedSubNichesForCategory,
} from '@/lib/niche-finder/taxonomy-seed';
import { generateTaxonomyChildren } from '@/lib/niche-finder/taxonomy-generate';
import type { AiSpendContext } from '@/lib/ai-spend';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Initial AI brainstorm count on first locale-touch of a category. */
const INITIAL_AI_EXPAND_COUNT_SUBNICHE = 10;
/** Initial AI brainstorm count on first locale-touch of a sub-niche
 *  (micro-niche generation). */
const INITIAL_AI_EXPAND_COUNT_MICRONICHE = 15;

/** Per-parent cap on children. Once this many children exist for a
 *  (parent, locale) tuple, the "Brainstorm more" button no-ops. */
const MAX_CHILDREN_PER_PARENT = 50;

/** Force-expand rate limit: how many POSTs a workspace can make. */
const FORCE_EXPAND_RATE_LIMIT = 10;
const FORCE_EXPAND_RATE_WINDOW_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const REGION_RE = /^[A-Z]{2}$/;

function parseLocale(rawLang: string | null, rawRegion: string | null): { language: string; region: string } | null {
  const language = (rawLang ?? 'en').trim();
  const region = (rawRegion ?? 'US').trim().toUpperCase();
  if (!LANG_RE.test(language)) return null;
  if (!REGION_RE.test(region)) return null;
  return { language, region };
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface TaxonomyChildPayload {
  id: string;
  parent_id: string | null;
  slug: string;
  name: string;
  level: TaxonomyLevel;
  source: 'curated' | 'ai' | 'harvested';
  rationale: string | null;
  scores: TaxonomyNodeWithScoreRow['scores'];
  scored_at: string | null;
  sample_size: number | null;
}

function toPayload(row: TaxonomyNodeWithScoreRow): TaxonomyChildPayload {
  return {
    id: row.id,
    parent_id: row.parent_id,
    slug: row.slug,
    name: row.name,
    level: row.level,
    source: row.source,
    rationale: row.rationale,
    scores: row.scores,
    scored_at: row.scored_at,
    sample_size: row.sample_size,
  };
}

function nodeToPayload(row: TaxonomyNodeRow): TaxonomyChildPayload {
  return {
    id: row.id,
    parent_id: row.parent_id,
    slug: row.slug,
    name: row.name,
    level: row.level,
    source: row.source,
    rationale: row.rationale,
    scores: null,
    scored_at: null,
    sample_size: null,
  };
}

// ---------------------------------------------------------------------------
// GET — browse
// ---------------------------------------------------------------------------

export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const rawParent = searchParams.get('parent');
  const parentId = rawParent && rawParent.length > 0 ? rawParent : null;
  if (parentId !== null && !UUID_RE.test(parentId)) {
    return NextResponse.json({ error: 'Invalid parent id' }, { status: 400 });
  }
  const locale = parseLocale(searchParams.get('lang'), searchParams.get('region'));
  if (!locale) {
    return NextResponse.json({ error: 'Invalid language or region' }, { status: 400 });
  }

  try {
    // Fast path: list whatever's in the DB. If empty, fall through to
    // seed + AI expansion as appropriate for the level.
    let rows = await listChildrenWithScores({
      workspaceId: session.ws,
      parentId,
      language: locale.language,
      region: locale.region,
    });

    if (rows.length === 0) {
      if (parentId === null) {
        // Root level: seed the 12 curated categories. No AI call.
        await seedCategories(locale.language, locale.region);
      } else {
        // Drilling into a category or sub-niche. Look up the parent
        // to decide which seed + expansion path applies.
        const parent = await getNode(parentId);
        if (!parent) {
          return NextResponse.json({ error: 'Unknown parent' }, { status: 404 });
        }
        // Locale guard: a parent created for (en, US) can't host
        // children for (es, MX). Avoid silently mixing locales.
        if (parent.language !== locale.language || parent.region !== locale.region) {
          return NextResponse.json(
            { error: 'Parent does not belong to this locale' },
            { status: 400 },
          );
        }
        if (parent.level === 'category') {
          // Seed curated sub-niches first so they always show up
          // (deterministic), then ask the AI for ~10 more.
          await seedSubNichesForCategory(parent, locale.language, locale.region);
          const generated = await generateTaxonomyChildren({
            workspaceId: session.ws,
            parentName: parent.name,
            childLevel: 'subniche',
            language: locale.language,
            region: locale.region,
            existingChildNames: [], // curated names + AI dedupe handled below
            count: INITIAL_AI_EXPAND_COUNT_SUBNICHE,
            spendContext: buildSpendContext(session.ws, 'first-expand-subniche', parent),
          });
          // De-dupe AI against curated by reading what we just seeded.
          const afterSeed = await listChildrenWithScores({
            workspaceId: session.ws,
            parentId,
            language: locale.language,
            region: locale.region,
          });
          const existing = new Set(afterSeed.map((r) => r.name.toLowerCase()));
          for (const g of generated) {
            if (existing.has(g.name.toLowerCase())) continue;
            await upsertNode({
              parentId,
              slug: g.slug,
              name: g.name,
              level: 'subniche',
              source: 'ai',
              language: locale.language,
              region: locale.region,
              rationale: g.rationale,
            });
          }
        } else if (parent.level === 'subniche') {
          // AI-only — no curated micro-niche list exists.
          const generated = await generateTaxonomyChildren({
            workspaceId: session.ws,
            parentName: parent.name,
            childLevel: 'microniche',
            language: locale.language,
            region: locale.region,
            existingChildNames: [],
            count: INITIAL_AI_EXPAND_COUNT_MICRONICHE,
            spendContext: buildSpendContext(session.ws, 'first-expand-microniche', parent),
          });
          for (const g of generated) {
            await upsertNode({
              parentId,
              slug: g.slug,
              name: g.name,
              level: 'microniche',
              source: 'ai',
              language: locale.language,
              region: locale.region,
              rationale: g.rationale,
            });
          }
        }
        // parent.level === 'microniche' → leaf, no children to generate.
      }

      // Re-read after seeding / expansion.
      rows = await listChildrenWithScores({
        workspaceId: session.ws,
        parentId,
        language: locale.language,
        region: locale.region,
      });
    }

    return NextResponse.json({
      parent: parentId,
      language: locale.language,
      region: locale.region,
      children: rows.map(toPayload),
    });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: taxonomy GET',
      fallbackMessage: 'Could not load this branch of the taxonomy.',
    });
  }
});

// ---------------------------------------------------------------------------
// POST — force "Brainstorm more"
// ---------------------------------------------------------------------------

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Rate-limit per workspace to keep a runaway client from burning
  // AI spend + quota. Fixed-window, 10/min default.
  const limit = await checkAndIncrementRateLimit({
    key: `niche-taxonomy.expand:${session.ws}`,
    limit: FORCE_EXPAND_RATE_LIMIT,
    windowMs: FORCE_EXPAND_RATE_WINDOW_MS,
  });
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: `Slow down — you can brainstorm at most ${FORCE_EXPAND_RATE_LIMIT} more times per minute.`,
      },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  const parentId = typeof raw.parentId === 'string' ? raw.parentId : '';
  if (!UUID_RE.test(parentId)) {
    return NextResponse.json({ error: 'Invalid parentId' }, { status: 400 });
  }
  const locale = parseLocale(
    typeof raw.language === 'string' ? raw.language : null,
    typeof raw.region === 'string' ? raw.region : null,
  );
  if (!locale) {
    return NextResponse.json({ error: 'Invalid language or region' }, { status: 400 });
  }
  const requestedCount = typeof raw.count === 'number' ? Math.floor(raw.count) : 10;
  const count = Math.max(1, Math.min(20, requestedCount));

  try {
    const parent = await getNode(parentId);
    if (!parent) {
      return NextResponse.json({ error: 'Unknown parent' }, { status: 404 });
    }
    if (parent.language !== locale.language || parent.region !== locale.region) {
      return NextResponse.json(
        { error: 'Parent does not belong to this locale' },
        { status: 400 },
      );
    }
    if (parent.level === 'microniche') {
      return NextResponse.json(
        { error: 'Cannot brainstorm under a micro-niche — three levels is the max.' },
        { status: 400 },
      );
    }

    // Headroom check — don't bloat past the per-parent cap.
    const existingCount = await countChildren(parentId, locale.language, locale.region);
    const headroom = Math.max(0, MAX_CHILDREN_PER_PARENT - existingCount);
    if (headroom === 0) {
      return NextResponse.json(
        {
          error: `This branch already has the maximum of ${MAX_CHILDREN_PER_PARENT} niches. Drill into one of them to explore further.`,
        },
        { status: 409 },
      );
    }
    const askFor = Math.min(count, headroom);

    const existing = await listChildrenWithScores({
      workspaceId: session.ws,
      parentId,
      language: locale.language,
      region: locale.region,
    });
    const existingNames = existing.map((r) => r.name);

    const childLevel: 'subniche' | 'microniche' =
      parent.level === 'category' ? 'subniche' : 'microniche';

    const generated = await generateTaxonomyChildren({
      workspaceId: session.ws,
      parentName: parent.name,
      childLevel,
      language: locale.language,
      region: locale.region,
      existingChildNames: existingNames,
      count: askFor,
      spendContext: buildSpendContext(session.ws, 'force-expand', parent),
    });

    if (generated.length === 0) {
      return NextResponse.json(
        { error: 'No new ideas this time. Try again — the model is non-deterministic.' },
        { status: 503 },
      );
    }

    const inserted: TaxonomyNodeRow[] = [];
    for (const g of generated) {
      const row = await upsertNode({
        parentId,
        slug: g.slug,
        name: g.name,
        level: childLevel,
        source: 'ai',
        language: locale.language,
        region: locale.region,
        rationale: g.rationale,
      });
      inserted.push(row);
    }

    return NextResponse.json({
      parent: parentId,
      language: locale.language,
      region: locale.region,
      added: inserted.map(nodeToPayload),
    });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: taxonomy POST',
      fallbackMessage: 'Could not brainstorm more — please try again.',
    });
  }
});

// ---------------------------------------------------------------------------
// Internal — spend context builder
// ---------------------------------------------------------------------------

function buildSpendContext(
  workspaceId: string,
  trigger: 'first-expand-subniche' | 'first-expand-microniche' | 'force-expand',
  parent: TaxonomyNodeRow,
): AiSpendContext {
  return {
    workspaceId,
    featureArea: 'niche-taxonomy-generate',
    metadata: {
      trigger,
      parent_id: parent.id,
      parent_slug: parent.slug,
      parent_level: parent.level,
      language: parent.language,
      region: parent.region,
    },
  };
}
