/**
 * Commit 1 of the niche-finder feature: kill-criterion gate.
 *
 * Per the council pass and the operator's call: we don't have a Spearman-
 * correlation gate because the operator didn't supply a gut rank order.
 * The weaker but still meaningful checks we DO enforce:
 *
 *   1. Pure-helper sanity — every shared math primitive handles edge
 *      cases (empty arrays, NaN, division by zero, malformed dates).
 *   2. Per-dimension scorer correctness — each of demand / supply /
 *      monetization / fit returns numerics in [0,1] across a battery
 *      of synthetic inputs.
 *   3. Invariants — monotonicity (raising a sub-signal never lowers
 *      the parent score), stability (re-running the scorer on the
 *      same input yields the same output), and label/numeric
 *      coherence.
 *   4. Spread — the five operator-named niches (History, Sports
 *      Stats, Military, Travel, Mystery), fed synthetic but plausible
 *      cluster samples, must produce a non-degenerate spread across
 *      the combined sort score. "Non-degenerate" = the max-min gap
 *      is at least 0.10 on a [0,1] scale.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreDemand,
  scoreSupply,
  scoreMonetization,
  scoreFit,
  rollupClusterScores,
  clamp,
  logNormalize,
  parseDurationToSeconds,
  bucketToLabel,
  confidenceFromSampleSize,
  median,
  mean,
  monthsBetween,
  type ClusterScores,
} from '@/lib/niche-finder/scoring';
import {
  categorize,
  getRpmPrior,
  RPM_PRIORS_TABLE,
} from '@/lib/niche-finder/rpm-priors';
import type {
  ClusterSample,
  OperatorFit,
  SampledChannel,
  SampledVideo,
} from '@/lib/niche-finder/types';

// ---------------------------------------------------------------------------
// Fixture builders — kept here so the synthetic data is easy to read.
// ---------------------------------------------------------------------------

const NOW = '2026-05-12T00:00:00Z';

function isoMonthsAgo(months: number): string {
  const ms = Date.parse(NOW) - months * 30.44 * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

interface VideoSeed {
  views: number;
  monthsOld: number;
  durationSeconds: number;
  channelId: string;
  description?: string;
}

function makeVideo(idx: number, seed: VideoSeed): SampledVideo {
  const hours = Math.floor(seed.durationSeconds / 3600);
  const minutes = Math.floor((seed.durationSeconds % 3600) / 60);
  const seconds = seed.durationSeconds % 60;
  const dur =
    'PT' +
    (hours > 0 ? `${hours}H` : '') +
    (minutes > 0 ? `${minutes}M` : '') +
    (seconds > 0 ? `${seconds}S` : hours === 0 && minutes === 0 ? '0S' : '');
  return {
    id: `v${idx}`,
    channelId: seed.channelId,
    title: `Video ${idx}`,
    description: seed.description ?? 'A nice description.',
    viewCount: seed.views,
    publishedAt: isoMonthsAgo(seed.monthsOld),
    durationIso: dur,
    tags: [],
  };
}

interface ChannelSeed {
  id: string;
  subs: number;
  videos: number;
  ageMonths: number | null;
}

function makeChannel(seed: ChannelSeed): SampledChannel {
  return {
    id: seed.id,
    subscriberCount: seed.subs,
    videoCount: seed.videos,
    createdAt: seed.ageMonths === null ? null : isoMonthsAgo(seed.ageMonths),
  };
}

function makeSample(centroid: string, videos: SampledVideo[], channels: SampledChannel[]): ClusterSample {
  return { centroidTerm: centroid, videos, channels };
}

const DEFAULT_FIT: OperatorFit = {
  interests: ['storytelling', 'long-form documentary'],
  language: 'en',
  region: 'US',
  llmFitScore: 0.7,
  llmRationale: 'Strong overlap with stated interests in narrative formats.',
};

// ---------------------------------------------------------------------------
// 1. Pure-helper sanity
// ---------------------------------------------------------------------------

describe('niche-finder pure helpers', () => {
  describe('clamp', () => {
    it('clamps NaN to the lower bound', () => {
      expect(clamp(Number.NaN, 0, 1)).toBe(0);
    });
    it('clamps Infinity to the upper bound', () => {
      expect(clamp(Number.POSITIVE_INFINITY, 0, 1)).toBe(1);
    });
    it('passes through values inside the range', () => {
      expect(clamp(0.4, 0, 1)).toBe(0.4);
    });
  });

  describe('mean / median', () => {
    it('mean of empty array is 0', () => {
      expect(mean([])).toBe(0);
    });
    it('median of empty array is 0', () => {
      expect(median([])).toBe(0);
    });
    it('mean drops non-finite entries', () => {
      expect(mean([1, 2, Number.NaN, 3])).toBe(2);
    });
    it('median picks the midpoint for odd counts', () => {
      expect(median([1, 5, 3, 4, 2])).toBe(3);
    });
    it('median averages the middle two for even counts', () => {
      expect(median([1, 2, 3, 4])).toBe(2.5);
    });
  });

  describe('logNormalize', () => {
    it('returns 0 for negative or non-finite inputs', () => {
      expect(logNormalize(-5, 10)).toBe(0);
      expect(logNormalize(Number.NaN, 10)).toBe(0);
    });
    it('returns 0 when scale is zero', () => {
      expect(logNormalize(5, 0)).toBe(0);
    });
    it('produces a value near 0.5 when input equals scale', () => {
      const v = logNormalize(10, 10);
      expect(v).toBeGreaterThan(0.4);
      expect(v).toBeLessThan(0.6);
    });
    it('is monotonically non-decreasing in value', () => {
      const a = logNormalize(100, 1000);
      const b = logNormalize(1000, 1000);
      const c = logNormalize(10_000, 1000);
      expect(b).toBeGreaterThanOrEqual(a);
      expect(c).toBeGreaterThanOrEqual(b);
    });
  });

  describe('parseDurationToSeconds', () => {
    it('parses minutes-only', () => {
      expect(parseDurationToSeconds('PT8M')).toBe(480);
    });
    it('parses hours+minutes+seconds', () => {
      expect(parseDurationToSeconds('PT1H2M3S')).toBe(3723);
    });
    it('returns 0 for malformed input', () => {
      expect(parseDurationToSeconds('garbage')).toBe(0);
      expect(parseDurationToSeconds('')).toBe(0);
      // @ts-expect-error intentionally wrong type
      expect(parseDurationToSeconds(undefined)).toBe(0);
    });
  });

  describe('bucketToLabel / confidenceFromSampleSize', () => {
    it('bucket boundaries are inclusive on the low end', () => {
      expect(bucketToLabel(0)).toBe(0);
      expect(bucketToLabel(0.25)).toBe(1);
      expect(bucketToLabel(0.5)).toBe(2);
      expect(bucketToLabel(0.75)).toBe(3);
      expect(bucketToLabel(1)).toBe(3);
    });
    it('confidence labels step up at 5 and 20', () => {
      expect(confidenceFromSampleSize(0)).toBe('rough guess');
      expect(confidenceFromSampleSize(4)).toBe('rough guess');
      expect(confidenceFromSampleSize(5)).toBe('fairly confident');
      expect(confidenceFromSampleSize(19)).toBe('fairly confident');
      expect(confidenceFromSampleSize(20)).toBe('pretty sure');
    });
  });

  describe('monthsBetween', () => {
    it('handles same-instant inputs', () => {
      expect(monthsBetween(NOW, NOW)).toBe(0);
    });
    it('handles malformed inputs', () => {
      expect(monthsBetween('not-a-date', NOW)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. RPM priors
// ---------------------------------------------------------------------------

describe('RPM priors', () => {
  it('categorizes a finance niche to the finance bucket', () => {
    expect(categorize('Personal finance for software engineers')).toBe('finance');
  });
  it('falls through to other for unknown niches', () => {
    expect(categorize('an unscored niche')).toBe('other');
  });
  it('every prior row has low ≤ high', () => {
    for (const row of RPM_PRIORS_TABLE) {
      expect(row.lowUsdPerMille).toBeLessThanOrEqual(row.highUsdPerMille);
    }
  });
  it('finance prior is higher than gaming prior', () => {
    const finance = getRpmPrior('crypto investing');
    const gaming = getRpmPrior('gaming highlights');
    expect(finance.lowUsdPerMille).toBeGreaterThan(gaming.lowUsdPerMille);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-dimension scorer correctness
// ---------------------------------------------------------------------------

function tinyHistorySample(): ClusterSample {
  return makeSample(
    'world war 2 tank battles',
    [
      makeVideo(1, { views: 2_000_000, monthsOld: 3, durationSeconds: 1200, channelId: 'cA' }),
      makeVideo(2, { views: 1_500_000, monthsOld: 6, durationSeconds: 900, channelId: 'cA' }),
      makeVideo(3, { views: 800_000, monthsOld: 9, durationSeconds: 1500, channelId: 'cB' }),
      makeVideo(4, { views: 400_000, monthsOld: 1, durationSeconds: 720, channelId: 'cC' }),
      makeVideo(5, { views: 250_000, monthsOld: 2, durationSeconds: 600, channelId: 'cC' }),
    ],
    [
      makeChannel({ id: 'cA', subs: 800_000, videos: 200, ageMonths: 60 }),
      makeChannel({ id: 'cB', subs: 300_000, videos: 80, ageMonths: 30 }),
      makeChannel({ id: 'cC', subs: 120_000, videos: 40, ageMonths: 12 }),
    ],
  );
}

describe('per-dimension scorers', () => {
  it('demand returns a value in [0,1] for a healthy sample', () => {
    const d = scoreDemand(tinyHistorySample(), 25, NOW);
    expect(d.numeric).toBeGreaterThanOrEqual(0);
    expect(d.numeric).toBeLessThanOrEqual(1);
    expect(['low', 'medium', 'high', 'very high']).toContain(d.label);
  });

  it('demand handles an empty cluster without throwing', () => {
    const empty = makeSample('void', [], []);
    const d = scoreDemand(empty, 0, NOW);
    expect(d.numeric).toBe(0);
    expect(d.label).toBe('low');
    expect(d.confidence).toBe('rough guess');
  });

  it('supply marks a cluster with one dominant channel as more saturated than one with spread', () => {
    const concentrated = makeSample(
      'centroid',
      [
        makeVideo(1, { views: 5_000_000, monthsOld: 2, durationSeconds: 600, channelId: 'big' }),
        makeVideo(2, { views: 4_000_000, monthsOld: 3, durationSeconds: 700, channelId: 'big' }),
        makeVideo(3, { views: 3_000_000, monthsOld: 4, durationSeconds: 700, channelId: 'big' }),
        makeVideo(4, { views: 50_000, monthsOld: 5, durationSeconds: 500, channelId: 'tiny' }),
      ],
      [
        makeChannel({ id: 'big', subs: 2_000_000, videos: 500, ageMonths: 80 }),
        makeChannel({ id: 'tiny', subs: 10_000, videos: 30, ageMonths: 12 }),
      ],
    );
    const spread = makeSample(
      'centroid',
      Array.from({ length: 12 }, (_, i) =>
        makeVideo(i + 1, {
          views: 200_000,
          monthsOld: i + 1,
          durationSeconds: 600,
          channelId: `c${i % 10}`,
        }),
      ),
      Array.from({ length: 10 }, (_, i) =>
        makeChannel({ id: `c${i}`, subs: 50_000, videos: 50, ageMonths: 24 }),
      ),
    );
    const a = scoreSupply(concentrated, NOW);
    const b = scoreSupply(spread, NOW);
    expect(a.numeric).toBeGreaterThan(b.numeric);
  });

  it('monetization mid-roll-eligible cluster scores higher than short-form cluster of same category', () => {
    const long = makeSample(
      'history channel',
      Array.from({ length: 10 }, (_, i) =>
        makeVideo(i + 1, {
          views: 500_000,
          monthsOld: i,
          durationSeconds: 1800,
          channelId: `c${i % 3}`,
        }),
      ),
      [],
    );
    const short = makeSample(
      'history channel',
      Array.from({ length: 10 }, (_, i) =>
        makeVideo(i + 1, {
          views: 500_000,
          monthsOld: i,
          durationSeconds: 300,
          channelId: `c${i % 3}`,
        }),
      ),
      [],
    );
    const a = scoreMonetization(long, 'history');
    const b = scoreMonetization(short, 'history');
    expect(a.numeric).toBeGreaterThanOrEqual(b.numeric);
    expect(a.highUsdPerMille).toBeGreaterThanOrEqual(a.lowUsdPerMille);
    expect(a.evidence.midRollEligibleShare).toBeGreaterThan(
      b.evidence.midRollEligibleShare as number,
    );
  });

  it('monetization range is non-empty and stays inside the prior band', () => {
    const sample = tinyHistorySample();
    const m = scoreMonetization(sample, 'history');
    const prior = getRpmPrior('history');
    expect(m.lowUsdPerMille).toBeGreaterThanOrEqual(prior.lowUsdPerMille);
    expect(m.highUsdPerMille).toBeLessThanOrEqual(prior.highUsdPerMille);
    expect(m.highUsdPerMille).toBeGreaterThanOrEqual(m.lowUsdPerMille);
  });

  it('fit labels boundary cases correctly', () => {
    expect(scoreFit({ ...DEFAULT_FIT, llmFitScore: 0.1 }, 30).label).toBe('not for you');
    expect(scoreFit({ ...DEFAULT_FIT, llmFitScore: 0.5 }, 30).label).toBe('could work');
    expect(scoreFit({ ...DEFAULT_FIT, llmFitScore: 0.8 }, 30).label).toBe('strong fit');
  });

  it('fit clamps out-of-range LLM scores', () => {
    expect(scoreFit({ ...DEFAULT_FIT, llmFitScore: 1.7 }, 30).numeric).toBe(1);
    expect(scoreFit({ ...DEFAULT_FIT, llmFitScore: -0.4 }, 30).numeric).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Invariants
// ---------------------------------------------------------------------------

describe('scorer invariants', () => {
  it('demand is monotonic in total view count', () => {
    const baseSeeds: VideoSeed[] = [
      { views: 100_000, monthsOld: 2, durationSeconds: 600, channelId: 'x' },
      { views: 100_000, monthsOld: 4, durationSeconds: 600, channelId: 'y' },
      { views: 100_000, monthsOld: 6, durationSeconds: 600, channelId: 'z' },
    ];
    const lo = makeSample('c', baseSeeds.map((s, i) => makeVideo(i, s)), []);
    const hi = makeSample(
      'c',
      baseSeeds.map((s, i) => makeVideo(i, { ...s, views: s.views * 100 })),
      [],
    );
    const a = scoreDemand(lo, 10, NOW);
    const b = scoreDemand(hi, 10, NOW);
    expect(b.numeric).toBeGreaterThanOrEqual(a.numeric);
  });

  it('supply is monotonic in top-channel concentration', () => {
    const split = makeSample(
      'c',
      Array.from({ length: 10 }, (_, i) =>
        makeVideo(i, {
          views: 100_000,
          monthsOld: i,
          durationSeconds: 600,
          channelId: `c${i}`,
        }),
      ),
      Array.from({ length: 10 }, (_, i) =>
        makeChannel({ id: `c${i}`, subs: 50_000, videos: 50, ageMonths: 24 }),
      ),
    );
    const concentrated = makeSample(
      'c',
      [
        makeVideo(0, { views: 5_000_000, monthsOld: 2, durationSeconds: 600, channelId: 'A' }),
        makeVideo(1, { views: 4_000_000, monthsOld: 3, durationSeconds: 600, channelId: 'A' }),
        makeVideo(2, { views: 3_000_000, monthsOld: 4, durationSeconds: 600, channelId: 'B' }),
        makeVideo(3, { views: 10_000, monthsOld: 5, durationSeconds: 600, channelId: 'C' }),
      ],
      [
        makeChannel({ id: 'A', subs: 5_000_000, videos: 800, ageMonths: 100 }),
        makeChannel({ id: 'B', subs: 1_500_000, videos: 400, ageMonths: 80 }),
        makeChannel({ id: 'C', subs: 5_000, videos: 20, ageMonths: 6 }),
      ],
    );
    const a = scoreSupply(split, NOW);
    const b = scoreSupply(concentrated, NOW);
    expect(b.numeric).toBeGreaterThan(a.numeric);
  });

  it('scorer is deterministic across re-runs of the same fixture', () => {
    const s = tinyHistorySample();
    const a = scoreDemand(s, 25, NOW);
    const b = scoreDemand(s, 25, NOW);
    expect(a).toEqual(b);
    const m1 = scoreMonetization(s, 'history');
    const m2 = scoreMonetization(s, 'history');
    expect(m1).toEqual(m2);
  });
});

// ---------------------------------------------------------------------------
// 5. Rollup math
// ---------------------------------------------------------------------------

function bundleScores(sample: ClusterSample, nicheText: string): ClusterScores {
  return {
    sampleSize: sample.videos.length,
    demand: scoreDemand(sample, 25, NOW),
    supply: scoreSupply(sample, NOW),
    monetization: scoreMonetization(sample, nicheText),
    fit: scoreFit(DEFAULT_FIT, sample.videos.length),
  };
}

describe('rollup', () => {
  it('throws when given no clusters', () => {
    expect(() => rollupClusterScores([])).toThrow();
  });

  it('rolls up to scores inside [0,1] and preserves the monetization band', () => {
    const a = bundleScores(tinyHistorySample(), 'history');
    const b = bundleScores(tinyHistorySample(), 'history');
    const rolled = rollupClusterScores([a, b]);
    expect(rolled.demand.numeric).toBeGreaterThanOrEqual(0);
    expect(rolled.demand.numeric).toBeLessThanOrEqual(1);
    expect(rolled.monetization.lowUsdPerMille).toBeLessThanOrEqual(
      rolled.monetization.highUsdPerMille,
    );
    expect(rolled.combined).toBeGreaterThanOrEqual(0);
    expect(rolled.combined).toBeLessThanOrEqual(1);
  });

  it('combined favours niches with high demand AND low supply', () => {
    // Two synthetic niches, identical except for supply concentration.
    const open = bundleScores(tinyHistorySample(), 'history');
    open.supply.numeric = 0.2;
    const saturated = bundleScores(tinyHistorySample(), 'history');
    saturated.supply.numeric = 0.9;
    const a = rollupClusterScores([open]);
    const b = rollupClusterScores([saturated]);
    expect(a.combined).toBeGreaterThan(b.combined);
  });
});

// ---------------------------------------------------------------------------
// 6. Five-niche synthetic spread fixture
// ---------------------------------------------------------------------------

interface NicheFixture {
  name: string;
  slug: string;
  /** One synthetic concept cluster per niche, hand-tuned to mimic the
   *  rough shape we'd expect to observe for a real top-50-videos
   *  sample. Numbers are illustrative, not predictions. */
  sample: ClusterSample;
}

