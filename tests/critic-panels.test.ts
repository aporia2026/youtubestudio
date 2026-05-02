import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock @/lib/ai BEFORE importing the runner so generateText is replaced.
// The runner doesn't care which model is "real" — every prompt builder
// shape goes through generateText.
vi.mock('@/lib/ai', () => {
  return {
    generateText: vi.fn(),
    getModelById: vi.fn(() => ({ id: 'kie-gemini-3.1-pro' })),
  };
});

import { generateText } from '@/lib/ai';
import { runScriptPanelLive } from '@/lib/script-critics/runner-live';
import type { PanelEvent } from '@/lib/script-critics/panel-events';

const generateTextMock = generateText as unknown as ReturnType<typeof vi.fn>;

/** Realistic-looking JSON the panel will accept. The shape matches what the
 *  prompt asks each phase to return — runner normalisers fill in defaults
 *  for missing keys, so we only have to populate the load-bearing ones. */
function fakeContribution() {
  return JSON.stringify({
    redLines: ['no clickbait', 'no false urgency', 'no shouting'],
    priorityRules: ['hook in 3s', 'one takeaway', 'punchy delivery'],
    nonGoals: ['comprehensive coverage', 'edutainment', 'B-roll padding'],
    anchor90: 'Top 5%: opens with mid-conflict claim, single sharp insight, payoff lands in last sentence.',
    anchor75: 'Solid: hook works, structure clear, ending is fine.',
    summary: 'Charter contribution.',
  });
}

function fakeCharterSynthesis() {
  return JSON.stringify({
    mission: 'Win the first 3 seconds and land the payoff.',
    redLines: ['no clickbait'],
    perCritic: {},
    scoringAnchors: {
      ninetyFive: 'Outstanding hook + payoff with no rough edges.',
      eightyFive: 'Strong hook, clean structure, minor flaws.',
      seventy: 'Workable but slow open or weak ending.',
    },
    chairSummary: 'Aligned charter for this run.',
  });
}

function fakeDraft(score: number) {
  return JSON.stringify({
    overall_score: score,
    summary: 'Draft summary.',
    categories: {
      hook_strength: { score, assessment: 'opens fast', issues: [], fix: '—' },
      content_quality: { score, assessment: 'solid', issues: [], fix: '—' },
      pacing_flow: { score, assessment: 'tight', issues: [], fix: '—' },
    },
    critical_issues: [],
    strengths: ['clear voice'],
  });
}

function fakeDeliberation(score: number) {
  return JSON.stringify({
    summary: 'Deliberation summary.',
    updated_score: score,
    peer_responses: [],
    updated_categories: {},
    updated_issues: [],
    my_non_negotiables: ['preserve hook line'],
    my_willing_to_accept: ['rewrite the CTA'],
    my_predicted_score_if_bundle_applied: score,
  });
}

function fakeChair(score: number) {
  return JSON.stringify({
    overall_score: score,
    verdict: 'pass',
    will_it_perform: 'likely',
    consensus_pass: true,
    chair_summary: 'Panel agrees.',
    categories: {},
    critical_issues: [],
    strengths: ['clear voice'],
    rewrite_suggestions: [],
    title_suggestions: ['A strong title'],
    thumbnail_ideas: ['A strong thumbnail'],
    next_pass_focus: 'polish CTA',
    bundle_unanimous: true,
  });
}

beforeEach(() => {
  generateTextMock.mockReset();
});

