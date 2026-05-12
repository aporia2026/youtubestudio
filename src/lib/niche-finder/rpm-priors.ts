/**
 * Static category RPM prior table.
 *
 * Per the council pass: this is NOT the monetization score. It's a
 * soft prior that informs the upper bound of the monetization range.
 * The actual estimate is anchored in observed signals from the sampled
 * videos in each cluster (mid-roll eligibility, sponsor density,
 * end-screen merch presence).
 *
 * Numbers below are documented public benchmarks for YouTube ad RPM
 * across 2024-2025 sources. They are a starting line, not the truth.
 * Re-verify rows annually; the staleness check in `getRpmPrior`
 * warns when a row is more than 12 months old.
 *
 * Why ranges, not point estimates: actual RPM varies by season,
 * audience geography, content density, and ad fill — variance within
 * a category is often 3-5x. Hiding that variance behind a single
 * number is the failure mode the Contrarian flagged.
 */
import type { RpmPriorRow } from './types';
import { logger } from '@/lib/logger';

/** Keywords that, when present in a niche or cluster centroid, map
 *  to a category. First-match wins. Keep this conservative; missing
 *  matches fall through to `other` (the broadest band). */
export const RPM_CATEGORY_KEYWORDS: Record<string, readonly string[]> = {
  finance: ['finance', 'invest', 'stock', 'crypto', 'mortgage', 'credit', 'tax', 'wealth', 'retire'],
  business: ['business', 'entrepreneur', 'startup', 'saas', 'ecommerce', 'side hustle'],
  tech: ['tech', 'software', 'programming', 'code', 'coding', 'developer', 'ai', 'gadget', 'computer'],
  realestate: ['real estate', 'realty', 'property', 'landlord', 'house flip'],
  legal: ['lawyer', 'legal', 'attorney', 'law firm', 'court'],
  beauty: ['beauty', 'makeup', 'skincare', 'hair', 'nail'],
  fitness: ['fitness', 'gym', 'workout', 'bodybuilding', 'crossfit', 'weight loss'],
  food: ['food', 'recipe', 'cooking', 'chef', 'baking', 'meal prep'],
  travel: ['travel', 'vacation', 'trip', 'tourism', 'flight', 'hotel'],
  sports: ['sport', 'football', 'soccer', 'basketball', 'baseball', 'nba', 'nfl', 'mlb', 'fifa', 'olympics', 'stats'],
  gaming: ['gaming', 'gameplay', 'minecraft', 'fortnite', 'roblox', 'speedrun', 'esports'],
  music: ['music', 'song', 'guitar', 'piano', 'producer', 'beats'],
  education: ['education', 'tutorial', 'how to', 'learn', 'study', 'school'],
  history: ['history', 'historical', 'ancient', 'medieval', 'world war', 'civilization', 'dynasty'],
  military: ['military', 'army', 'navy', 'air force', 'marines', 'special forces', 'weapon', 'battlefield', 'warfare'],
  mystery: ['mystery', 'unsolved', 'paranormal', 'conspiracy', 'cryptid', 'creepy', 'haunted'],
  vlog: ['vlog', 'daily', 'lifestyle', 'family'],
  kids: ['kids', 'toy', 'cartoon', 'children', 'baby'],
  diy: ['diy', 'craft', 'woodworking', 'home improvement', 'repair'],
  auto: ['car', 'auto', 'truck', 'mechanic', 'motorcycle'],
  pets: ['dog', 'cat', 'pet', 'aquarium'],
};

/**
 * RPM bands per category, USD per 1,000 views. Public-source benchmarks;
 * actual variance within each is wide. The `asOf` column drives the
 * 12-month staleness warning logged once per process when the table is
 * read.
 *
 * Sources cited in inline comments. Categories without a strong public
 * source land in the conservative "other" bucket.
 */
