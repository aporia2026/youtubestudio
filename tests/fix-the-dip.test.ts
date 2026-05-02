import { describe, expect, it } from 'vitest';
import {
  buildDipFixPrompt,
  detectRawDips,
  parseDipFixOutput,
  scriptExcerptForDip,
  severityFromDrop,
} from '@/lib/fix-the-dip';
import { MAX_DIPS_PER_ANALYSIS, MIN_DIP_DROP_PCT } from '@/lib/fix-the-dip-types';

describe('severityFromDrop', () => {
  it('classifies drops by magnitude', () => {
    expect(severityFromDrop(2)).toBe('minor');
    expect(severityFromDrop(8)).toBe('moderate');
    expect(severityFromDrop(15)).toBe('major');
    expect(severityFromDrop(40)).toBe('cliff');
  });
});

describe('detectRawDips', () => {
  it('returns no dips for a perfectly flat curve', () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      position: i / 19,
      retention: 1,
    }));
    expect(detectRawDips(flat, 600)).toEqual([]);
  });

  it('returns no dips for a slow gradual decline (no sharp drops)', () => {
    // Linear decline 1 → 0.4 over 600s. The drop within any 30s window is
    // ~3 percentage points — below MIN_DIP_DROP_PCT (4).
    const slow = Array.from({ length: 21 }, (_, i) => ({
      position: i / 20,
      retention: 1 - (i / 20) * 0.6,
    }));
    expect(detectRawDips(slow, 600)).toEqual([]);
  });

  it('detects a single sharp dip', () => {
    // 100% holds, then crashes 100% → 60% over 15 seconds, then plateaus.
    const curve = [
      { position: 0, retention: 1 },
      { position: 0.1, retention: 1 },
      { position: 0.2, retention: 1 },
      { position: 0.225, retention: 0.6 }, // 15s later (in a 600s video)
      { position: 0.5, retention: 0.6 },
      { position: 1, retention: 0.55 },
    ];
    const dips = detectRawDips(curve, 600);
    expect(dips).toHaveLength(1);
    expect(dips[0]!.drop_pct).toBeCloseTo(40, 0);
    expect(dips[0]!.severity).toBe('cliff');
  });

  it('detects multiple separate dips and sorts by magnitude', () => {
    const curve = [
      { position: 0, retention: 1 },
      { position: 0.1, retention: 0.8 },   // dip 1: 20pt drop
      { position: 0.2, retention: 0.8 },
      { position: 0.21, retention: 0.75 }, // small wiggle
      { position: 0.3, retention: 0.78 },
      { position: 0.4, retention: 0.78 },
      { position: 0.41, retention: 0.45 }, // dip 2: 33pt drop (larger)
      { position: 0.5, retention: 0.45 },
      { position: 1, retention: 0.4 },
    ];
    const dips = detectRawDips(curve, 600);
    expect(dips.length).toBeGreaterThanOrEqual(2);
    // Sorted worst first.
    expect(dips[0]!.drop_pct).toBeGreaterThan(dips[1]!.drop_pct);
  });

  it('caps detected dips at MAX_DIPS_PER_ANALYSIS', () => {
    // A sawtooth curve with 12 sharp drops.
    const points: Array<{ position: number; retention: number }> = [];
    for (let i = 0; i < 12; i++) {
      const base = i / 12;
      points.push({ position: base, retention: 1 });
      points.push({ position: base + 0.005, retention: 0.6 });
      points.push({ position: base + 0.01, retention: 1 });
    }
    points.push({ position: 1, retention: 1 });
    const dips = detectRawDips(points, 6000); // long video so 30s ≈ 0.005 fraction
    expect(dips.length).toBeLessThanOrEqual(MAX_DIPS_PER_ANALYSIS);
  });

  it('returns [] for sparse curves', () => {
    expect(detectRawDips([], 600)).toEqual([]);
    expect(detectRawDips([{ position: 0, retention: 1 }], 600)).toEqual([]);
  });

  it('returns [] when video duration is 0 or negative', () => {
    const curve = [
      { position: 0, retention: 1 },
      { position: 0.5, retention: 0.5 },
      { position: 1, retention: 0.3 },
    ];
    expect(detectRawDips(curve, 0)).toEqual([]);
    expect(detectRawDips(curve, -10)).toEqual([]);
  });

  it('respects the MAX_DIP_DURATION_SECONDS window', () => {
    // 100% → 50% but spread over 90 seconds (not a "dip", just a slow decline).
    // Within any 30s window the drop is ~17pt, but we still detect because each
    // local max → next min is captured at the curve's resolution.
    // This test asserts the window prevents conflating the WHOLE 90s descent
    // into one dip.
    const curve = [
      { position: 0.0, retention: 1.0 },
      { position: 0.05, retention: 1.0 },   // local max @ 30s
      { position: 0.1, retention: 0.83 },   // 60s
      { position: 0.15, retention: 0.66 },  // 90s
      { position: 0.2, retention: 0.5 },    // 120s
      { position: 1.0, retention: 0.5 },
    ];
    // 600s video, so 30s = 0.05 fraction. The detector should chunk the
    // decline into multiple dips bounded by the 30s window, not return
    // one giant dip.
    const dips = detectRawDips(curve, 600);
    for (const d of dips) {
      expect(d.end_seconds - d.start_seconds).toBeLessThanOrEqual(40);
    }
  });

  it('every reported dip has drop_pct >= MIN_DIP_DROP_PCT', () => {
    const curve = [
      { position: 0, retention: 1 },
      { position: 0.05, retention: 0.97 }, // 3pt drop (below threshold)
      { position: 0.1, retention: 0.97 },
      { position: 0.2, retention: 0.6 },   // 37pt drop (above)
      { position: 0.5, retention: 0.6 },
      { position: 1, retention: 0.55 },
    ];
    const dips = detectRawDips(curve, 600);
    for (const d of dips) {
      expect(d.drop_pct).toBeGreaterThanOrEqual(MIN_DIP_DROP_PCT);
    }
  });
});