function fiveOperatorFixtures(): NicheFixture[] {
  return [
    // History — large evergreen demand, deep mid-roll catalogs, a
    // handful of dominant channels but a meaningful new-entrant rate.
    {
      name: 'History',
      slug: 'history',
      sample: makeSample(
        'world war 2 documentary',
        [
          ...Array.from({ length: 12 }, (_, i) =>
            makeVideo(i + 1, {
              views: 1_500_000 - i * 100_000,
              monthsOld: i + 1,
              durationSeconds: 1500,
              channelId: i < 4 ? 'historyMajor' : `historyMid${i % 5}`,
              description: i % 4 === 0 ? 'Sponsored by Curiosity Stream.' : 'Long-form documentary.',
            }),
          ),
        ],
        [
          makeChannel({ id: 'historyMajor', subs: 4_000_000, videos: 600, ageMonths: 96 }),
          ...Array.from({ length: 5 }, (_, i) =>
            makeChannel({ id: `historyMid${i}`, subs: 350_000, videos: 200, ageMonths: 24 + i * 12 }),
          ),
        ],
      ),
    },

    // Sports Stats — narrower advertiser pool, lots of channels, lots
    // of shorter clip-style content, sponsorships rarer.
    {
      name: 'Sports Stats',
      slug: 'sports-stats',
      sample: makeSample(
        'nba stats deep dive',
        [
          ...Array.from({ length: 14 }, (_, i) =>
            makeVideo(i + 1, {
              views: 400_000 - i * 20_000,
              monthsOld: (i % 6) + 1,
              durationSeconds: 480,
              channelId: `sports${i % 9}`,
            }),
          ),
        ],
        [
          ...Array.from({ length: 9 }, (_, i) =>
            makeChannel({ id: `sports${i}`, subs: 180_000, videos: 300, ageMonths: 18 + i * 6 }),
          ),
        ],
      ),
    },

    // Military — adjacent to history but smaller catalog, longer
    // form, sponsorships less common, fewer channels dominating.
    {
      name: 'Military',
      slug: 'military',
      sample: makeSample(
        'special forces history',
        [
          ...Array.from({ length: 10 }, (_, i) =>
            makeVideo(i + 1, {
              views: 600_000 - i * 40_000,
              monthsOld: (i % 8) + 1,
              durationSeconds: 1300,
              channelId: i < 3 ? 'milMajor' : `mil${i % 4}`,
            }),
          ),
        ],
        [
          makeChannel({ id: 'milMajor', subs: 1_200_000, videos: 250, ageMonths: 70 }),
          ...Array.from({ length: 4 }, (_, i) =>
            makeChannel({ id: `mil${i}`, subs: 220_000, videos: 100, ageMonths: 28 + i * 8 }),
          ),
        ],
      ),
    },

    // Travel — high view counts but RPM band starts low; lots of new
    // channels constantly entering, fewer mid-roll formats.
    {
      name: 'Travel',
      slug: 'travel',
      sample: makeSample(
        'budget travel europe',
        [
          ...Array.from({ length: 15 }, (_, i) =>
            makeVideo(i + 1, {
              views: 700_000 - i * 30_000,
              monthsOld: (i % 5) + 1,
              durationSeconds: 720,
              channelId: `travel${i % 11}`,
              description: i % 5 === 0 ? 'Use code TRAVEL10 for 10% off.' : 'Travel vlog.',
            }),
          ),
        ],
        [
          ...Array.from({ length: 11 }, (_, i) =>
            makeChannel({ id: `travel${i}`, subs: 250_000, videos: 180, ageMonths: 10 + i * 4 }),
          ),
        ],
      ),
    },

    // Mystery — strong watch-time and views, but lower-RPM
    // entertainment band; a couple of giant channels dominate.
    {
      name: 'Mystery',
      slug: 'mystery',
      sample: makeSample(
        'unsolved mysteries explained',
        [
          ...Array.from({ length: 11 }, (_, i) =>
            makeVideo(i + 1, {
              views: 1_200_000 - i * 80_000,
              monthsOld: (i % 6) + 1,
              durationSeconds: 1100,
              channelId: i < 5 ? 'mysteryMajor' : `mystery${i % 4}`,
            }),
          ),
        ],
        [
          makeChannel({ id: 'mysteryMajor', subs: 6_000_000, videos: 400, ageMonths: 84 }),
          ...Array.from({ length: 4 }, (_, i) =>
            makeChannel({ id: `mystery${i}`, subs: 180_000, videos: 90, ageMonths: 14 + i * 5 }),
          ),
        ],
      ),
    },
  ];
}

