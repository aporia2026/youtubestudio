import { describe, expect, it } from 'vitest';
import {
  buildRetentionPredictionPrompt,
  countSpokenWords,
  curveAvdPercentage,
  estimateDurationSeconds,
  normalizeCurve,
  parseRetentionPrediction,
  type FewShotExample,
} from '@/lib/retention-predictor';
import { RETENTION_WORDS_PER_SECOND } from '@/lib/retention-predictor-types';

describe('countSpokenWords / estimateDurationSeconds', () => {
  it('counts words and converts to duration', () => {
    expect(countSpokenWords('one two three')).toBe(3);
    expect(estimateDurationSeconds(Math.round(RETENTION_WORDS_PER_SECOND * 60))).toBe(60);
  });
});

describe('normalizeCurve', () => {
  it('drops malformed entries and clamps to [0, 1]', () => {
    const out = normalizeCurve([
      { position: 0, retention: 1.0 },
      { position: 0.5, retention: 0.8 },
      { position: -0.1, retention: 1.5 }, // clamps to 0 / 1
      { position: 'bad', retention: 0.4 }, // dropped (string position)
      null, // dropped
      { position: 1, retention: 0.3 },
    ]);
    expect(out).toEqual([
      { position: 0, retention: 1 },
      { position: 0, retention: 1 },
      { position: 0.5, retention: 0.8 },
      { position: 1, retention: 0.3 },
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeCurve(null)).toEqual([]);
    expect(normalizeCurve('not an array')).toEqual([]);
    expect(normalizeCurve(42)).toEqual([]);
  });

  it('sorts ascending by position', () => {
    const out = normalizeCurve([
      { position: 0.8, retention: 0.4 },
      { position: 0.2, retention: 0.7 },
      { position: 0.5, retention: 0.5 },
    ]);
    expect(out.map((p) => p.position)).toEqual([0.2, 0.5, 0.8]);
  });
});

describe('curveAvdPercentage', () => {
  it('integrates a flat 100% curve to 100%', () => {
    expect(curveAvdPercentage([
      { position: 0, retention: 1 },
      { position: 1, retention: 1 },
    ])).toBe(100);
  });

  it('integrates a linear ramp 1→0 to 50%', () => {
    expect(curveAvdPercentage([
      { position: 0, retention: 1 },
      { position: 1, retention: 0 },
    ])).toBe(50);
  });

  it('returns null for sparse curves', () => {
    expect(curveAvdPercentage([])).toBeNull();
    expect(curveAvdPercentage([{ position: 0, retention: 1 }])).toBeNull();
  });

  it('handles intermediate samples (trapezoidal)', () => {
    // 1 → 0.5 → 0 across [0, 0.5, 1]
    // = 0.5*(1+0.5)/2 + 0.5*(0.5+0)/2 = 0.375 + 0.125 = 0.5 → 50%
    const v = curveAvdPercentage([
      { position: 0, retention: 1 },
      { position: 0.5, retention: 0.5 },
      { position: 1, retention: 0 },
    ]);
    expect(v).toBeCloseTo(50, 5);
  });
});

describe('buildRetentionPredictionPrompt', () => {
  const exampleA: FewShotExample = {
    youtube_video_id: 'aaaa11111',
    title: 'How I made my first million',
    duration_seconds: 720,
    retention_curve: [
      { position: 0, retention: 1 },
      { position: 0.1, retention: 0.55 },
      { position: 0.5, retention: 0.4 },
      { position: 1, retention: 0.28 },
    ],
  };

  it('embeds niche, duration, and the new script', () => {
    const { user } = buildRetentionPredictionPrompt({
      script: 'Long script text here.',
      niche: 'Personal finance',
      examples: [exampleA],
      estimatedDurationSeconds: 600,
    });
    expect(user).toContain('Personal finance');
    expect(user).toContain('600s');
    expect(user).toContain('Long script text here.');
  });

  it('lists every few-shot example with title + duration + curve', () => {
    const { user } = buildRetentionPredictionPrompt({
      script: 'x',
      examples: [exampleA],
      estimatedDurationSeconds: 720,
    });
    expect(user).toContain('How I made my first million');
    expect(user).toContain('720s');
    expect(user).toMatch(/\[0\.00, 1\.000\]/);
  });

  it('handles the no-history case (cold start) with a helpful note', () => {
    const { user } = buildRetentionPredictionPrompt({
      script: 'x',
      niche: 'AI tools',
      examples: [],
      estimatedDurationSeconds: 300,
    });
    expect(user).toMatch(/no published-video history/);
  });

  it('forbids flat curves and prescribes the JSON shape in the system prompt', () => {
    const { system } = buildRetentionPredictionPrompt({
      script: 'x',
      examples: [exampleA],
      estimatedDurationSeconds: 600,
    });
    expect(system).toMatch(/NEVER predict a flat curve/);
    expect(system).toContain('"curve"');
    expect(system).toContain('"segment_explanations"');
    expect(system).toContain('"suggested_fixes"');
  });
});

describe('parseRetentionPrediction', () => {
  function validJson() {
    return JSON.stringify({
      curve: [
        { position: 0, retention: 1.0 },
        { position: 0.05, retention: 0.78 },
        { position: 0.3, retention: 0.55 },
        { position: 0.6, retention: 0.42 },
        { position: 1, retention: 0.28 },
      ],
      predicted_avd_percentage: 47,
      segment_explanations: [
        {
          start_seconds: 0,
          end_seconds: 18,
          excerpt: 'Slow intro that talks about why this video matters.',
          predicted_drop_pct: 22,
          reason: 'rambling intro',
          fix: 'cut the first 8 seconds',
        },
        {
          start_seconds: 240,
          end_seconds: 280,
          excerpt: 'Definitions of cosine similarity, eigenvector, and orthonormal basis.',
          predicted_drop_pct: 13,
          reason: 'jargon wall',
          fix: 'add an analogy after each term',
        },
      ],
      biggest_drop_index: 0,
      suggested_fixes: ['trim the intro', 'add B-roll cuts every 12s'],
    });
  }

  it('parses a clean JSON response', () => {
    const out = parseRetentionPrediction(validJson(), 600);
    expect(out.curve).toHaveLength(5);
    expect(out.curve[0]).toEqual({ position: 0, retention: 1 });
    expect(out.segment_explanations).toHaveLength(2);
    expect(out.biggest_drop?.reason).toBe('rambling intro');
    expect(out.suggested_fixes).toHaveLength(2);
    // AVD is recomputed from the curve, not trusted from the LLM.
    expect(out.predicted_avd_percentage).toBeGreaterThan(40);
    expect(out.predicted_avd_percentage).toBeLessThan(70);
    // Seconds derived from the duration arg.
    expect(out.predicted_avd_seconds).toBeGreaterThan(240);
  });

  it('parses fenced + prose-wrapped JSON', () => {
    const fenced = '```json\n' + validJson() + '\n```';
    const out = parseRetentionPrediction(fenced, 600);
    expect(out.curve).toHaveLength(5);

    const prose = `Sure, here's the prediction:\n${validJson()}\nHope this helps!`;
    const out2 = parseRetentionPrediction(prose, 600);
    expect(out2.curve).toHaveLength(5);
  });

  it('throws when curve has fewer than 3 samples', () => {
    const tooSparse = JSON.stringify({
      curve: [{ position: 0, retention: 1 }],
      predicted_avd_percentage: 50,
      segment_explanations: [],
    });
    expect(() => parseRetentionPrediction(tooSparse, 600)).toThrow(/fewer than 3 samples/);
  });

  it('throws on garbage', () => {
    expect(() => parseRetentionPrediction('not json', 600)).toThrow(/Could not parse JSON/);
  });

  it('falls back to computing biggest_drop when index is invalid', () => {
    const noIdx = JSON.stringify({
      curve: [
        { position: 0, retention: 1 },
        { position: 0.5, retention: 0.5 },
        { position: 1, retention: 0.2 },
      ],
      predicted_avd_percentage: 50,
      segment_explanations: [
        { start_seconds: 0, end_seconds: 10, excerpt: 'a', predicted_drop_pct: 5, reason: 'mild' },
        { start_seconds: 10, end_seconds: 30, excerpt: 'b', predicted_drop_pct: 25, reason: 'big' },
        { start_seconds: 30, end_seconds: 60, excerpt: 'c', predicted_drop_pct: 8, reason: 'minor' },
      ],
      biggest_drop_index: 999,
    });
    const out = parseRetentionPrediction(noIdx, 600);
    expect(out.biggest_drop?.reason).toBe('big');
  });

  it('returns null biggest_drop when there are no segments', () => {
    const noSegs = JSON.stringify({
      curve: [
        { position: 0, retention: 1 },
        { position: 0.5, retention: 0.5 },
        { position: 1, retention: 0.2 },
      ],
      predicted_avd_percentage: 50,
      segment_explanations: [],
    });
    const out = parseRetentionPrediction(noSegs, 600);
    expect(out.biggest_drop).toBeNull();
  });

  it('drops segments with no excerpt and no reason (empty entries)', () => {
    const withEmpties = JSON.stringify({
      curve: [
        { position: 0, retention: 1 },
        { position: 0.5, retention: 0.5 },
        { position: 1, retention: 0.2 },
      ],
      predicted_avd_percentage: 50,
      segment_explanations: [
        { start_seconds: 0, end_seconds: 10, excerpt: '', predicted_drop_pct: 0, reason: '' },
        { start_seconds: 10, end_seconds: 20, excerpt: 'real one', predicted_drop_pct: 8, reason: 'bad' },
      ],
    });
    const out = parseRetentionPrediction(withEmpties, 600);
    expect(out.segment_explanations).toHaveLength(1);
    expect(out.segment_explanations[0]!.reason).toBe('bad');
  });
});
