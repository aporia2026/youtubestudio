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
  it('uses ai_image_prompt as the spine when present (t2v)', () => {
    const out = buildBrollPrompt({
      mode: 'text-to-video',
      visualDescription: 'short fallback',
      aiImagePrompt:
        'A wide cinematic shot of a serene lake at golden hour, soft mist rising off the water, distant mountains, gentle natural light',
    });
    expect(out).toContain('cinematic shot of a serene lake');
    // Cinematic tail is appended only on the t2v path.
    expect(out).toMatch(/Photoreal,? no on-screen text/);
  });

  it('falls back to visual_description when no ai_image_prompt', () => {
    const out = buildBrollPrompt({
      mode: 'text-to-video',
      visualDescription: 'A close-up of a fountain pen scribbling cursive on parchment, ink glistening',
    });
    expect(out).toContain('fountain pen');
    expect(out).toMatch(/no on-screen text/);
  });

  it('drops the photoreal tail on image-to-video and uses motion-only guidance', () => {
    const out = buildBrollPrompt({
      mode: 'image-to-video',
      visualDescription:
        'A stick figure walks up and draws a giant red X across the treasure map with a thick marker',
    });
    expect(out).toContain('stick figure');
    expect(out).not.toMatch(/Photoreal/);
    expect(out).toMatch(/Preserve the existing style/);
    expect(out).toMatch(/Animate the described action/);
  });

  it('appends the style hint verbatim', () => {
    const out = buildBrollPrompt({
      mode: 'text-to-video',
      visualDescription: 'A street vendor selling tacos under neon lights',
      styleHint: 'shot on 35mm film, anamorphic lens, slight grain',
    });
    expect(out).toContain('shot on 35mm film');
    expect(out).toContain('anamorphic lens');
  });

  it('throws when both inputs are empty', () => {
    expect(() =>
      buildBrollPrompt({ mode: 'text-to-video', visualDescription: '', aiImagePrompt: '' }),
    ).toThrow(/no visual_description or ai_image_prompt/);
  });

  it('truncates oversized prompts to maxChars while preserving the tail', () => {
    const huge = 'lorem ipsum dolor sit amet '.repeat(200); // ~5400 chars
    const out = buildBrollPrompt({
      mode: 'text-to-video',
      visualDescription: 'fallback',
      aiImagePrompt: huge,
      maxChars: 600,
    });
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toMatch(/no on-screen text/);
    expect(out).toContain('lorem ipsum');
  });

  it('strips all whitespace runs (newlines, tabs) into single spaces', () => {
    const out = buildBrollPrompt({
      mode: 'text-to-video',
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

  it('exposes image-to-video AND text-to-video families', () => {
    const i2v = BROLL_MODELS.filter((m) => m.kind === 'image-to-video');
    const t2v = BROLL_MODELS.filter((m) => m.kind === 'text-to-video');
    expect(i2v.length).toBeGreaterThan(0);
    expect(t2v.length).toBeGreaterThan(0);
  });

  it('default is an image-to-video model (Kling 2.5 turbo Pro)', () => {
    const def = findBrollModel(DEFAULT_BROLL_MODEL_ID);
    expect(def?.kind).toBe('image-to-video');
  });

  it('marks exactly one model as recommended, and it matches the default', () => {
    const recommended = BROLL_MODELS.filter((m) => m.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]!.id).toBe(DEFAULT_BROLL_MODEL_ID);
  });

  it('every model has 16:9 support and a positive duration', () => {
    for (const m of BROLL_MODELS) {
      expect(m.supportedAspects).toContain('16:9');
      expect(m.durationSeconds).toBeGreaterThan(0);
      expect(m.durationSeconds).toBeLessThanOrEqual(20);
    }
  });

  it('every model can build a valid Kie request body', () => {
    for (const m of BROLL_MODELS) {
      const body = m.buildBody({
        prompt: 'test prompt',
        aspectRatio: '16:9',
        durationSeconds: m.durationSeconds,
        stillImageUrl: m.kind === 'image-to-video' ? 'https://example.com/still.jpg' : undefined,
      });
      // Every Kie body wraps params under either `model` (createTask) or
      // exposes `prompt` directly (runway). Validate the discriminator
      // matches the descriptor's `endpoint` field.
      if (m.endpoint === 'createTask') {
        expect(body.model).toMatch(/.+/);
        expect(body.input).toBeDefined();
      }
    }
  });

  it('image-to-video bodies carry the still image URL', () => {
    for (const m of BROLL_MODELS) {
      if (m.kind !== 'image-to-video') continue;
      const body = m.buildBody({
        prompt: 'test',
        aspectRatio: '16:9',
        durationSeconds: m.durationSeconds,
        stillImageUrl: 'https://example.com/x.jpg',
      });
      const input = body.input as Record<string, unknown>;
      const carries =
        input?.image_url === 'https://example.com/x.jpg' ||
        (Array.isArray(input?.image_urls) &&
          (input.image_urls as string[])[0] === 'https://example.com/x.jpg');
      expect(carries).toBe(true);
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