describe('runScriptPanelLive event ordering', () => {
  it('emits panel:start first, panel:complete last, with all phases in between', async () => {
    // 3 charter contributions + 1 charter synthesis + 3 drafts + 3 deliberations + 1 chair = 11 calls
    const queue: string[] = [
      fakeContribution(), fakeContribution(), fakeContribution(),
      fakeCharterSynthesis(),
      fakeDraft(82), fakeDraft(78), fakeDraft(85),
      fakeDeliberation(80), fakeDeliberation(79), fakeDeliberation(83),
      fakeChair(81),
    ];
    generateTextMock.mockImplementation(async () => queue.shift() ?? '{}');

    const events: PanelEvent[] = [];
    const generator = runScriptPanelLive({
      script: 'A '.repeat(150) + 'long-enough script body to feed the prompt builder.',
      niche: 'AI tools',
      passNumber: 1,
      aggressiveness: 'standard',
      modelId: 'claude-sonnet-4-6',
    });
    for await (const ev of generator) {
      events.push(ev as PanelEvent);
    }

    expect(events.length).toBeGreaterThan(8);
    expect(events[0]!.phase).toBe('panel');
    expect(events[0]!.event_type).toBe('start');
    const last = events[events.length - 1]!;
    expect(last.phase).toBe('panel');
    expect(last.event_type).toBe('complete');

    // The chair-complete event must precede panel-complete.
    const chairCompleteIdx = events.findIndex(
      (e) => e.phase === 'chair' && e.event_type === 'complete',
    );
    const panelCompleteIdx = events.findIndex(
      (e) => e.phase === 'panel' && e.event_type === 'complete',
    );
    expect(chairCompleteIdx).toBeGreaterThan(-1);
    expect(panelCompleteIdx).toBeGreaterThan(chairCompleteIdx);
  });

  it('emits exactly one start and one complete per critic in the draft phase', async () => {
    const queue = [
      fakeContribution(), fakeContribution(), fakeContribution(),
      fakeCharterSynthesis(),
      fakeDraft(80), fakeDraft(80), fakeDraft(80),
      fakeDeliberation(80), fakeDeliberation(80), fakeDeliberation(80),
      fakeChair(80),
    ];
    generateTextMock.mockImplementation(async () => queue.shift() ?? '{}');

    const events: PanelEvent[] = [];
    for await (const ev of runScriptPanelLive({
      script: 'x '.repeat(200),
      niche: 'AI tools',
      passNumber: 1,
      aggressiveness: 'standard',
      modelId: 'claude-sonnet-4-6',
    })) {
      events.push(ev as PanelEvent);
    }

    const draftStarts = events.filter((e) => e.phase === 'draft' && e.event_type === 'start');
    const draftCompletes = events.filter((e) => e.phase === 'draft' && e.event_type === 'complete');
    expect(draftStarts).toHaveLength(3);
    expect(draftCompletes).toHaveLength(3);

    const startCritics = draftStarts.map((e) => e.critic_id).sort();
    const completeCritics = draftCompletes.map((e) => e.critic_id).sort();
    expect(startCritics).toEqual(['flow-critic', 'hook-coach', 'substance-auditor']);
    expect(completeCritics).toEqual(startCritics);
  });

  it('emits exactly one start and one complete per critic in the deliberation phase', async () => {
    const queue = [
      fakeContribution(), fakeContribution(), fakeContribution(),
      fakeCharterSynthesis(),
      fakeDraft(80), fakeDraft(80), fakeDraft(80),
      fakeDeliberation(80), fakeDeliberation(80), fakeDeliberation(80),
      fakeChair(80),
    ];
    generateTextMock.mockImplementation(async () => queue.shift() ?? '{}');

    const events: PanelEvent[] = [];
    for await (const ev of runScriptPanelLive({
      script: 'x '.repeat(200),
      niche: 'AI tools',
      passNumber: 1,
      aggressiveness: 'standard',
      modelId: 'claude-sonnet-4-6',
    })) {
      events.push(ev as PanelEvent);
    }
    const dStarts = events.filter((e) => e.phase === 'deliberation' && e.event_type === 'start');
    const dCompletes = events.filter((e) => e.phase === 'deliberation' && e.event_type === 'complete');
    expect(dStarts).toHaveLength(3);
    expect(dCompletes).toHaveLength(3);
  });

  it('panel:complete payload carries the final verdict', async () => {
    const queue = [
      fakeContribution(), fakeContribution(), fakeContribution(),
      fakeCharterSynthesis(),
      fakeDraft(82), fakeDraft(78), fakeDraft(85),
      fakeDeliberation(80), fakeDeliberation(79), fakeDeliberation(83),
      fakeChair(81),
    ];
    generateTextMock.mockImplementation(async () => queue.shift() ?? '{}');

    const events: PanelEvent[] = [];
    for await (const ev of runScriptPanelLive({
      script: 'x '.repeat(200),
      niche: 'AI tools',
      passNumber: 1,
      aggressiveness: 'standard',
      modelId: 'claude-sonnet-4-6',
    })) {
      events.push(ev as PanelEvent);
    }
    const panelComplete = events[events.length - 1]!;
    expect(panelComplete.phase).toBe('panel');
    expect(panelComplete.event_type).toBe('complete');
    const payload = panelComplete.payload as { verdict?: { overall_score?: number; deliberations?: unknown[] } };
    expect(payload.verdict?.overall_score).toBe(81);
    expect(payload.verdict?.deliberations).toBeDefined();
  });

  it('falls back gracefully when a critic returns unparseable JSON', async () => {
    const queue = [
      fakeContribution(), fakeContribution(), fakeContribution(),
      fakeCharterSynthesis(),
      'not even close to JSON', // hook-coach draft fails
      fakeDraft(80),
      fakeDraft(80),
      fakeDeliberation(80), fakeDeliberation(80), fakeDeliberation(80),
      fakeChair(70),
    ];
    generateTextMock.mockImplementation(async () => queue.shift() ?? '{}');

    const events: PanelEvent[] = [];
    for await (const ev of runScriptPanelLive({
      script: 'x '.repeat(200),
      niche: 'AI tools',
      passNumber: 1,
      aggressiveness: 'standard',
      modelId: 'claude-sonnet-4-6',
    })) {
      events.push(ev as PanelEvent);
    }
    // Even with one parse failure, the panel should still complete.
    const final = events[events.length - 1]!;
    expect(final.phase).toBe('panel');
    expect(final.event_type).toBe('complete');
    // All three drafts still emit complete events (the worker substitutes
    // an emptyDraft fallback for the bad one).
    const draftCompletes = events.filter((e) => e.phase === 'draft' && e.event_type === 'complete');
    expect(draftCompletes).toHaveLength(3);
  });

  it('skips the charter phase entirely when one is supplied', async () => {
    // No charter contributions in the queue — if the runner tries to
    // call them anyway the tests will fail with empty stub responses.
    const queue = [
      fakeDraft(80), fakeDraft(80), fakeDraft(80),
      fakeDeliberation(80), fakeDeliberation(80), fakeDeliberation(80),
      fakeChair(80),
    ];
    generateTextMock.mockImplementation(async () => queue.shift() ?? '{}');

    const events: PanelEvent[] = [];
    const supplied = {
      mission: 'Test charter',
      redLines: [],
      perCritic: {},
      scoringAnchors: { ninetyFive: '', eightyFive: '', seventy: '' },
      contributions: [],
      chairSummary: '',
    };
    for await (const ev of runScriptPanelLive({
      script: 'x '.repeat(200),
      niche: 'AI tools',
      passNumber: 2,
      aggressiveness: 'standard',
      modelId: 'claude-sonnet-4-6',
      charter: supplied,
    })) {
      events.push(ev as PanelEvent);
    }
    const charterEvents = events.filter((e) => e.phase === 'charter');
    expect(charterEvents).toHaveLength(0);
    // Drafts still happen.
    expect(events.filter((e) => e.phase === 'draft').length).toBeGreaterThan(0);
  });
});
