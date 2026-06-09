import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/atlas-cloud-images', () => ({
  generateAtlasT2I: vi.fn(),
}));
vi.mock('@/lib/kie-poll', () => ({
  createKieTask: vi.fn(),
  pollKieResult: vi.fn(),
}));
vi.mock('@/lib/image-gen-dispatch', () => ({
  cropToAspectAndUpload: vi.fn(
    async (srcUrl: string, _prefix: string, aspectW: number, aspectH: number) =>
      `${srcUrl}#cropped-${aspectW}x${aspectH}`,
  ),
}));

import {
  BASE_T2I_MODELS,
  DEFAULT_BASE_T2I_MODEL_ID,
  generateShortsBaseT2I,
  getBaseT2iModelSpec,
  resolveBaseT2iModelId,
} from '@/lib/shorts-base-t2i';
import { generateAtlasT2I } from '@/lib/atlas-cloud-images';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
import { cropToAspectAndUpload } from '@/lib/image-gen-dispatch';

const mockedAtlas = vi.mocked(generateAtlasT2I);
const mockedCreateKie = vi.mocked(createKieTask);
const mockedPollKie = vi.mocked(pollKieResult);
const mockedCrop = vi.mocked(cropToAspectAndUpload);

beforeEach(() => {
  mockedAtlas.mockReset();
  mockedCreateKie.mockReset();
  mockedPollKie.mockReset();
  mockedCrop.mockClear();
  process.env.KIE_API_KEY = 'test-kie-key';
});

describe('registry', () => {
  it('exposes the 9 cloud T2I models grouped by family', () => {
    // Order matters for the picker UX: GPT Image 2 (Atlas + Kie),
    // Nano Banana 2, Flux 2 family (Pro then Flex), Ideogram v3
    // (Quality then Turbo), Qwen, Seedream. Expanded 2026-06-10
    // per §8 of the bulk-shorts robustness plan. Grok Imagine was
    // included briefly but removed in QA review (no documented Kie
    // T2I endpoint → guaranteed 422). See shorts-base-t2i-types.ts
    // for the rationale comment.
    expect(BASE_T2I_MODELS).toHaveLength(9);
    expect(BASE_T2I_MODELS.map((m) => m.id)).toEqual([
      'atlas-gpt-image-2',
      'kie-gpt-image-2',
      'kie-nano-banana-2',
      'kie-flux-2-pro',
      'kie-flux-2-flex',
      'kie-ideogram-v3-quality',
      'kie-ideogram-v3-turbo',
      'kie-qwen-image',
      'kie-seedream-v4',
    ]);
  });

  it('every registry entry has a positive cost + non-empty hint + matching union id', () => {
    for (const m of BASE_T2I_MODELS) {
      expect(m.costUsd).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.modelSlug.length).toBeGreaterThan(0);
      expect(['atlas', 'kie']).toContain(m.vendor);
      // Spec lookup must round-trip through the resolver.
      expect(getBaseT2iModelSpec(m.id)).toBe(m);
    }
  });

  it('default is Kie GPT Image 2 (user-confirmed 2026-06-09 over the cheaper Atlas route due to Atlas reliability issues)', () => {
    expect(DEFAULT_BASE_T2I_MODEL_ID).toBe('kie-gpt-image-2');
    const spec = getBaseT2iModelSpec(DEFAULT_BASE_T2I_MODEL_ID);
    expect(spec.vendor).toBe('kie');
    expect(spec.costUsd).toBe(0.05);
  });

  it('resolves arbitrary strings to a valid id (defensive)', () => {
    expect(resolveBaseT2iModelId('kie-flux-2-pro')).toBe('kie-flux-2-pro');
    expect(resolveBaseT2iModelId('made-up-model')).toBe(DEFAULT_BASE_T2I_MODEL_ID);
    expect(resolveBaseT2iModelId(null)).toBe(DEFAULT_BASE_T2I_MODEL_ID);
    expect(resolveBaseT2iModelId(undefined)).toBe(DEFAULT_BASE_T2I_MODEL_ID);
    expect(resolveBaseT2iModelId(42)).toBe(DEFAULT_BASE_T2I_MODEL_ID);
  });
});

