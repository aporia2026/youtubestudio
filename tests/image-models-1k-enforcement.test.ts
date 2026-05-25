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

describe('Atlas Cloud entries (2026-05-25)', () => {
  it('t2i registry exposes gpt-image-2-atlas-t2i above the Kie variant', () => {
    const atlasIdx = IMAGE_MODELS.findIndex((m) => m.value === 'gpt-image-2-atlas-t2i');
    const kieIdx = IMAGE_MODELS.findIndex((m) => m.value === 'gpt-image-2-t2i');
    expect(atlasIdx).toBeGreaterThanOrEqual(0);
    expect(kieIdx).toBeGreaterThanOrEqual(0);
    // Order matters — picker copy makes Atlas the default GPT Image 2
    // variant. Listing it before the Kie sibling means it surfaces
    // first in any UI that renders IMAGE_MODELS in array order.
    expect(atlasIdx).toBeLessThan(kieIdx);
  });

  it('Atlas t2i spec carries the documented model id + native 16:9 size at low quality', () => {
    const spec = getImageModelSpec('gpt-image-2-atlas-t2i');
    expect(spec).toBeDefined();
    expect(spec!.provider).toBe('atlas');
    expect(spec!.atlasModel).toBe('openai/gpt-image-2/text-to-image');
    // 2560×1440 is Atlas's native 16:9 size (2K). Picking this lets the
    // dispatcher skip the post-generation crop AND the Recraft upscale
    // (the source is already at pipeline target). Changing this default
    // would re-introduce the crop overhead OR trigger an unintended
    // upscale, depending on direction.
    expect(spec!.atlasSize).toBe('2560x1440');
    // Low quality is the deliberate cost choice (locked with user
    // 2026-05-25). Bumping to medium/high without context is a real
    // cost regression — see _plans/2026-05-25-atlas-cloud-gpt-image-2.md.
    expect(spec!.atlasQuality).toBe('low');
  });

  it('buildKieImageInput throws when called with the Atlas spec', () => {
    // Defense in depth — the dispatcher routes Atlas specs through the
    // Atlas helper before reaching buildKieImageInput, so this throw
    // only fires if a future change forgets the new branch. Failing
    // loud is better than sending Atlas fields to Kie's createTask.
    expect(() => buildKieImageInput('gpt-image-2-atlas-t2i', 'prompt')).toThrow(
      /non-Kie model 'gpt-image-2-atlas-t2i'/,
    );
  });

  it('i2i registry exposes gpt-image-2-atlas-i2i with provider=atlas and 4-ref cap', () => {
    const spec = I2I_MODELS.find((m) => m.value === 'gpt-image-2-atlas-i2i');
    expect(spec).toBeDefined();
    expect(spec!.provider).toBe('atlas');
    expect(spec!.atlasModel).toBe('openai/gpt-image-2/image-to-image');
    // Conservative cap pending the one-shot probe script. If the probe
    // confirms Atlas accepts more (or less) than 4, BOTH this number
    // and the registry hint copy need updating.
    expect(spec!.maxRefs).toBe(4);
    // 2560×1440 native 16:9 at low quality — same defaults as the t2i
    // sibling. Skips crop + Recraft upscale.
    expect(spec!.atlasSize).toBe('2560x1440');
    expect(spec!.atlasQuality).toBe('low');
  });

  it('Atlas i2i entry has NO refsField (it does not flow through buildKieI2IInput)', () => {
    // buildKieI2IInput keys off `refsField` to pick the field name in
    // the Kie createTask body. Atlas's helper uses a fixed `images`
    // field that doesn't go through that path, so the spec must NOT
    // declare a refsField — otherwise isKieI2ISpec would narrow it as
    // a Kie spec and the dispatcher's Atlas branch would never fire.
    const spec = I2I_MODELS.find((m) => m.value === 'gpt-image-2-atlas-i2i');
    expect(spec!.refsField).toBeUndefined();
  });

  it('buildKieI2IInput throws when called with the Atlas i2i spec', () => {
    expect(() =>
      buildKieI2IInput('gpt-image-2-atlas-i2i', 'prompt', ['https://r2/r1.png']),
    ).toThrow(/non-Kie-i2i model 'gpt-image-2-atlas-i2i'/);
  });
});
