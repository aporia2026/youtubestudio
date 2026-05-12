import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { discoverFromCategory } from '@/lib/niche-finder/discover-from-category';
import { NICHE_CATEGORIES } from '@/lib/niche-finder/categories';
import type { OperatorFit } from '@/lib/niche-finder/types';

/**
 * POST /api/niche-finder/discover/from-category
 *
 * Mode C (category browser). Body:
 *   {
 *     categorySlug: string,    // required — one of NICHE_CATEGORIES
 *     language?: string,
 *     region?: string,
 *     fit?: OperatorFit,
 *     force?: boolean
 *   }
 *
 * GET /api/niche-finder/discover/from-category
 *   Returns the static category list { categories: [...] }.
 *   No body, no caching concern — this is just the taxonomy.
 */
function parseOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function parseFit(value: unknown): OperatorFit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const interestsRaw = Array.isArray(obj.interests) ? obj.interests : [];
  const interests: string[] = [];
  for (const i of interestsRaw) {
    if (typeof i === 'string' && i.trim().length > 0 && interests.length < 10) {
      interests.push(i.trim().slice(0, 80));
    }
  }
  const llmFitScoreRaw = obj.llmFitScore;
  const llmFitScore =
    typeof llmFitScoreRaw === 'number' && Number.isFinite(llmFitScoreRaw)
      ? Math.max(0, Math.min(1, llmFitScoreRaw))
      : 0.5;
  const llmRationale =
    typeof obj.llmRationale === 'string' ? obj.llmRationale.slice(0, 300) : '';
  const language = parseOptionalString(obj.language, 16) ?? 'en';
  const region = parseOptionalString(obj.region, 16) ?? 'US';
  return { interests, language, region, llmFitScore, llmRationale };
}

export const GET = apiRoute.authed(async () => {
  return NextResponse.json({
    categories: NICHE_CATEGORIES.map((c) => ({
      slug: c.slug,
      name: c.name,
      description: c.description,
      subNicheCount: c.subNiches.length,
    })),
  });
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
  const categorySlug = parseOptionalString(raw.categorySlug, 40);
  if (!categorySlug) {
    return NextResponse.json({ error: 'categorySlug is required' }, { status: 400 });
  }

  try {
    const result = await discoverFromCategory({
      workspaceId: session.ws,
      categorySlug,
      language: parseOptionalString(raw.language, 16),
      region: parseOptionalString(raw.region, 16),
      fit: parseFit(raw.fit),
      force: raw.force === true,
    });
    if (!result.category) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: discover/from-category',
      fallbackMessage: 'Could not load this category. Try again in a moment.',
    });
  }
});
