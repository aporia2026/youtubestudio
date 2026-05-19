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
    expect(out).toMatch(/Photoreal/);
    expect(out).toMatch(/no on-screen text/i);
  });

  it('falls back to visual_description when no ai_image_prompt', () => {
    const out = buildBrollPrompt({
      mode: 'text-to-video',
      visualDescription: 'A close-up of a fountain pen scribbling cursive on parchment, ink glistening',
    });
    expect(out).toContain('fountain pen');
    expect(out).toMatch(/no on-screen text/i);
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

  it('i2v tail carries the glyph-preservation directive (text, digits, logos)', () => {
    const out = buildBrollPrompt({
      mode: 'image-to-video',
      visualDescription: 'A pixelated 8-bit counter ticking from 06 to 07 above a hero shot of a stopwatch',
    });
    // Repeated, imperative language is the whole point — assert the key
    // tokens are present so a future "small cleanup" doesn't accidentally
    // weaken the prompt that fixes the warping bug.
    expect(out).toMatch(/CRITICAL TEXT PRESERVATION/);
    expect(out).toMatch(/pixel-stable/i);
    expect(out).toMatch(/text/);
    expect(out).toMatch(/digit/i);
    expect(out).toMatch(/letter/i);
    expect(out).toMatch(/logo/i);
    expect(out).toMatch(/number/i);
    expect(out).toMatch(/Counters,? timers,? and numeric readouts stay frozen/);
  });

  it('t2v tail also tells the model to keep any rendered glyphs pixel-stable', () => {
    const out = buildBrollPrompt({
      mode: 'text-to-video',
      visualDescription: 'A wide shot of a New York street with neon storefront signs and license plates',
    });
    expect(out).toMatch(/pixel-stable/i);
    expect(out).toMatch(/never morph, warp/i);
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
      // Cap relaxed to fit the new (longer) preservation-aware tail.
      maxChars: 900,
    });
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out).toMatch(/no on-screen text/i);
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
    const STILL = 'https://example.com/x.jpg';
    for (const m of BROLL_MODELS) {
      if (m.kind !== 'image-to-video') continue;
      const body = m.buildBody({
        prompt: 'test',
        aspectRatio: '16:9',
        durationSeconds: m.durationSeconds,
        stillImageUrl: STILL,
      });
      const input = (body.input as Record<string, unknown> | undefined) ?? {};
      // The wire shape varies by endpoint family:
      //   - createTask models (Kling, Sora, Grok, Seedance) nest the URL
      //     under `input.image_url` / `image_urls` / `first_frame_url` /
      //     `input_urls`.
      //   - Runway (runway-generate) puts `imageUrl` at the top level.
      //   - Veo 3.1 (veo-generate) puts `imageUrls` at the top level.
      const nestedHit =
        input.image_url === STILL ||
        (Array.isArray(input.image_urls) && (input.image_urls as string[])[0] === STILL) ||
        input.first_frame_url === STILL ||
        (Array.isArray(input.input_urls) && (input.input_urls as string[])[0] === STILL);
      const topLevelHit =
        body.imageUrl === STILL ||
        (Array.isArray(body.imageUrls) && (body.imageUrls as string[])[0] === STILL);
      expect(nestedHit || topLevelHit).toBe(true);
    }
  });

  it('rejects unknown model lookups', () => {
    expect(findBrollModel('does-not-exist')).toBeUndefined();
  });

  it('every model is tagged with a family', () => {
    for (const m of BROLL_MODELS) {
      expect(m.family).toBeDefined();
      expect(['kling', 'sora', 'veo', 'runway', 'grok', 'seedance']).toContain(m.family);
    }
  });

  it('Grok Imagine i2v sends image_urls inside input + 720p resolution', () => {
    const m = findBrollModel('grok-imagine-i2v-10s');
    expect(m).toBeDefined();
    const body = m!.buildBody({
      prompt: 'p',
      aspectRatio: '16:9',
      durationSeconds: 10,
      stillImageUrl: 'https://example.com/x.jpg',
    });
    expect(body.model).toBe('grok-imagine/image-to-video');
    const input = body.input as Record<string, unknown>;
    expect(input.image_urls).toEqual(['https://example.com/x.jpg']);
    expect(input.resolution).toBe('720p');
    expect(input.duration).toBe('10');
    expect(input.mode).toBe('normal');
  });

  it('Veo 3.1 Fast i2v uses /veo/generate shape with REFERENCE_2_VIDEO', () => {
    const m = findBrollModel('veo-3-1-fast-i2v');
    expect(m).toBeDefined();
    expect(m!.endpoint).toBe('veo-generate');
    const body = m!.buildBody({
      prompt: 'p',
      aspectRatio: '16:9',
      durationSeconds: 8,
      stillImageUrl: 'https://example.com/x.jpg',
    });
    expect(body.model).toBe('veo3_fast');
    expect(body.generationType).toBe('REFERENCE_2_VIDEO');
    expect(body.imageUrls).toEqual(['https://example.com/x.jpg']);
    // Veo 3.1 puts image at top level, NOT inside `input`.
    expect((body as Record<string, unknown>).input).toBeUndefined();
  });

  it('Veo 3.1 Lite t2v omits imageUrls', () => {
    const m = findBrollModel('veo-3-1-lite-t2v');
    expect(m).toBeDefined();
    const body = m!.buildBody({
      prompt: 'p',
      aspectRatio: '16:9',
      durationSeconds: 8,
    });
    expect(body.model).toBe('veo3_lite');
    expect(body.generationType).toBe('TEXT_2_VIDEO');
    expect(body.imageUrls).toBeUndefined();
  });

  it('Runway i2v puts imageUrl at top level (not aspectRatio)', () => {
    const m = findBrollModel('runway-i2v-5s-720p');
    expect(m).toBeDefined();
    const body = m!.buildBody({
      prompt: 'p',
      aspectRatio: '16:9',
      durationSeconds: 5,
      stillImageUrl: 'https://example.com/x.jpg',
    });
    expect(body.imageUrl).toBe('https://example.com/x.jpg');
    expect(body.duration).toBe(5);
    expect(body.quality).toBe('720p');
    // aspectRatio is ignored when imageUrl is present per Kie docs — we
    // omit it on the i2v shape rather than send a redundant value.
    expect(body.aspectRatio).toBeUndefined();
  });

  it('Runway t2v carries aspectRatio (camelCase) but no imageUrl', () => {
    const m = findBrollModel('runway-t2v-5s-720p');
    const body = m!.buildBody({
      prompt: 'p',
      aspectRatio: '9:16',
      durationSeconds: 5,
    });
    expect(body.aspectRatio).toBe('9:16');
    expect(body.imageUrl).toBeUndefined();
  });

  it('Seedance 2 i2v uses first_frame_url + generate_audio:false', () => {
    const m = findBrollModel('seedance-2-i2v');
    const body = m!.buildBody({
      prompt: 'p',
      aspectRatio: '16:9',
      durationSeconds: 5,
      stillImageUrl: 'https://example.com/x.jpg',
    });
    expect(body.model).toBe('bytedance/seedance-2');
    const input = body.input as Record<string, unknown>;
    expect(input.first_frame_url).toBe('https://example.com/x.jpg');
    expect(input.generate_audio).toBe(false);
    expect(input.resolution).toBe('720p');
  });

  it('Seedance 1.5 Pro snaps duration to the nearest of 4/8/12', () => {
    const m = findBrollModel('seedance-1-5-pro-i2v');
    const at5 = m!.buildBody({
      prompt: 'p',
      aspectRatio: '16:9',
      durationSeconds: 5,
      stillImageUrl: 'https://example.com/x.jpg',
    });
    expect((at5.input as Record<string, unknown>).duration).toBe('4');
    const at10 = m!.buildBody({
      prompt: 'p',
      aspectRatio: '16:9',
      durationSeconds: 10,
      stillImageUrl: 'https://example.com/x.jpg',
    });
    expect((at10.input as Record<string, unknown>).duration).toBe('8');
  });

  it('Seedance 1.5 Pro 720p / 480p variants send the right resolution', () => {
    const args = {
      prompt: 'p',
      aspectRatio: '16:9' as const,
      durationSeconds: 4,
      stillImageUrl: 'https://example.com/x.jpg',
    };
    const at720 = findBrollModel('seedance-1-5-pro-i2v')!.buildBody(args);
    const at480 = findBrollModel('seedance-1-5-pro-480p-i2v')!.buildBody(args);
    expect((at720.input as Record<string, unknown>).resolution).toBe('720p');
    expect((at480.input as Record<string, unknown>).resolution).toBe('480p');
    // generate_audio stays false on both — the cheap tier per kie.ai pricing.
    expect((at720.input as Record<string, unknown>).generate_audio).toBe(false);
    expect((at480.input as Record<string, unknown>).generate_audio).toBe(false);
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
