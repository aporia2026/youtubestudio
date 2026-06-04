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
  it('exposes 4 portrait-verified models', () => {
    expect(BASE_T2I_MODELS).toHaveLength(4);
    expect(BASE_T2I_MODELS.map((m) => m.id)).toEqual([
      'atlas-gpt-image-2',
      'kie-gpt-image-2',
      'kie-nano-banana-2',
      'kie-flux-2-pro',
    ]);
  });

  it('default is the cost-optimal Atlas GPT-2 model', () => {
    expect(DEFAULT_BASE_T2I_MODEL_ID).toBe('atlas-gpt-image-2');
    const spec = getBaseT2iModelSpec(DEFAULT_BASE_T2I_MODEL_ID);
    expect(spec.vendor).toBe('atlas');
    expect(spec.costUsd).toBe(0.009);
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
  it('routes Kie GPT-2 with aspect_ratio 9:16 + resolution 1K', async () => {
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
    expect(result.vendorUsed).toBe('kie');
    expect(result.url).toBe('https://r2.test/kie-gpt2.png');
    expect(result.costUsd).toBe(0.05);
    expect(result.providerRequestId).toBe('task-gpt-2');
  });

  it('routes Nano Banana 2 with aspect_ratio 9:16 + output_format png', async () => {
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
    expect(result.modelId).toBe('kie-flux-2-pro');
    expect(result.costUsd).toBe(0.05);
  });

  it('throws when KIE_API_KEY is missing', async () => {
    delete process.env.KIE_API_KEY;
    await expect(
      generateShortsBaseT2I({ prompt: 'x', modelId: 'kie-nano-banana-2' }),
    ).rejects.toThrow(/KIE_API_KEY is not set/);
    expect(mockedCreateKie).not.toHaveBeenCalled();
  });
});
