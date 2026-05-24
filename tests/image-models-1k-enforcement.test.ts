import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_MODELS,
  buildKieImageInput,
  getImageModelSpec,
  DEFAULT_IMAGE_MODEL,
} from '@/lib/image-models';
import {
  I2I_MODELS,
  I2I_MODEL_VALUES,
  buildKieI2IInput,
  getI2IModelSpec,
  DEFAULT_CLOUD_I2I_MODEL,
} from '@/lib/image-models-i2i';

// Every cloud generation in this codebase flows through the system-wide
// auto-upscale (Recraft Crisp Upscale, ~4×, $0.0025/image). Pinning every
// model to 1K at the source is the cost-discipline policy that pairs with
// that upscale step. These tests prove the policy holds across the t2i +
// i2i registries.

describe('1K policy — registry state', () => {
  it('every Kie t2i spec that sets a resolution sets it to 1K', () => {
    for (const spec of IMAGE_MODELS) {
      if (spec.provider !== 'kie') continue;
      // The t2i registry doesn't carry `extraInput` — the resolution is
      // applied per-model inside buildKieImageInput. We exercise that
      // branch by actually calling the builder for each spec and
      // inspecting the resulting input.
      const input = buildKieImageInput(spec.value, 'placeholder prompt');
      if (input.resolution !== undefined) {
        expect(input.resolution, `model ${spec.value} (kieModel ${spec.kieModel})`).toBe('1K');
      }
    }
  });

  it('every Kie i2i spec that sets a resolution in extraInput sets it to 1K', () => {
    for (const spec of I2I_MODELS) {
      if (spec.provider !== 'kie') continue;
      const res = spec.extraInput?.resolution;
      if (res !== undefined) {
        expect(res, `i2i model ${spec.value}`).toBe('1K');
      }
    }
  });

  it('buildKieI2IInput output never carries a non-1K resolution for any registry spec', () => {
    for (const spec of I2I_MODELS) {
      if (spec.provider !== 'kie') continue;
      const refs = ['https://example.com/r1.png', 'https://example.com/r2.png'];
      const input = buildKieI2IInput(spec.value, 'placeholder', refs);
      if (input.resolution !== undefined) {
        expect(input.resolution, `i2i model ${spec.value}`).toBe('1K');
      }
    }
  });
});

describe('NanoBanana 2 swap', () => {
  it('t2i "nano-banana" value resolves to the v2 kieModel string', () => {
    const spec = getImageModelSpec('nano-banana');
    expect(spec).toBeDefined();
    expect(spec!.kieModel).toBe('nano-banana-2');
    expect(spec!.label).toContain('NanoBanana 2');
  });

  it('NanoBanana 2 t2i input shape uses aspect_ratio + resolution (not image_size)', () => {
    const input = buildKieImageInput('nano-banana', 'prompt');
    expect(input.aspect_ratio).toBe('16:9');
    expect(input.resolution).toBe('1K');
    // v1 used `image_size`; v2 uses `aspect_ratio`. Make sure we didn't
    // accidentally leave the old field name in place.
    expect(input.image_size).toBeUndefined();
    // v2 doesn't accept nsfw_checker — Gemini handles content policy
    // server-side. Sending it can 422 the request.
    expect(input.nsfw_checker).toBeUndefined();
  });

  it('i2i registry exposes nano-banana-2-i2i with 14 refs', () => {
    const spec = I2I_MODELS.find((m) => m.value === 'nano-banana-2-i2i');
    expect(spec).toBeDefined();
    expect(spec!.kieModel).toBe('nano-banana-2');
    expect(spec!.maxRefs).toBe(14);
    expect(spec!.refsField).toBe('image_input');
  });

  it('DEFAULT_CLOUD_I2I_MODEL points to NanoBanana 2 i2i', () => {
    expect(DEFAULT_CLOUD_I2I_MODEL).toBe('nano-banana-2-i2i');
  });

  it('I2I_MODEL_VALUES no longer contains the retired nano-banana-pro-i2i id', () => {
    expect(I2I_MODEL_VALUES).not.toContain('nano-banana-pro-i2i');
  });

  it('no I2I spec still points to the retired nano-banana-pro kieModel', () => {
    for (const spec of I2I_MODELS) {
      expect(spec.kieModel).not.toBe('nano-banana-pro');
    }
  });
});

describe('getI2IModelSpec read-time fallback', () => {
  it('returns the spec directly when the id is known', () => {
    const spec = getI2IModelSpec(DEFAULT_CLOUD_I2I_MODEL);
    expect(spec).toBeDefined();
    expect(spec!.value).toBe(DEFAULT_CLOUD_I2I_MODEL);
  });

  it('falls back to the default spec when the id is unknown (retired model)', () => {
    // Silence the warn the fallback emits — the warn is intentional in
    // production logs but not in test output.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spec = getI2IModelSpec('nano-banana-pro-i2i');
    expect(spec).toBeDefined();
    expect(spec!.value).toBe(DEFAULT_CLOUD_I2I_MODEL);
    expect(spy).toHaveBeenCalledWith(
      '[i2i registry] unknown model → falling back to default',
      expect.objectContaining({
        requested: 'nano-banana-pro-i2i',
        fallback: DEFAULT_CLOUD_I2I_MODEL,
      }),
    );
    spy.mockRestore();
  });

  it('falls back for empty string + arbitrary garbage', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getI2IModelSpec('')!.value).toBe(DEFAULT_CLOUD_I2I_MODEL);
    expect(getI2IModelSpec('xxx-not-a-real-model')!.value).toBe(DEFAULT_CLOUD_I2I_MODEL);
    spy.mockRestore();
  });
});

describe('DEFAULT_IMAGE_MODEL still resolves', () => {
  it('default t2i id resolves to a valid spec', () => {
    const spec = getImageModelSpec(DEFAULT_IMAGE_MODEL);
    expect(spec).toBeDefined();
    expect(spec!.value).toBe(DEFAULT_IMAGE_MODEL);
  });
});
