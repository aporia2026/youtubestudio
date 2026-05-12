/**
 * Hand-curated niche taxonomy for mode C (category browser).
 *
 * Twelve categories chosen for documented monetization potential
 * (per the public-source RPM table in rpm-priors.ts). Each
 * category lists 4-6 specific sub-niches phrased so a YouTube
 * search.list returns a coherent video set. Sub-niches are
 * intentionally narrower than the category itself — vidIQ's
 * "personal finance" category is too broad to score well; "credit
 * card churning for tech workers" is the granularity at which
 * monetization signals are real.
 *
 * The taxonomy is static and dated. Phase 13.2 ships with this
 * snapshot; future updates ride along with rpm-priors.ts annual
 * refresh.
 *
 * Categories deliberately omitted: Kids (COPPA suppresses RPM),
 * Music (copyright drag), Reactions (low CPM and ToS-fragile).
 */

export interface NicheCategory {
  slug: string;
  name: string;
  description: string;
  subNiches: readonly string[];
}

export const NICHE_CATEGORIES: readonly NicheCategory[] = Object.freeze([
  {
    slug: 'finance',
    name: 'Finance',
    description: 'Highest documented YouTube RPM band. Crowded but rewards depth.',
    subNiches: [
      'credit card churning for beginners',
      'real estate investing strategy',
      'frugal living tips',
      'stock market for beginners',
      'side hustle ideas',
      'retirement planning explained',
    ],
  },
  {
    slug: 'tech',
    name: 'Tech',
    description: 'Strong CPM, fast-moving topics, sponsor-friendly format.',
    subNiches: [
      'ai tools reviewed',
      'programming tutorials for beginners',
      'gadget unboxing reviews',
      'productivity software comparison',
      'cybersecurity explained',
    ],
  },
  {
    slug: 'business',
    name: 'Business',
    description: 'B2B advertiser pool, premium CPM. Audience overlaps with finance.',
    subNiches: [
      'solopreneur strategy',
      'ecommerce marketing tactics',
      'freelance business growth',
      'content creation business',
      'sales techniques explained',
    ],
  },
  {
    slug: 'history',
    name: 'History',
    description: 'Mid-band RPM, long-form-friendly, evergreen demand.',
    subNiches: [
      'world war 2 documentary',
      'ancient rome animated history',
      'medieval warfare explained',
      'american revolution stories',
      'history mysteries',
    ],
  },
  {
    slug: 'education',
    name: 'Education',
    description: 'Solid CPM for tutorial formats; rewards production polish.',
    subNiches: [
      'language learning methods',
      'study techniques that work',
      'online course reviews',
      'speed reading explained',
      'memory techniques tutorial',
    ],
  },
  {
    slug: 'fitness',
    name: 'Fitness',
    description: 'Brand-deal-friendly. Mid-band RPM. Watch out for thumbnail churn.',
    subNiches: [
      'home workouts no equipment',
      'marathon training plan',
      'calisthenics for beginners',
      'strength training program review',
      'mobility exercises explained',
    ],
  },
  {
    slug: 'food',
    name: 'Food',
    description: 'Sponsor-rich (kitchenware, meal kits). Mid-band RPM.',
    subNiches: [
      'cast iron cooking',
      'sourdough bread for beginners',
      'meal prep ideas',
      'asian cuisine basics',
      'budget cooking recipes',
    ],
  },
  {
    slug: 'travel',
    name: 'Travel',
    description: 'Lower RPM but high view counts; sponsor density is strong.',
    subNiches: [
      'budget travel europe',
      'solo female travel guides',
      'road trip planning',
      'digital nomad lifestyle',
      'hidden travel destinations',
    ],
  },
  {
    slug: 'diy',
    name: 'DIY & Home',
    description: 'Tool sponsorships + Amazon affiliate friendly.',
    subNiches: [
      'woodworking projects',
      'home renovation tutorials',
      'garage workshop setup',
      'off-grid living',
      'shed building plans',
    ],
  },
  {
    slug: 'auto',
    name: 'Auto',
    description: 'High CPC keywords + brand sponsorships.',
    subNiches: [
      'classic car restoration',
      'motorcycle maintenance',
      'ev review',
      'car detailing tutorials',
      'auto repair explained',
    ],
  },
  {
    slug: 'mystery',
    name: 'Mystery',
    description: 'Strong watch-time but mid-low RPM (entertainment band).',
    subNiches: [
      'true crime documentaries',
      'unsolved mysteries explained',
      'paranormal investigations',
      'cryptid history',
      'conspiracy theories analyzed',
    ],
  },
  {
    slug: 'sports',
    name: 'Sports',
    description: 'Rights-fragile but stats / analysis niches monetize OK.',
    subNiches: [
      'nba stats deep dive',
      'soccer tactics breakdown',
      'football coaching analysis',
      'olympic sports explained',
      'fantasy sports strategy',
    ],
  },
]);

const CATEGORIES_BY_SLUG = new Map<string, NicheCategory>(
  NICHE_CATEGORIES.map((c) => [c.slug, c]),
);

export function getCategory(slug: string): NicheCategory | undefined {
  return CATEGORIES_BY_SLUG.get(slug);
}
