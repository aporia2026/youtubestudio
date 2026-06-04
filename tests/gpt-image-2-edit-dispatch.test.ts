/**
 * Tests for the `generateGptImage2Edit` dispatcher.
 *
 * Covers the primary-success / primary-fail-fallback-success /
 * both-fail paths plus cost attribution for each vendor. See
 * _plans/2026-05-29-gpt-image-2-edit-provider-fallback.md.
 *
 * The dispatcher's two vendor branches are stubbed via vi.mock — we
 * don't exercise live Atlas / Kie traffic here. The point is to
 * verify the fallback logic + the cost / vendor attribution; the
 * actual vendor calls are covered by the existing
 * `atlas-cloud-images.test.ts` and Kie integration tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the upstream vendor modules BEFORE importing the dispatcher.
vi.mock('@/lib/atlas-cloud-images', () => ({
  generateAtlasEdit: vi.fn(),
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
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { generateGptImage2Edit, ATLAS_EDIT_COST_USD, KIE_I2I_COST_USD } from '@/lib/gpt-image-2-edit';
import { generateAtlasEdit } from '@/lib/atlas-cloud-images';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
import { cropToAspectAndUpload } from '@/lib/image-gen-dispatch';

const mockedCropToAspect = vi.mocked(cropToAspectAndUpload);

describe('generateGptImage2Edit dispatcher', () => {
  beforeEach(() => {
    process.env.KIE_API_KEY = 'test-kie-key';
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.KIE_API_KEY;
  });

  it('primary=atlas success: returns Atlas-cropped url at Atlas cost, no fallback', async () => {
    vi.mocked(generateAtlasEdit).mockResolvedValue({
      url: 'https://atlas.example/raw-1536x1024.png',
      predictionId: 'atlas-pred-123',
      predictTimeMs: 1234,
    });

    const result = await generateGptImage2Edit({
      prompt: 'raise the right eyebrow',
      sourceImageUrl: 'https://r2.example/base.png',
      primary: 'atlas',
    });

    expect(result.vendorUsed).toBe('atlas');
    expect(result.fallbackUsed).toBe(false);
    expect(result.costUsd).toBe(ATLAS_EDIT_COST_USD);
    expect(result.url).toBe('https://atlas.example/raw-1536x1024.png#cropped-16x9');
    expect(result.providerRequestId).toBe('atlas-pred-123');
    expect(generateAtlasEdit).toHaveBeenCalledTimes(1);
    expect(createKieTask).not.toHaveBeenCalled();
  });

  it('primary=kie success: returns Kie url at Kie cost, no fallback, no crop', async () => {
    vi.mocked(createKieTask).mockResolvedValue('kie-task-456');
    vi.mocked(pollKieResult).mockResolvedValue('https://kie.example/i2i-16x9.png');

    const result = await generateGptImage2Edit({
      prompt: 'change pose',
      sourceImageUrl: 'https://r2.example/base.png',
      primary: 'kie',
    });

    expect(result.vendorUsed).toBe('kie');
    expect(result.fallbackUsed).toBe(false);
    expect(result.costUsd).toBe(KIE_I2I_COST_USD);
    // Kie URL passes through without crop suffix.
    expect(result.url).toBe('https://kie.example/i2i-16x9.png');
    expect(result.providerRequestId).toBe('kie-task-456');
    expect(generateAtlasEdit).not.toHaveBeenCalled();
  });

  it('Atlas primary fails → Kie fallback succeeds: cost = Kie, fallbackUsed=true', async () => {
    vi.mocked(generateAtlasEdit).mockRejectedValue(
      new Error('[atlas-images] error 402: insufficient balance'),
    );
    vi.mocked(createKieTask).mockResolvedValue('kie-task-fallback');
    vi.mocked(pollKieResult).mockResolvedValue('https://kie.example/fallback.png');

    const result = await generateGptImage2Edit({
      prompt: 'fallback path',
      sourceImageUrl: 'https://r2.example/base.png',
      primary: 'atlas',
    });

    expect(result.vendorUsed).toBe('kie');
    expect(result.fallbackUsed).toBe(true);
    expect(result.costUsd).toBe(KIE_I2I_COST_USD);
    expect(result.url).toBe('https://kie.example/fallback.png');
    expect(generateAtlasEdit).toHaveBeenCalledTimes(1);
    expect(createKieTask).toHaveBeenCalledTimes(1);
  });

  it('Kie primary fails → Atlas fallback succeeds: cost = Atlas, fallbackUsed=true', async () => {
    vi.mocked(createKieTask).mockRejectedValue(new Error('Kie.ai error 401'));
    vi.mocked(generateAtlasEdit).mockResolvedValue({
      url: 'https://atlas.example/fallback-3x2.png',
      predictionId: 'atlas-fallback',
      predictTimeMs: 999,
    });

    const result = await generateGptImage2Edit({
      prompt: 'kie down',
      sourceImageUrl: 'https://r2.example/base.png',
      primary: 'kie',
    });

    expect(result.vendorUsed).toBe('atlas');
    expect(result.fallbackUsed).toBe(true);
    expect(result.costUsd).toBe(ATLAS_EDIT_COST_USD);
    expect(result.url).toBe('https://atlas.example/fallback-3x2.png#cropped-16x9');
  });

  it('both vendors fail: throws with both error messages', async () => {
    vi.mocked(generateAtlasEdit).mockRejectedValue(new Error('Atlas explodes'));
    vi.mocked(createKieTask).mockRejectedValue(new Error('Kie also explodes'));

    await expect(
      generateGptImage2Edit({
        prompt: 'doomed',
        sourceImageUrl: 'https://r2.example/base.png',
        primary: 'atlas',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(/Atlas explodes[\s\S]*Kie also explodes/),
      }),
    );
  });

  it('Kie primary requires KIE_API_KEY env var', async () => {
    delete process.env.KIE_API_KEY;
    // Atlas as the fallback also fails so we surface the Kie error
    // first to confirm the env-var check fires before any network call.
    vi.mocked(generateAtlasEdit).mockRejectedValue(new Error('atlas-also-down'));

    await expect(
      generateGptImage2Edit({
        prompt: 'no key',
        sourceImageUrl: 'https://r2.example/base.png',
        primary: 'kie',
      }),
    ).rejects.toThrow(/KIE_API_KEY is not configured/);
    // Kie's create was never called because the env-var check
    // short-circuited before we hit the network.
    expect(createKieTask).not.toHaveBeenCalled();
  });

  it('Atlas crop applies to fallback when Kie primary fails', async () => {
    vi.mocked(createKieTask).mockRejectedValue(new Error('kie down'));
    vi.mocked(generateAtlasEdit).mockResolvedValue({
      url: 'https://atlas.example/raw.png',
      predictionId: 'atlas-id',
      predictTimeMs: 100,
    });

    const result = await generateGptImage2Edit({
      prompt: 'p',
      sourceImageUrl: 'https://r2.example/src.png',
      primary: 'kie',
    });

    expect(result.url).toBe('https://atlas.example/raw.png#cropped-16x9');
  });

  // ─── extraImageUrls (2026-06-02 fix B') ──────────────────────────────
  // The motion_collage dual-input chain passes panel 0 as a composition
  // anchor alongside the previous-panel motion source. Both vendors
  // accept multi-input arrays; the dispatcher concatenates
  // [sourceImageUrl, ...extraImageUrls] in order so the prompt can refer
  // to "first input" / "second input" deterministically.
  describe('extraImageUrls passthrough', () => {
    it('Atlas: appends extra URLs after the source in the images array', async () => {
      vi.mocked(generateAtlasEdit).mockResolvedValue({
        url: 'https://atlas.example/dual.png',
        predictionId: 'atlas-dual',
        predictTimeMs: 200,
      });

      await generateGptImage2Edit({
        prompt: 'advance the moving element',
        sourceImageUrl: 'https://r2.example/prev.png',
        extraImageUrls: ['https://r2.example/panel0.png'],
        primary: 'atlas',
      });

      expect(generateAtlasEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          images: ['https://r2.example/prev.png', 'https://r2.example/panel0.png'],
        }),
      );
    });

    it('Kie: appends extra URLs after the source in input_urls', async () => {
      vi.mocked(createKieTask).mockResolvedValue('kie-dual');
      vi.mocked(pollKieResult).mockResolvedValue('https://kie.example/dual.png');

      await generateGptImage2Edit({
        prompt: 'advance the moving element',
        sourceImageUrl: 'https://r2.example/prev.png',
        extraImageUrls: ['https://r2.example/panel0.png', 'https://r2.example/ref2.png'],
        primary: 'kie',
      });

      expect(createKieTask).toHaveBeenCalledWith(
        'test-kie-key',
        'gpt-image-2-image-to-image',
        expect.objectContaining({
          input_urls: [
            'https://r2.example/prev.png',
            'https://r2.example/panel0.png',
            'https://r2.example/ref2.png',
          ],
        }),
      );
    });

    it('omitting extraImageUrls keeps the legacy single-input shape', async () => {
      vi.mocked(generateAtlasEdit).mockResolvedValue({
        url: 'https://atlas.example/single.png',
        predictionId: 'atlas-single',
        predictTimeMs: 100,
      });

      await generateGptImage2Edit({
        prompt: 'p',
        sourceImageUrl: 'https://r2.example/only.png',
        primary: 'atlas',
      });

      expect(generateAtlasEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          images: ['https://r2.example/only.png'],
        }),
      );
    });
  });

  // ─── aspectRatio (2026-06-04 — Shorts 9:16 fix) ──────────────────────
  // The long-form pipeline keeps 16:9 as the default. Shorts callers
  // pass aspectRatio: '9:16' so Atlas asks for a PORTRAIT size and the
  // crop step finishes the job. Without this, Shorts variants come back
  // as 16:9 landscape and the renderer's object-fit: cover trims ~63%.
  describe('aspectRatio', () => {
    it('defaults to 16:9 → Atlas requests 1536×1024 landscape', async () => {
      vi.mocked(generateAtlasEdit).mockResolvedValue({
        url: 'https://atlas.example/landscape.png',
        predictionId: 'atlas-default',
      });

      await generateGptImage2Edit({
        prompt: 'p',
        sourceImageUrl: 'https://r2.example/src.png',
        primary: 'atlas',
      });

      expect(generateAtlasEdit).toHaveBeenCalledWith(
        expect.objectContaining({ size: '1536x1024' }),
      );
      // Crop helper called with 16:9 target.
      expect(mockedCropToAspect).toHaveBeenCalledWith(
        'https://atlas.example/landscape.png',
        expect.any(String),
        16,
        9,
      );
    });

    it("aspectRatio='9:16' → Atlas requests 1024×1536 portrait + crops to 9:16", async () => {
      vi.mocked(generateAtlasEdit).mockResolvedValue({
        url: 'https://atlas.example/portrait.png',
        predictionId: 'atlas-shorts',
      });

      const result = await generateGptImage2Edit({
        prompt: 'shorts variant scene',
        sourceImageUrl: 'https://r2.example/short-base.png',
        primary: 'atlas',
        aspectRatio: '9:16',
      });

      // Atlas asked for the PORTRAIT size, not the default landscape.
      expect(generateAtlasEdit).toHaveBeenCalledWith(
        expect.objectContaining({ size: '1024x1536' }),
      );
      // Crop helper called with 9:16 target.
      expect(mockedCropToAspect).toHaveBeenCalledWith(
        'https://atlas.example/portrait.png',
        expect.any(String),
        9,
        16,
      );
      expect(result.url).toBe('https://atlas.example/portrait.png#cropped-9x16');
    });

    it("aspectRatio='9:16' → Kie i2i requests aspect_ratio='9:16'", async () => {
      vi.mocked(createKieTask).mockResolvedValue('kie-shorts');
      vi.mocked(pollKieResult).mockResolvedValue('https://kie.example/9x16.png');

      await generateGptImage2Edit({
        prompt: 'shorts variant scene',
        sourceImageUrl: 'https://r2.example/short-base.png',
        primary: 'kie',
        aspectRatio: '9:16',
      });

      expect(createKieTask).toHaveBeenCalledWith(
        'test-kie-key',
        'gpt-image-2-image-to-image',
        expect.objectContaining({ aspect_ratio: '9:16', resolution: '1K' }),
      );
    });

    it("aspectRatio default → Kie i2i still requests aspect_ratio='16:9'", async () => {
      vi.mocked(createKieTask).mockResolvedValue('kie-default');
      vi.mocked(pollKieResult).mockResolvedValue('https://kie.example/16x9.png');

      await generateGptImage2Edit({
        prompt: 'long-form variant',
        sourceImageUrl: 'https://r2.example/base.png',
        primary: 'kie',
      });

      expect(createKieTask).toHaveBeenCalledWith(
        'test-kie-key',
        'gpt-image-2-image-to-image',
        expect.objectContaining({ aspect_ratio: '16:9' }),
      );
    });
  });
});
