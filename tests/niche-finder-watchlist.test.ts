/**
 * Pure-helper tests for Phase 13.2.W watchlist math:
 *   - trimHistory keeps the newest entries and respects HISTORY_MAX.
 *   - snapshotFromScores reads scores correctly into the JSONB shape.
 *   - detectScoreSpike fires only when |delta| meets threshold, sets
 *     direction, and short-circuits cleanly for thin / disabled histories.
 *
 * Also asserts that the new niche_score_spike event is registered in
 * BOTH the workflow trigger registry and the webhook event registry,
 * so a future refactor that drops one of them is caught.
 */
import { describe, expect, it } from 'vitest';
import {
  trimHistory,
  snapshotFromScores,
  detectScoreSpike,
  HISTORY_MAX,
  DEFAULT_ALARM_THRESHOLD,
  type WatchlistSnapshot,
} from '@/lib/niche-finder/watchlist';
import { WORKFLOW_TRIGGER_EVENTS } from '@/lib/workflows-types';
import { WEBHOOK_EVENT_TYPES } from '@/lib/webhooks-types';
import type { NicheScores } from '@/lib/niche-finder/types';

function snapshot(combined: number, daysAgo: number): WatchlistSnapshot {
  const ms = Date.parse('2026-05-13T00:00:00Z') - daysAgo * 24 * 60 * 60 * 1000;
  return {
    captured_at: new Date(ms).toISOString(),
    combined,
    demand_label: 'high',
    supply_label: 'room to enter',
    monetization_label: 'high',
    monetization_low_usd: 5,
    monetization_high_usd: 15,
    fit_label: 'strong fit',
  };
}

describe('trimHistory', () => {
  it('returns the input unchanged when under the cap', () => {
    const short = [snapshot(0.5, 1), snapshot(0.6, 0)];
    expect(trimHistory(short)).toEqual(short);
  });

  it('keeps the newest entries when over the cap', () => {
    const long = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => snapshot(i / 100, HISTORY_MAX + 5 - i));
    const trimmed = trimHistory(long);
    expect(trimmed).toHaveLength(HISTORY_MAX);
    expect(trimmed[trimmed.length - 1]).toEqual(long[long.length - 1]);
    expect(trimmed[0]).toEqual(long[5]);
  });

  it('handles empty input', () => {
    expect(trimHistory([])).toEqual([]);
  });
});

describe('snapshotFromScores', () => {
  it('rounds combined to 4 decimal places and copies labels', () => {
    const scores: NicheScores = {
      demand: { numeric: 0.7, label: 'high', confidence: 'pretty sure', evidence: {} },
      supply: { numeric: 0.3, label: 'room to enter', confidence: 'pretty sure', evidence: {} },
      monetization: {
        numeric: 0.5,
        label: 'medium',
        confidence: 'fairly confident',
        lowUsdPerMille: 3,
        highUsdPerMille: 9,
        evidence: {},
      },
      fit: { numeric: 0.8, label: 'strong fit', confidence: 'pretty sure', evidence: {} },
      combined: 0.123456789,
    };
    const s = snapshotFromScores(scores, '2026-05-13T00:00:00Z');
    expect(s.combined).toBe(0.1235);
    expect(s.demand_label).toBe('high');
    expect(s.supply_label).toBe('room to enter');
    expect(s.monetization_label).toBe('medium');
    expect(s.monetization_low_usd).toBe(3);
    expect(s.monetization_high_usd).toBe(9);
    expect(s.fit_label).toBe('strong fit');
    expect(s.captured_at).toBe('2026-05-13T00:00:00Z');
  });
});

describe('detectScoreSpike', () => {
  it('returns no-spike for fewer than two snapshots', () => {
    expect(detectScoreSpike([], 0.1).spike).toBe(false);
    expect(detectScoreSpike([snapshot(0.5, 0)], 0.1).spike).toBe(false);
  });

  it('returns no-spike when threshold is null', () => {
    const history = [snapshot(0.3, 1), snapshot(0.7, 0)];
    expect(detectScoreSpike(history, null).spike).toBe(false);
  });

  it('returns no-spike when threshold is non-positive or non-finite', () => {
    const history = [snapshot(0.3, 1), snapshot(0.7, 0)];
    expect(detectScoreSpike(history, 0).spike).toBe(false);
    expect(detectScoreSpike(history, -0.5).spike).toBe(false);
    expect(detectScoreSpike(history, Number.NaN).spike).toBe(false);
  });

  it('fires up-direction spike when combined jumps beyond threshold', () => {
    const history = [snapshot(0.3, 1), snapshot(0.5, 0)];
    const r = detectScoreSpike(history, 0.15);
    expect(r.spike).toBe(true);
    expect(r.direction).toBe('up');
    expect(r.delta).toBeCloseTo(0.2, 4);
  });

  it('fires down-direction spike when combined drops beyond threshold', () => {
    const history = [snapshot(0.8, 1), snapshot(0.4, 0)];
    const r = detectScoreSpike(history, 0.1);
    expect(r.spike).toBe(true);
    expect(r.direction).toBe('down');
    expect(r.delta).toBeLessThan(0);
  });

  it('does not fire when |delta| is just below threshold', () => {
    const history = [snapshot(0.5, 1), snapshot(0.59, 0)];
    expect(detectScoreSpike(history, 0.1).spike).toBe(false);
  });

  it('fires exactly at threshold', () => {
    const history = [snapshot(0.5, 1), snapshot(0.6, 0)];
    expect(detectScoreSpike(history, 0.1).spike).toBe(true);
  });

  it('only compares the last two entries (ignores earlier noise)', () => {
    const history = [snapshot(0.1, 5), snapshot(0.9, 4), snapshot(0.5, 1), snapshot(0.55, 0)];
    expect(detectScoreSpike(history, 0.1).spike).toBe(false);
  });

  it('sets trigger_captured_at to the latest snapshot when firing', () => {
    const history = [snapshot(0.3, 1), snapshot(0.5, 0)];
    const r = detectScoreSpike(history, 0.1);
    expect(r.trigger_captured_at).toBe(history[1].captured_at);
  });
});

describe('event registry includes niche_score_spike', () => {
  it('appears in WORKFLOW_TRIGGER_EVENTS', () => {
    expect(
      (WORKFLOW_TRIGGER_EVENTS as ReadonlyArray<{ type: string }>).some((e) => e.type === 'niche_score_spike'),
    ).toBe(true);
  });

  it('appears in WEBHOOK_EVENT_TYPES', () => {
    expect(
      (WEBHOOK_EVENT_TYPES as ReadonlyArray<{ type: string }>).some((e) => e.type === 'niche_score_spike'),
    ).toBe(true);
  });

  it('DEFAULT_ALARM_THRESHOLD is a sensible value', () => {
    expect(DEFAULT_ALARM_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_ALARM_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