describe('generateShortsBaseT2I — Atlas branch', () => {
  it('routes to generateAtlasT2I with portrait size + high quality, then crops to 9:16', async () => {
    mockedAtlas.mockResolvedValue({
      url: 'https://r2.test/atlas.png',
      predictionId: 'pred-1',
      predictTimeMs: 32000,
    });
    const result = await generateShortsBaseT2I({
      prompt: 'A character on white canvas',
      modelId: 'atlas-gpt-image-2',
    });
    expect(mockedAtlas).toHaveBeenCalledOnce();
    expect(mockedAtlas.mock.calls[0][0]).toMatchObject({
      prompt: 'A character on white canvas',
      // Atlas's enum has no native 9:16; we request the closest portrait
      // (1024×1536) and crop down.
      size: '1024x1536',
      quality: 'high',
    });
    // The Atlas 2:3 output gets center-cropped to 9:16 (864×1536) before
    // it's returned to the caller — see _plans/2026-06-04-shorts-images-must-be-9-16.md.
    expect(mockedCrop).toHaveBeenCalledWith(
      'https://r2.test/atlas.png',
      expect.any(String),
      9,
      16,
    );
    expect(mockedCreateKie).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      // URL points at the cropped intermediate, not the raw Atlas URL.
      url: 'https://r2.test/atlas.png#cropped-9x16',
      modelId: 'atlas-gpt-image-2',
      vendorUsed: 'atlas',
      costUsd: 0.009,
      providerRequestId: 'pred-1',
    });
  });
});