const RPM_PRIORS: readonly RpmPriorRow[] = Object.freeze([
  // High RPM — paid keywords, B2B / finance / professional services
  { category: 'finance',    lowUsdPerMille: 12, highUsdPerMille: 30, source: 'Tubular 2024 + WordStream Finance CPC report 2024', asOf: '2025-09-01' },
  { category: 'business',   lowUsdPerMille: 10, highUsdPerMille: 25, source: 'Influencer Marketing Hub 2024', asOf: '2025-09-01' },
  { category: 'realestate', lowUsdPerMille: 10, highUsdPerMille: 30, source: 'WordStream Real Estate CPC 2024', asOf: '2025-09-01' },
  { category: 'legal',      lowUsdPerMille: 15, highUsdPerMille: 50, source: 'WordStream Legal CPC 2024', asOf: '2025-09-01' },
  { category: 'tech',       lowUsdPerMille:  6, highUsdPerMille: 18, source: 'Tubular 2024', asOf: '2025-09-01' },

  // Medium-high — physical-product CPMs (beauty, fitness brands, auto)
  { category: 'beauty',     lowUsdPerMille:  4, highUsdPerMille: 12, source: 'Influencer Marketing Hub 2024', asOf: '2025-09-01' },
  { category: 'fitness',    lowUsdPerMille:  3, highUsdPerMille:  9, source: 'Influencer Marketing Hub 2024', asOf: '2025-09-01' },
  { category: 'auto',       lowUsdPerMille:  5, highUsdPerMille: 14, source: 'WordStream Auto CPC 2024', asOf: '2025-09-01' },
  { category: 'food',       lowUsdPerMille:  3, highUsdPerMille:  8, source: 'Influencer Marketing Hub 2024', asOf: '2025-09-01' },

  // Medium — mainstream content categories
  { category: 'education',  lowUsdPerMille:  4, highUsdPerMille: 12, source: 'Tubular 2024 education vertical', asOf: '2025-09-01' },
  { category: 'history',    lowUsdPerMille:  3, highUsdPerMille:  9, source: 'Public creator surveys 2024 (long-form documentary range)', asOf: '2025-09-01' },
  { category: 'military',   lowUsdPerMille:  3, highUsdPerMille:  9, source: 'Public creator surveys 2024 (history/documentary adjacency)', asOf: '2025-09-01' },
  { category: 'diy',        lowUsdPerMille:  3, highUsdPerMille:  9, source: 'Influencer Marketing Hub 2024 home/DIY', asOf: '2025-09-01' },
  { category: 'travel',     lowUsdPerMille:  2, highUsdPerMille:  7, source: 'Travel CPM variance is wide; conservative band from creator surveys 2024', asOf: '2025-09-01' },

  // Lower — entertainment / lifestyle
  { category: 'music',      lowUsdPerMille:  1, highUsdPerMille:  4, source: 'Creator surveys 2024 (music has high copyright drag on monetization)', asOf: '2025-09-01' },
  { category: 'mystery',    lowUsdPerMille:  2, highUsdPerMille:  6, source: 'Documentary/entertainment band, creator surveys 2024', asOf: '2025-09-01' },
  { category: 'sports',     lowUsdPerMille:  2, highUsdPerMille:  6, source: 'Sports content has rights drag + low advertiser CPC outside live; creator surveys 2024', asOf: '2025-09-01' },
  { category: 'vlog',       lowUsdPerMille:  2, highUsdPerMille:  6, source: 'Creator surveys 2024', asOf: '2025-09-01' },
  { category: 'pets',       lowUsdPerMille:  2, highUsdPerMille:  6, source: 'Creator surveys 2024', asOf: '2025-09-01' },

  // Lowest — ad-restricted or low-CPC verticals
  { category: 'gaming',     lowUsdPerMille:  1, highUsdPerMille:  4, source: 'Tubular 2024 gaming vertical', asOf: '2025-09-01' },
  { category: 'kids',       lowUsdPerMille:  1, highUsdPerMille:  4, source: 'COPPA-restricted advertising drives down RPM substantially', asOf: '2025-09-01' },

  // Fallback bucket — wide, conservative
  { category: 'other',      lowUsdPerMille:  2, highUsdPerMille:  8, source: 'Channel-mix average across creator surveys 2024', asOf: '2025-09-01' },
]);

const CATEGORY_BY_NAME: Map<string, RpmPriorRow> = new Map(
  RPM_PRIORS.map((row) => [row.category, row]),
);

/** Months between two ISO dates (UTC). Used by the staleness check. */
function monthsBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.abs(b - a) / (1000 * 60 * 60 * 24 * 30.44);
}

let staleWarned = false;

/** Best-effort category match. Lowercases everything; first keyword
 *  hit wins. Falls through to the `other` bucket when no keyword
 *  matches. Pure — no side effects beyond the one-time staleness
 *  warning at module load. */
export function categorize(text: string): string {
  const haystack = text.toLowerCase();
  for (const [category, keywords] of Object.entries(RPM_CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (haystack.includes(kw)) return category;
    }
  }
  return 'other';
}

/** Resolve an RPM prior row for a niche-or-cluster text. Logs a
 *  staleness warning at most once per process when the matched row
 *  is more than 12 months old. */
export function getRpmPrior(text: string, nowIso = new Date().toISOString()): RpmPriorRow {
  const cat = categorize(text);
  const row = CATEGORY_BY_NAME.get(cat) ?? CATEGORY_BY_NAME.get('other')!;
  if (!staleWarned && monthsBetween(row.asOf, nowIso) > 12) {
    staleWarned = true;
    logger.warn('niche-finder: RPM prior table is older than 12 months — re-verify against current public benchmarks', {
      asOf: row.asOf,
      monthsOld: Math.round(monthsBetween(row.asOf, nowIso)),
    });
  }
  return row;
}

export const RPM_PRIORS_TABLE = RPM_PRIORS;
