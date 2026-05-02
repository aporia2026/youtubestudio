import { describe, expect, it } from 'vitest';
import { buildBrollPrompt, mapKieStateToStatus } from '@/lib/broll';
import {
  BROLL_MAX_PROMPT_CHARS,
  BROLL_MIN_PROMPT_CHARS,
  BROLL_MODELS,
  DEFAULT_BROLL_MODEL_ID,
  brollRowSignatureInput,
  findBrollModel,
} from '@/lib/broll-types';

describe('buildBrollPrompt', () => {
  it('uses ai_image_prompt as the spine when present', () => {
    const out = buildBrollPrompt({
      visualDescription: 'short fallback',
      aiImagePrompt:
        'A wide cinematic shot of a serene lake at golden hour, soft mist rising off the water, distant mountains, gentle natural light',
    });
    expect(out).toContain('cinematic shot of a serene lake');
    // Cinematic tail is appended.
    expect(out).toMatch(/Photoreal,? no on-screen text/);
  });

  it('falls back to visual_description when no ai_image_prompt', () => {
    const out = buildBrollPrompt({
      visualDescription: 'A close-up of a fountain pen scribbling cursive on parchment, ink glistening',
    });
    expect(out).toContain('fountain pen');
    expect(out).toMatch(/no on-screen text/);
  });

  it('appends the style hint verbatim', () => {
    const out = buildBrollPrompt({
      visualDescription: 'A street vendor selling tacos under neon lights',
      styleHint: 'shot on 35mm film, anamorphic lens, slight grain',
    });
    expect(out).toContain('shot on 35mm film');
    expect(out).toContain('anamorphic lens');
  });

  it('throws when both inputs are empty', () => {
    expect(() => buildBrollPrompt({ visualDescription: '', aiImagePrompt: '' })).toThrow(
      /no visual_description or ai_image_prompt/,
    );
  });

  it('truncates oversized prompts to maxChars while preserving the cinematic tail', () => {
    const huge = 'lorem ipsum dolor sit amet '.repeat(200); // ~5400 chars
    const out = buildBrollPrompt({ visualDescription: 'fallback', aiImagePrompt: huge, maxChars: 600 });
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toMatch(/no on-screen text/);
    expect(out).toContain('lorem ipsum');
  });

  it('strips all whitespace runs (newlines, tabs) into single spaces', () => {
    const out = buildBrollPrompt({
      visualDescription: 'hero\n\nshot of\t\trolling   hills with    sweeping clouds at dawn',
    });
    expect(out).not.toMatch(/\n/);
    expect(out).not.toMatch(/\t/);
    expect(out).not.toMatch(/  /); // no double spaces
  });
});

describe('mapKieStateToStatus', () => {
  it('maps success → ready', () => {
    expect(mapKieStateToStatus('success')).toBe('ready');
  });
  it('maps fail → failed', () => {
    expect(mapKieStateToStatus('fail')).toBe('failed');
  });
  it('maps queuing / waiting / generating → generating', () => {
    expect(mapKieStateToStatus('queuing')).toBe('generating');
    expect(mapKieStateToStatus('waiting')).toBe('generating');
    expect(mapKieStateToStatus('generating')).toBe('generating');
  });
  it('treats unknown values as still in-flight (defensive)', () => {
    expect(mapKieStateToStatus('unknown')).toBe('generating');
    expect(mapKieStateToStatus(undefined)).toBe('generating');
    expect(mapKieStateToStatus(null)).toBe('generating');
    expect(mapKieStateToStatus(42)).toBe('generating');
  });
});

describe('BROLL_MODELS registry', () => {
  it('has a default model that resolves', () => {
    expect(findBrollModel(DEFAULT_BROLL_MODEL_ID)).toBeDefined();
  });

  it('exposes Sora 2 and Veo 3 (fast + quality)', () => {
    const ids = BROLL_MODELS.map((m) => m.id);
    expect(ids).toContain('sora-2');
    expect(ids).toContain('veo-3-fast');
    expect(ids).toContain('veo-3-quality');
  });

  it('marks exactly one model as recommended', () => {
    const recommended = BROLL_MODELS.filter((m) => m.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]!.id).toBe(DEFAULT_BROLL_MODEL_ID);
  });

  it('all models have a non-empty kieModel string and 16:9 support', () => {
    for (const m of BROLL_MODELS) {
      expect(m.kieModel).toMatch(/.+\/.+/);
      expect(m.supportedAspects).toContain('16:9');
      expect(m.defaultDurationSeconds).toBeGreaterThan(0);
      expect(m.defaultDurationSeconds).toBeLessThanOrEqual(20);
    }
  });

  it('rejects unknown model lookups', () => {
    expect(findBrollModel('does-not-exist')).toBeUndefined();
  });
});

describe('prompt length constants', () => {
  it('min < max', () => {
    expect(BROLL_MIN_PROMPT_CHARS).toBeLessThan(BROLL_MAX_PROMPT_CHARS);
  });
  it('max stays within the Kie API ceiling (~1500)', () => {
    expect(BROLL_MAX_PROMPT_CHARS).toBeLessThanOrEqual(1500);
  });
});

describe('brollRowSignatureInput', () => {
  it('joins timecode + lowercased visual description', () => {
    expect(brollRowSignatureInput({ timecode: '0:30', visual_description: 'Wide Shot of City' })).toBe(
      '0:30::wide shot of city',
    );
  });
  it('handles missing fields without throwing', () => {
    expect(brollRowSignatureInput({})).toBe('::');
    expect(brollRowSignatureInput({ timecode: '0:30' })).toBe('0:30::');
    expect(brollRowSignatureInput({ visual_description: 'X' })).toBe('::x');
  });
  it('is stable under whitespace and case variants', () => {
    const a = brollRowSignatureInput({ timecode: ' 0:30 ', visual_description: '  Wide Shot of City  ' });
    const b = brollRowSignatureInput({ timecode: '0:30', visual_description: 'WIDE SHOT OF CITY' });
    expect(a).toBe(b);
  });
});