describe('scriptExcerptForDip', () => {
  it('returns the script segment proportional to the dip timecode', () => {
    const script = Array.from({ length: 200 }, (_, i) => `word${i + 1}`).join(' ');
    const excerpt = scriptExcerptForDip(script, 100, 25, 35); // 25-35% in
    // 200 words / 100s = 2 wps. 25s × 2 = word index 50 (zero-based) = "word51".
    expect(excerpt).toContain('word51');
    expect(excerpt.length).toBeLessThanOrEqual(280);
  });

  it('returns empty string for an empty script', () => {
    expect(scriptExcerptForDip('', 100, 0, 10)).toBe('');
  });

  it('handles 0 duration gracefully', () => {
    expect(scriptExcerptForDip('hello world', 0, 0, 10)).toBe('');
  });

  it('truncates with ellipsis when excerpt would exceed 280 chars', () => {
    const long = Array.from({ length: 500 }, () => 'verylongwordinscript').join(' ');
    const excerpt = scriptExcerptForDip(long, 60, 0, 60); // entire video
    expect(excerpt.length).toBeLessThanOrEqual(280);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('buildDipFixPrompt', () => {
  it('embeds every dip with timecodes + script excerpt + drop magnitude', () => {
    const { user } = buildDipFixPrompt({
      videoTitle: 'Test',
      videoDurationSeconds: 600,
      scriptText: 'Full script body.',
      rawDips: [
        {
          start_seconds: 0,
          end_seconds: 18,
          retention_before: 1.0,
          retention_after: 0.78,
          drop_pct: 22,
          severity: 'major',
          script_excerpt: 'Slow rambling intro that takes too long.',
        },
        {
          start_seconds: 240,
          end_seconds: 270,
          retention_before: 0.6,
          retention_after: 0.45,
          drop_pct: 15,
          severity: 'major',
          script_excerpt: 'And now a word from our sponsor.',
        },
      ],
      observedAvpPercentage: 42.5,
    });
    expect(user).toContain('0:00 → 0:18');
    expect(user).toContain('4:00 → 4:30');
    expect(user).toContain('22.0 pts');
    expect(user).toContain('15.0 pts');
    expect(user).toContain('Slow rambling intro');
    expect(user).toContain('a word from our sponsor');
    expect(user).toContain('42.5%');
  });

  it('forbids generic "make it more engaging" fixes in the system prompt', () => {
    const { system } = buildDipFixPrompt({
      videoTitle: null,
      videoDurationSeconds: 600,
      scriptText: 'x',
      rawDips: [],
      observedAvpPercentage: null,
    });
    expect(system).toMatch(/NEVER say "make it more engaging"/);
    expect(system).toMatch(/NEVER claim a dip was "natural attrition"/);
  });
});

describe('parseDipFixOutput', () => {
  const rawDips = [
    {
      start_seconds: 0,
      end_seconds: 18,
      retention_before: 1.0,
      retention_after: 0.78,
      drop_pct: 22,
      severity: 'major' as const,
      script_excerpt: 'Slow rambling intro.',
    },
    {
      start_seconds: 240,
      end_seconds: 270,
      retention_before: 0.6,
      retention_after: 0.45,
      drop_pct: 15,
      severity: 'major' as const,
      script_excerpt: 'Sponsor read.',
    },
  ];

  it('maps LLM output back onto the deterministic dips by index', () => {
    const llm = JSON.stringify({
      dips: [
        { index: 1, why: 'rambling intro', fix: 'cut first 8s', estimated_lift_pct: 3 },
        { index: 2, why: 'unintegrated ad', fix: 'host-read mid-roll instead', estimated_lift_pct: 5 },
      ],
      patterns: [],
      top_fixes: ['Trim the cold open', 'Replace the ad break with mid-roll'],
    });
    const out = parseDipFixOutput(llm, rawDips);
    expect(out.dips).toHaveLength(2);
    expect(out.dips[0]!.why).toBe('rambling intro');
    expect(out.dips[0]!.fix).toBe('cut first 8s');
    expect(out.dips[0]!.estimated_lift_pct).toBe(3);
    // Dip detection-side fields (timecodes, drop_pct) come from rawDips,
    // never from the LLM — defence against hallucinated dips.
    expect(out.dips[0]!.start_seconds).toBe(0);
    expect(out.dips[0]!.drop_pct).toBe(22);
    expect(out.top_fixes).toHaveLength(2);
  });

  it('drops LLM dip entries with out-of-range indices (no hallucinations)', () => {
    const llm = JSON.stringify({
      dips: [
        { index: 1, why: 'good', fix: 'good fix' },
        { index: 999, why: 'made up', fix: 'made up fix' }, // invalid
        { index: 0, why: 'also bad', fix: 'also bad fix' }, // 1-based; 0 is invalid
      ],
      patterns: [],
      top_fixes: [],
    });
    const out = parseDipFixOutput(llm, rawDips);
    expect(out.dips).toHaveLength(2);
    expect(out.dips[0]!.why).toBe('good');
    // Dip 2 was never touched by the LLM, so it gets the fallback.
    expect(out.dips[1]!.why).toBe('No hypothesis returned.');
  });

  it('parses patterns with valid index references', () => {
    const llm = JSON.stringify({
      dips: [],
      patterns: [
        {
          pattern: 'ad-break attrition',
          affected_dip_indices: [2, 999],
          recommendation: 'integrate sponsor mentions into the body',
        },
      ],
      top_fixes: [],
    });
    const out = parseDipFixOutput(llm, rawDips);
    expect(out.patterns).toHaveLength(1);
    // Index 999 is filtered out, only 2 (→ 1 zero-indexed) remains.
    expect(out.patterns[0]!.affected_dip_indices).toEqual([1]);
  });

  it('throws on unparseable JSON', () => {
    expect(() => parseDipFixOutput('not json', rawDips)).toThrow(/Could not parse JSON/);
  });

  it('returns the same number of dips as rawDips even when LLM omits some', () => {
    const llm = JSON.stringify({ dips: [], patterns: [], top_fixes: [] });
    const out = parseDipFixOutput(llm, rawDips);
    expect(out.dips).toHaveLength(rawDips.length);
    expect(out.dips.every((d) => d.fix.length > 0)).toBe(true); // fallback fix
  });
});
