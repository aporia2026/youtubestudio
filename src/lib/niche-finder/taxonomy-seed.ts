/**
 * Lazy curated-seed loader for the niche taxonomy.
 *
 * The 12 categories and their 4-6 curated sub-niches live in
 * `categories.ts`. We don't insert them in the migration because we
 * want `categories.ts` to remain the source of truth — if the operator
 * adds a category there, the next first-touch for a locale picks it
 * up automatically. The migration only creates the empty tables.
 *
 * Strategy:
 *   - On the first GET for (parent=NULL, language, region), seed the
 *     12 categories. `upsertNode` is idempotent so re-running is safe.
 *   - On the first GET for (parent=<category-id>, language, region),
 *     seed the category's curated sub-niches. Then the route layer
 *     triggers an AI expansion to add more.
 *   - Micro-niches have NO curated seed — they're AI-only.
 *
 * The names are stored verbatim from `categories.ts`. They're already
 * monetization-tilted and YouTube-searchable; no translation happens
 * at the seed level. If we ever want localised curated names per
 * locale, we'd add them as additional rows in `categories.ts` rather
 * than auto-translating here (rule: AI translates content that's
 * already user-visible, not curation).
 */
import { NICHE_CATEGORIES, type NicheCategory } from './categories';
import { slugifyNiche, normalizeNicheName } from './slug';
import { upsertNode, type TaxonomyNodeRow } from './taxonomy-db';

/** Seed all 12 categories for (language, region). Idempotent — calling
 *  twice in the same locale returns the existing rows. */
export async function seedCategories(
  language: string,
  region: string,
): Promise<TaxonomyNodeRow[]> {
  const out: TaxonomyNodeRow[] = [];
  for (const cat of NICHE_CATEGORIES) {
    const row = await upsertNode({
      parentId: null,
      slug: cat.slug,
      name: cat.name,
      level: 'category',
      source: 'curated',
      language,
      region,
      rationale: cat.description,
    });
    out.push(row);
  }
  return out;
}

/** Seed the curated sub-niches for one category under (language, region).
 *  Looks up the category by slug in `NICHE_CATEGORIES`; returns an empty
 *  array if the category is unknown (so the caller can decide whether to
 *  fail or just rely on AI expansion). */
export async function seedSubNichesForCategory(
  parentNode: TaxonomyNodeRow,
  language: string,
  region: string,
): Promise<TaxonomyNodeRow[]> {
  const category: NicheCategory | undefined = NICHE_CATEGORIES.find(
    (c) => c.slug === parentNode.slug,
  );
  if (!category) return [];
  const out: TaxonomyNodeRow[] = [];
  for (const subNicheName of category.subNiches) {
    const row = await upsertNode({
      parentId: parentNode.id,
      slug: slugifyNiche(subNicheName),
      name: normalizeNicheName(subNicheName),
      level: 'subniche',
      source: 'curated',
      language,
      region,
      rationale: `Curated sub-niche of ${category.name}.`,
    });
    out.push(row);
  }
  return out;
}
