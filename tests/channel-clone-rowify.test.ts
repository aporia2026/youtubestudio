import { describe, expect, it } from 'vitest';
import {
  computeCoverageFraction,
  parseRowifyResponse,
  type ChannelCloneProductionRow,
} from '@/lib/channel-clone/rowify-runner';
import {
  isCandidateStylePresetId,
  matchStylePreset,
} from '@/lib/channel-clone/match-style-preset';
import type { ChannelCloneVisualProfile } from '@/lib/channel-clone/types';

// ─── parseRowifyResponse ────────────────────────────────────────────

const VALID_ROW: ChannelCloneProductionRow = {
  timecode: '0:00-0:04',
  script_text: 'Right now, you are the only creature on this entire planet that can do something strange.',
  visual_type: 'ai_image',
  visual_description: 'Doodle figure looking up, surrounded by simple line-drawn animals.',
  stock_search_terms: '',
  ai_image_prompt:
    'Minimalist hand-drawn doodle on a white background: a single stick figure looking up in awe, surrounded by a dog, wolf, and monkey, all rendered in the same hand-drawn style. Single black-ink lines. Clean white background.',
  on_screen_text: '',
  notes: 'Opens with the hook verbatim; sets up the contrarian framing.',
};

const VALID_PAYLOAD = {
  rows: [
    VALID_ROW,
    {
      ...VALID_ROW,
      timecode: '0:04-0:08',
      script_text: 'You can leak salt water from your eyes when your heart breaks.',
      on_screen_text: 'CRYING',
    },
    {
      ...VALID_ROW,
      timecode: '0:08-0:13',
      script_text: 'A dog whimpers, a wolf howls — but not one of them has ever cried a single emotional tear.',
    },
  ],
};

describe('parseRowifyResponse', () => {
  it('accepts a clean payload', () => {
    const out = parseRowifyResponse(JSON.stringify(VALID_PAYLOAD));
    expect(out).toHaveLength(3);
    expect(out[0].visual_type).toBe('ai_image');
    expect(out[1].on_screen_text).toBe('CRYING');
  });

  it('strips a markdown ```json fence', () => {
    const wrapped = '```json\n' + JSON.stringify(VALID_PAYLOAD) + '\n```';
    expect(parseRowifyResponse(wrapped)).toHaveLength(3);
  });

  it('rejects when rows is missing or empty', () => {
    expect(() => parseRowifyResponse('{"rows": []}')).toThrow(/empty/);
    expect(() => parseRowifyResponse('{}')).toThrow(/rows/);
  });

  it('rejects an invalid timecode format', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    bad.rows[0].timecode = '0:00 - 0:04';
    expect(() => parseRowifyResponse(JSON.stringify(bad))).toThrow(/timecode/);
  });

  it('rejects an unknown visual_type', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    bad.rows[1].visual_type = 'video';
    expect(() => parseRowifyResponse(JSON.stringify(bad))).toThrow(/visual_type/);
  });

  it('rejects ai_image row with empty ai_image_prompt', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    bad.rows[2].ai_image_prompt = '';
    expect(() => parseRowifyResponse(JSON.stringify(bad))).toThrow(/ai_image_prompt/);
  });

  it('rejects stock row with empty stock_search_terms', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    bad.rows[0].visual_type = 'stock';
    bad.rows[0].stock_search_terms = '';
    expect(() => parseRowifyResponse(JSON.stringify(bad))).toThrow(/stock_search_terms/);
  });

  it('accepts a stock row when terms are present', () => {
    const ok = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    ok.rows[0].visual_type = 'stock';
    ok.rows[0].stock_search_terms = 'wolf howling at moon';
    const out = parseRowifyResponse(JSON.stringify(ok));
    expect(out[0].visual_type).toBe('stock');
  });

  it('rejects a row missing required string fields', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    delete bad.rows[0].script_text;
    expect(() => parseRowifyResponse(JSON.stringify(bad))).toThrow(/script_text/);
  });
});