describe('generateShortsBaseT2I — Kie branches', () => {
  it('routes Kie GPT-2 with aspect_ratio 9:16 + resolution 1K, then crops', async () => {
    mockedCreateKie.mockResolvedValue('task-gpt-2');
    mockedPollKie.mockResolvedValue('https://r2.test/kie-gpt2.png');
    const result = await generateShortsBaseT2I({
      prompt: 'A character',
      modelId: 'kie-gpt-image-2',
    });
    expect(mockedAtlas).not.toHaveBeenCalled();
    expect(mockedCreateKie).toHaveBeenCalledWith(
      'test-kie-key',
      'gpt-image-2-text-to-image',
      expect.objectContaining({
        prompt: 'A character',
        aspect_ratio: '9:16',
        resolution: '1K',
      }),
    );
    expect(mockedCrop).toHaveBeenCalledWith('https://r2.test/kie-gpt2.png', expect.any(String), 9, 16);
    expect(result.vendorUsed).toBe('kie');
    expect(result.url).toBe('https://r2.test/kie-gpt2.png#cropped-9x16');
    expect(result.costUsd).toBe(0.05);
    expect(result.providerRequestId).toBe('task-gpt-2');
  });

  it('routes Nano Banana 2 with aspect_ratio 9:16 + output_format png, then crops', async () => {
    mockedCreateKie.mockResolvedValue('task-nano');
    mockedPollKie.mockResolvedValue('https://r2.test/nano.png');
    const result = await generateShortsBaseT2I({
      prompt: 'A character',
      modelId: 'kie-nano-banana-2',
    });
    expect(mockedCreateKie).toHaveBeenCalledWith(
      'test-kie-key',
      'nano-banana-2',
      expect.objectContaining({
        prompt: 'A character',
        aspect_ratio: '9:16',
        resolution: '1K',
        output_format: 'png',
      }),
    );
    expect(result.url).toBe('https://r2.test/nano.png#cropped-9x16');
    expect(result.modelId).toBe('kie-nano-banana-2');
    expect(result.costUsd).toBe(0.04);
  });

  it('routes Flux 2 Pro with aspect_ratio 9:16 + resolution 1K (required field)', async () => {
    mockedCreateKie.mockResolvedValue('task-flux');
    mockedPollKie.mockResolvedValue('https://r2.test/flux.png');
    const result = await generateShortsBaseT2I({
      prompt: 'A character',
      modelId: 'kie-flux-2-pro',
    });
    expect(mockedCreateKie).toHaveBeenCalledWith(
      'test-kie-key',
      'flux-2/pro-text-to-image',
      expect.objectContaining({
        prompt: 'A character',
        aspect_ratio: '9:16',
        resolution: '1K',
      }),
    );
    expect(result.url).toBe('https://r2.test/flux.png#cropped-9x16');
    expect(result.modelId).toBe('kie-flux-2-pro');
    expect(result.costUsd).toBe(0.05);
  });

  it('routes Flux 2 Flex with same input shape as Pro, different slug', async () => {
    mockedCreateKie.mockResolvedValue('task-flex');
    mockedPollKie.mockResolvedValue('https://r2.test/flex.png');
    const result = await generateShortsBaseT2I({
      prompt: 'A character',
      modelId: 'kie-flux-2-flex',
    });
    expect(mockedCreateKie).toHaveBeenCalledWith(
      'test-kie-key',
      'flux-2/flex-text-to-image',
      expect.objectContaining({ aspect_ratio: '9:16', resolution: '1K' }),
    );
    expect(result.modelId).toBe('kie-flux-2-flex');
    expect(result.costUsd).toBe(0.025);
  });

  it('routes Ideogram v3 Quality with image_size portrait_16_9 + rendering_speed QUALITY', async () => {
    mockedCreateKie.mockResolvedValue('task-ideo-q');
    mockedPollKie.mockResolvedValue('https://r2.test/ideo-q.png');
    const result = await generateShortsBaseT2I({
      prompt: 'A character',
      modelId: 'kie-ideogram-v3-quality',
    });
    expect(mockedCreateKie).toHaveBeenCalledWith(
      'test-kie-key',
      'ideogram/v3-text-to-image',
      expect.objectContaining({
        image_size: 'portrait_16_9',
        rendering_speed: 'QUALITY',
        style: 'AUTO',
        expand_prompt: true,
      }),
    );
    expect(result.modelId).toBe('kie-ideogram-v3-quality');
    expect(result.costUsd).toBe(0.05);
  });

  it('routes Ideogram v3 Turbo with same slug + rendering_speed TURBO', async () => {
    mockedCreateKie.mockResolvedValue('task-ideo-t');
    mockedPollKie.mockResolvedValue('https://r2.test/ideo-t.png');
    const result = await generateShortsBaseT2I({
      prompt: 'A character',
      modelId: 'kie-ideogram-v3-turbo',
    });
    expect(mockedCreateKie).toHaveBeenCalledWith(
      'test-kie-key',
      'ideogram/v3-text-to-image',
      expect.objectContaining({
        image_size: 'portrait_16_9',
        rendering_speed: 'TURBO',
      }),
    );
    expect(result.modelId).toBe('kie-ideogram-v3-turbo');
    expect(result.costUsd).toBe(0.0175);
  });

  it('routes Qwen with image_size portrait_16_9 + png output', async () => {
    mockedCreateKie.mockResolvedValue('task-qwen');
    mockedPollKie.mockResolvedValue('https://r2.test/qwen.png');
    const result = await generateShortsBaseT2I({
      prompt: 'A character',
      modelId: 'kie-qwen-image',
    });
    expect(mockedCreateKie).toHaveBeenCalledWith(
      'test-kie-key',
      'qwen/text-to-image',
      expect.objectContaining({
        image_size: 'portrait_16_9',
        output_format: 'png',
      }),
    );
    expect(result.modelId).toBe('kie-qwen-image');
  });

  it('routes Seedream v4 with image_size + image_resolution + max_images', async () => {
    mockedCreateKie.mockResolvedValue('task-seed');
    mockedPollKie.mockResolvedValue('https://r2.test/seed.png');
    const result = await generateShortsBaseT2I({
      prompt: 'A character',
      modelId: 'kie-seedream-v4',
    });
    expect(mockedCreateKie).toHaveBeenCalledWith(
      'test-kie-key',
      'bytedance/seedream-v4-text-to-image',
      expect.objectContaining({
        image_size: 'portrait_16_9',
        image_resolution: '1K',
        max_images: 1,
      }),
    );
    expect(result.modelId).toBe('kie-seedream-v4');
  });

  it('throws when KIE_API_KEY is missing', async () => {
    delete process.env.KIE_API_KEY;
    await expect(
      generateShortsBaseT2I({ prompt: 'x', modelId: 'kie-nano-banana-2' }),
    ).rejects.toThrow(/KIE_API_KEY is not set/);
    expect(mockedCreateKie).not.toHaveBeenCalled();
  });
});
