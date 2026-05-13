/**
 * Pure-helper tests for the Browse Categories filter / sort / preset
 * machinery used by the Niche Finder's category tab.
 *
 *   - filterAndSortDiscoveries applies each dimension independently
 *     and in combination, and respects every sort order.
 *   - sweetSpotScore + isSweetSpot match the documented formula and
 *     threshold (high+ demand, ≤ room-to-enter, ≥ $10/k floor).
 *   - RPM range supersedes the chip floor when active.
 *   - Built-in presets are well-formed and the default matches the
 *     "sweet-spot" preset exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  activeRpmRange,
  BUILTIN_BROWSE_PRESETS,
  DEFAULT_FILTERS,
  filterAndSortDiscoveries,
  getBuiltinBrowsePreset,
  isSweetSpot,
  quadrantFit,
  quadrantX,
  quadrantY,
  rpmTier,
  RPM_RANGE_MAX,
  SWEET_SPOT_WEIGHTS,
  sweetSpotScore,
  type BrowseFilters,
} from '@/lib/niche-finder/browse-filters';
import type { DiscoveryResultItem } from '@/lib/niche-finder/discoveries-db';
import type {
  DemandLabel,
  FitLabel,
  NicheScores,
  SupplyLabel,
} from '@/lib/niche-finder/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function score({
  demand = 'medium',
  supply = 'room to enter',
  fit = 'could work',
  lowRpm = 8,
  highRpm = 16,
  combined = 0.5,
}: {
  demand?: DemandLabel;
  supply?: SupplyLabel;
  fit?: FitLabel;
  lowRpm?: number;
  highRpm?: number;
  combined?: number;
} = {}): NicheScores {
  // Numeric values are aligned with the label ordering so sort-by-numeric
  // matches sort-by-label rank, but the filter math runs off the label
  // directly so the exact numeric value doesn't matter beyond ordering.
  const DEMAND_NUMERIC: Record<DemandLabel, number> = {
    low: 0.1,
    medium: 0.4,
    high: 0.7,
    'very high': 0.95,
  };
  const SUPPLY_NUMERIC: Record<SupplyLabel, number> = {
    'wide open': 0.1,
    'room to enter': 0.4,
    crowded: 0.7,
    saturated: 0.95,
  };
  const FIT_NUMERIC: Record<FitLabel, number> = {
    'not for you': 0.0,
    'could work': 0.5,
    'strong fit': 0.95,
  };
  return {
    demand: { numeric: DEMAND_NUMERIC[demand], label: demand, confidence: 'fairly confident', evidence: {} },
    supply: { numeric: SUPPLY_NUMERIC[supply], label: supply, confidence: 'fairly confident', evidence: {} },
    monetization: {
      numeric: (lowRpm + highRpm) / 2 / 30,
      label: 'medium',
      confidence: 'fairly confident',
      evidence: {},
      lowUsdPerMille: lowRpm,
      highUsdPerMille: highRpm,
    },
    fit: { numeric: FIT_NUMERIC[fit], label: fit, confidence: 'fairly confident', evidence: {} },
    combined,
  };
}

function item(slug: string, scores: NicheScores, name = slug): DiscoveryResultItem {
  return { slug, name, scores };
}

// ---------------------------------------------------------------------------
// DEFAULT_FILTERS + presets
// ---------------------------------------------------------------------------

describe('DEFAULT_FILTERS', () => {
  it('matches the sweet-spot preset exactly', () => {
    const preset = getBuiltinBrowsePreset('sweet-spot');
    expect(preset).toBeDefined();
    expect(DEFAULT_FILTERS).toEqual(preset!.filters);
  });

  it('uses sweet-spot sort by default', () => {
    expect(DEFAULT_FILTERS.sortBy).toBe('sweet-spot');
  });
});

describe('BUILTIN_BROWSE_PRESETS', () => {
  it('has at least the five documented presets in declared order', () => {
    expect(BUILTIN_BROWSE_PRESETS.map((p) => p.id)).toEqual([
      'sweet-spot',
      'untapped-gems',
      'premium-rpm',
      'beginner-friendly',
      'my-fit',
    ]);
  });

  it('every preset carries its own id in the breadcrumb', () => {
    for (const p of BUILTIN_BROWSE_PRESETS) {
      expect(p.filters.preset).toBe(p.id);
    }
  });

  it('every preset has a label and description', () => {
    for (const p of BUILTIN_BROWSE_PRESETS) {
      expect(p.label).toBeTruthy();
      expect(p.description.length).toBeGreaterThan(20);
    }
  });

  it('getBuiltinBrowsePreset returns undefined for unknown ids', () => {
    expect(getBuiltinBrowsePreset('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// activeRpmRange
// ---------------------------------------------------------------------------

describe('activeRpmRange', () => {
  it('returns null for undefined', () => {
    expect(activeRpmRange(undefined)).toBeNull();
  });
  it('returns null for the full sweep [0, RPM_RANGE_MAX]', () => {
    expect(activeRpmRange([0, RPM_RANGE_MAX])).toBeNull();
  });
  it('returns null for non-finite bounds', () => {
    expect(activeRpmRange([NaN, 30])).toBeNull();
  });
  it('returns the clamped range when narrowing', () => {
    expect(activeRpmRange([5, 20])).toEqual([5, 20]);
    // Partial clamp: lo outside but hi narrowing → clamps the lo, keeps the narrowing hi.
    expect(activeRpmRange([-3, 20])).toEqual([0, 20]);
    expect(activeRpmRange([5, RPM_RANGE_MAX + 10])).toEqual([5, RPM_RANGE_MAX]);
  });
});

// ---------------------------------------------------------------------------
// filterAndSortDiscoveries — single dimension
// ---------------------------------------------------------------------------

describe('filterAndSortDiscoveries — demand floor', () => {
  const items: DiscoveryResultItem[] = [
    item('a', score({ demand: 'low' })),
    item('b', score({ demand: 'medium' })),
    item('c', score({ demand: 'high' })),
    item('d', score({ demand: 'very high' })),
  ];

  it('any → keeps all', () => {
    const got = filterAndSortDiscoveries(items, { demandMin: 'any', sortBy: 'demand' });
    expect(got.map((x) => x.slug)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('medium → drops low', () => {
    const got = filterAndSortDiscoveries(items, { demandMin: 'medium', sortBy: 'demand' });
    expect(got.map((x) => x.slug)).toEqual(['d', 'c', 'b']);
  });
  it('high → drops low + medium', () => {
    const got = filterAndSortDiscoveries(items, { demandMin: 'high', sortBy: 'demand' });
    expect(got.map((x) => x.slug)).toEqual(['d', 'c']);
  });
  it('very-high → keeps only very high', () => {
    const got = filterAndSortDiscoveries(items, { demandMin: 'very-high', sortBy: 'demand' });
    expect(got.map((x) => x.slug)).toEqual(['d']);
  });
});

describe('filterAndSortDiscoveries — crowdedness ceiling', () => {
  const items: DiscoveryResultItem[] = [
    item('a', score({ supply: 'wide open' })),
    item('b', score({ supply: 'room to enter' })),
    item('c', score({ supply: 'crowded' })),
    item('d', score({ supply: 'saturated' })),
  ];

  it('any → keeps all', () => {
    const got = filterAndSortDiscoveries(items, { crowdednessMax: 'any', sortBy: 'crowdedness' });
    expect(got.map((x) => x.slug)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('non-saturated → drops saturated only', () => {
    const got = filterAndSortDiscoveries(items, { crowdednessMax: 'non-saturated', sortBy: 'crowdedness' });
    expect(got.map((x) => x.slug)).toEqual(['a', 'b', 'c']);
  });
  it('room → drops crowded + saturated', () => {
    const got = filterAndSortDiscoveries(items, { crowdednessMax: 'room', sortBy: 'crowdedness' });
    expect(got.map((x) => x.slug)).toEqual(['a', 'b']);
  });
  it('wide-open → keeps only wide-open', () => {
    const got = filterAndSortDiscoveries(items, { crowdednessMax: 'wide-open', sortBy: 'crowdedness' });
    expect(got.map((x) => x.slug)).toEqual(['a']);
  });
});

describe('filterAndSortDiscoveries — fit floor', () => {
  const items: DiscoveryResultItem[] = [
    item('a', score({ fit: 'not for you' })),
    item('b', score({ fit: 'could work' })),
    item('c', score({ fit: 'strong fit' })),
  ];
  it('could-work → drops "not for you"', () => {
    const got = filterAndSortDiscoveries(items, { fitMin: 'could-work', sortBy: 'fit' });
    expect(got.map((x) => x.slug)).toEqual(['c', 'b']);
  });
  it('strong → keeps only "strong fit"', () => {
    const got = filterAndSortDiscoveries(items, { fitMin: 'strong', sortBy: 'fit' });
    expect(got.map((x) => x.slug)).toEqual(['c']);
  });
});

describe('filterAndSortDiscoveries — rpm chip floor', () => {
  // The RPM filter checks the HIGH end of the monetization range
  // against the floor, so a niche with band $8–$15 passes a $10 floor.
  const items: DiscoveryResultItem[] = [
    item('low', score({ lowRpm: 1, highRpm: 4 })),
    item('mid', score({ lowRpm: 8, highRpm: 15 })),
    item('high', score({ lowRpm: 22, highRpm: 35 })),
  ];

  it('chip 0 = no filter', () => {
    const got = filterAndSortDiscoveries(items, { rpmMinChip: 0, sortBy: 'rpm' });
    expect(got.map((x) => x.slug).sort()).toEqual(['high', 'low', 'mid']);
  });
  it('chip 5 keeps niches whose top end clears $5', () => {
    const got = filterAndSortDiscoveries(items, { rpmMinChip: 5, sortBy: 'rpm' });
    expect(got.map((x) => x.slug).sort()).toEqual(['high', 'mid']);
  });
  it('chip 20 keeps only the high-rpm niche', () => {
    const got = filterAndSortDiscoveries(items, { rpmMinChip: 20, sortBy: 'rpm' });
    expect(got.map((x) => x.slug)).toEqual(['high']);
  });
});

describe('filterAndSortDiscoveries — rpm range supersedes chip', () => {
  const items: DiscoveryResultItem[] = [
    item('low', score({ lowRpm: 1, highRpm: 4 })),
    item('mid', score({ lowRpm: 8, highRpm: 15 })),
    item('high', score({ lowRpm: 22, highRpm: 35 })),
  ];

  it('range [5, 20] keeps mid only (low fails floor, high fails ceiling)', () => {
    const got = filterAndSortDiscoveries(items, {
      rpmMinChip: 20, // would normally keep only "high"
      rpmRange: [5, 20],
      sortBy: 'rpm',
    });
    expect(got.map((x) => x.slug)).toEqual(['mid']);
  });

  it('full-sweep range [0, RPM_RANGE_MAX] falls back to the chip', () => {
    const got = filterAndSortDiscoveries(items, {
      rpmMinChip: 20,
      rpmRange: [0, RPM_RANGE_MAX],
      sortBy: 'rpm',
    });
    expect(got.map((x) => x.slug)).toEqual(['high']);
  });
});

// ---------------------------------------------------------------------------
// filterAndSortDiscoveries — combinations
// ---------------------------------------------------------------------------

describe('filterAndSortDiscoveries — combined filters', () => {
  it('applies demand + crowdedness + rpm together', () => {
    const items: DiscoveryResultItem[] = [
      item('miss-demand', score({ demand: 'medium', supply: 'wide open', lowRpm: 20, highRpm: 30 })),
      item('miss-supply', score({ demand: 'high', supply: 'saturated', lowRpm: 20, highRpm: 30 })),
      item('miss-rpm', score({ demand: 'high', supply: 'wide open', lowRpm: 1, highRpm: 4 })),
      item('keeper', score({ demand: 'high', supply: 'room to enter', lowRpm: 12, highRpm: 22 })),
    ];
    const filters: BrowseFilters = {
      demandMin: 'high',
      crowdednessMax: 'non-saturated',
      rpmMinChip: 10,
    };
    const got = filterAndSortDiscoveries(items, filters);
    expect(got.map((x) => x.slug)).toEqual(['keeper']);
  });

  it('empty input returns empty output', () => {
    expect(filterAndSortDiscoveries([], DEFAULT_FILTERS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sort orders
// ---------------------------------------------------------------------------

describe('filterAndSortDiscoveries — sort orders', () => {
  const items: DiscoveryResultItem[] = [
    item('a', score({ demand: 'low', supply: 'saturated', fit: 'not for you', lowRpm: 1, highRpm: 4, combined: 0.1 })),
    item('b', score({ demand: 'medium', supply: 'crowded', fit: 'could work', lowRpm: 8, highRpm: 15, combined: 0.4 })),
    item('c', score({ demand: 'high', supply: 'room to enter', fit: 'strong fit', lowRpm: 15, highRpm: 25, combined: 0.7 })),
    item('d', score({ demand: 'very high', supply: 'wide open', fit: 'strong fit', lowRpm: 25, highRpm: 40, combined: 0.9 })),
  ];

  it('demand ↓', () => {
    expect(filterAndSortDiscoveries(items, { sortBy: 'demand' }).map((x) => x.slug)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('crowdedness ascending (least crowded first)', () => {
    expect(filterAndSortDiscoveries(items, { sortBy: 'crowdedness' }).map((x) => x.slug)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('rpm by floor ↓', () => {
    expect(filterAndSortDiscoveries(items, { sortBy: 'rpm' }).map((x) => x.slug)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('fit ↓', () => {
    // d and c both have "strong fit" so the sort is stable for them; just check the head and tail.
    const got = filterAndSortDiscoveries(items, { sortBy: 'fit' }).map((x) => x.slug);
    expect(new Set([got[0], got[1]])).toEqual(new Set(['c', 'd']));
    expect(got[got.length - 1]).toBe('a');
  });
  it('combined ↓', () => {
    expect(filterAndSortDiscoveries(items, { sortBy: 'combined' }).map((x) => x.slug)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('sweet-spot ↓ favours the all-around best', () => {
    expect(filterAndSortDiscoveries(items, { sortBy: 'sweet-spot' }).map((x) => x.slug)[0]).toBe('d');
  });
});

// ---------------------------------------------------------------------------
// sweetSpotScore + isSweetSpot
// ---------------------------------------------------------------------------

describe('sweetSpotScore', () => {
  it('weights sum to 1', () => {
    const sum =
      SWEET_SPOT_WEIGHTS.demand +
      SWEET_SPOT_WEIGHTS.openness +
      SWEET_SPOT_WEIGHTS.rpm +
      SWEET_SPOT_WEIGHTS.fit;
    expect(sum).toBeCloseTo(1, 5);
  });

  it('returns 1.0 for the perfect niche', () => {
    const s = score({ demand: 'very high', supply: 'wide open', fit: 'strong fit', lowRpm: 30, highRpm: 50 });
    expect(sweetSpotScore(s)).toBeCloseTo(1, 5);
  });

  it('returns 0.0 for the worst-case niche', () => {
    const s = score({ demand: 'low', supply: 'saturated', fit: 'not for you', lowRpm: 0, highRpm: 0 });
    expect(sweetSpotScore(s)).toBeCloseTo(0, 5);
  });

  it('prefers high-demand low-crowded over high-rpm-only', () => {
    const a = score({ demand: 'very high', supply: 'wide open', fit: 'could work', lowRpm: 5, highRpm: 10 });
    const b = score({ demand: 'low', supply: 'saturated', fit: 'could work', lowRpm: 30, highRpm: 50 });
    expect(sweetSpotScore(a)).toBeGreaterThan(sweetSpotScore(b));
  });
});

describe('isSweetSpot', () => {
  it('true for high demand + room to enter + $10 floor', () => {
    expect(
      isSweetSpot(score({ demand: 'high', supply: 'room to enter', lowRpm: 10, highRpm: 20 })),
    ).toBe(true);
  });
  it('false when demand is below high', () => {
    expect(
      isSweetSpot(score({ demand: 'medium', supply: 'wide open', lowRpm: 12, highRpm: 25 })),
    ).toBe(false);
  });
  it('false when crowdedness exceeds room-to-enter', () => {
    expect(
      isSweetSpot(score({ demand: 'high', supply: 'crowded', lowRpm: 12, highRpm: 25 })),
    ).toBe(false);
  });
  it('false when rpm floor < $10', () => {
    expect(
      isSweetSpot(score({ demand: 'high', supply: 'wide open', lowRpm: 8, highRpm: 18 })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Quadrant helpers
// ---------------------------------------------------------------------------

describe('quadrant helpers', () => {
  it('quadrantX maps demand label to 0..1', () => {
    expect(quadrantX(score({ demand: 'low' }))).toBeCloseTo(0, 5);
    expect(quadrantX(score({ demand: 'very high' }))).toBeCloseTo(1, 5);
  });
  it('quadrantY inverts crowdedness (wide-open=1, saturated=0)', () => {
    expect(quadrantY(score({ supply: 'wide open' }))).toBeCloseTo(1, 5);
    expect(quadrantY(score({ supply: 'saturated' }))).toBeCloseTo(0, 5);
  });
  it('quadrantFit maps fit label to 0..1', () => {
    expect(quadrantFit(score({ fit: 'not for you' }))).toBeCloseTo(0, 5);
    expect(quadrantFit(score({ fit: 'strong fit' }))).toBeCloseTo(1, 5);
  });
});

describe('rpmTier', () => {
  it('high when floor ≥ $20', () => {
    expect(rpmTier(score({ lowRpm: 22 }))).toBe('high');
  });
  it('mid when floor in [$10, $20)', () => {
    expect(rpmTier(score({ lowRpm: 10 }))).toBe('mid');
    expect(rpmTier(score({ lowRpm: 19 }))).toBe('mid');
  });
  it('low when floor < $10', () => {
    expect(rpmTier(score({ lowRpm: 5 }))).toBe('low');
    expect(rpmTier(score({ lowRpm: 0 }))).toBe('low');
  });
});