// ─── computeCoverageFraction ────────────────────────────────────────

describe('computeCoverageFraction', () => {
  it('returns ~1 when rows exactly cover the script', () => {
    const script = 'a b c d e f g h i j';
    const rows: ChannelCloneProductionRow[] = [
      { ...VALID_ROW, script_text: 'a b c d e' },
      { ...VALID_ROW, script_text: 'f g h i j' },
    ];
    expect(computeCoverageFraction(rows, script)).toBeCloseTo(1, 2);
  });

  it('returns 0.5 when rows cover half the script', () => {
    const script = 'a'.repeat(100);
    const rows: ChannelCloneProductionRow[] = [{ ...VALID_ROW, script_text: 'a'.repeat(50) }];
    expect(computeCoverageFraction(rows, script)).toBeCloseTo(0.5, 1);
  });

  it('caps at 1.0 when concatenated rows exceed the script length', () => {
    const script = 'short';
    const rows: ChannelCloneProductionRow[] = [{ ...VALID_ROW, script_text: 'long padded duplicate over and over' }];
    expect(computeCoverageFraction(rows, script)).toBe(1);
  });

  it('returns 1 for an empty script (degenerate case)', () => {
    expect(computeCoverageFraction([], '')).toBe(1);
  });
});

// ─── matchStylePreset ───────────────────────────────────────────────

describe('matchStylePreset', () => {
  it('defaults to paint_explainer_v1 when no profile is supplied', () => {
    const out = matchStylePreset(undefined);
    expect(out.presetId).toBe('paint_explainer_v1');
    expect(out.reason).toMatch(/no visual profile/);
  });

  it('matches doodle_explainer_2 on "stick figure"', () => {
    const profile: ChannelCloneVisualProfile = {
      artStyle: 'Black stick-figure line art on white background.',
      paletteHex: ['#FFFFFF', '#000000'],
      lightingStyle: 'flat',
      compositionPatterns: 'centered subject',
      detailLevel: 'low',
      mood: 'curious',
    };
    expect(matchStylePreset(profile).presetId).toBe('doodle_explainer_2');
  });

  it('matches whiteboard on "whiteboard"', () => {
    const profile: ChannelCloneVisualProfile = {
      artStyle: 'Marker-on-whiteboard illustration.',
      paletteHex: ['#FFFFFF', '#222222'],
      lightingStyle: 'studio flat',
      compositionPatterns: 'wide',
      detailLevel: 'medium',
      mood: 'instructive',
    };
    expect(matchStylePreset(profile).presetId).toBe('whiteboard');
  });

  it('matches documentary on "real photo"', () => {
    const profile: ChannelCloneVisualProfile = {
      artStyle: 'Real photo + archival footage style.',
      paletteHex: ['#1a1a1a'],
      lightingStyle: 'natural',
      compositionPatterns: 'rule of thirds',
      detailLevel: 'high',
      mood: 'serious',
    };
    expect(matchStylePreset(profile).presetId).toBe('documentary');
  });

  it('falls through to paint_explainer_v1 on unknown style', () => {
    const profile: ChannelCloneVisualProfile = {
      artStyle: 'a completely unique style with no keywords',
      paletteHex: [],
      lightingStyle: 'x',
      compositionPatterns: 'y',
      detailLevel: 'z',
      mood: 'w',
    };
    const out = matchStylePreset(profile);
    expect(out.presetId).toBe('paint_explainer_v1');
    expect(out.reason).toMatch(/no keyword matched/);
  });
});

describe('isCandidateStylePresetId', () => {
  it('accepts known ids', () => {
    expect(isCandidateStylePresetId('paint_explainer_v1')).toBe(true);
    expect(isCandidateStylePresetId('whiteboard')).toBe(true);
  });

  it('rejects unknown ids', () => {
    expect(isCandidateStylePresetId('cinemagic')).toBe(false);
    expect(isCandidateStylePresetId('')).toBe(false);
  });
});