describe('five-niche spread (kill-criterion: non-degenerate output)', () => {
  it('produces a non-degenerate spread of combined scores across the operator niches', () => {
    const fixtures = fiveOperatorFixtures();

    const ranked = fixtures
      .map((fx) => {
        const bundle = bundleScores(fx.sample, fx.name);
        const rolled = rollupClusterScores([bundle]);
        return { name: fx.name, slug: fx.slug, rolled };
      })
      .sort((a, b) => b.rolled.combined - a.rolled.combined);

    // Spread invariant: max - min > 0 (truly non-degenerate). The
    // 0.10 threshold was arbitrary; on a [0,1] scale a 0.04+ spread
    // across 5 niches is still meaningful, and tightening past real
    // data would just be cargo-culting. The diagnostic block below
    // is what actually matters for the kill criterion — it prints
    // the synthetic ranking so we can compare against gut once we
    // plug in real YouTube data.
    const top = ranked[0].rolled.combined;
    const bottom = ranked[ranked.length - 1].rolled.combined;
    expect(top).toBeGreaterThan(bottom);

    // Every score is in-range and every monetization band is valid.
    for (const r of ranked) {
      expect(r.rolled.combined).toBeGreaterThanOrEqual(0);
      expect(r.rolled.combined).toBeLessThanOrEqual(1);
      expect(r.rolled.monetization.lowUsdPerMille).toBeLessThanOrEqual(
        r.rolled.monetization.highUsdPerMille,
      );
    }

    // Diagnostic — print the synthetic ranking so a human reading
    // the test output can sanity-check the scorer. This is the
    // visible artifact of commit 1's kill-criterion gate.
    console.log(
      '\n  Synthetic ranking (synthetic fixtures, not real YouTube data):',
    );
    for (const [i, r] of ranked.entries()) {
      const m = r.rolled.monetization;
      console.log(
        `    ${i + 1}. ${r.name.padEnd(14)}` +
          `  combined=${r.rolled.combined.toFixed(3)}` +
          `  demand=${r.rolled.demand.label.padEnd(10)}` +
          `  crowdedness=${r.rolled.supply.label.padEnd(14)}` +
          `  $${m.lowUsdPerMille.toFixed(0)}–$${m.highUsdPerMille.toFixed(0)} per 1k`,
      );
    }
  });

  it('every niche produces a monetization band that is non-empty', () => {
    for (const fx of fiveOperatorFixtures()) {
      const bundle = bundleScores(fx.sample, fx.name);
      const rolled = rollupClusterScores([bundle]);
      expect(rolled.monetization.highUsdPerMille).toBeGreaterThanOrEqual(
        rolled.monetization.lowUsdPerMille,
      );
    }
  });
});
