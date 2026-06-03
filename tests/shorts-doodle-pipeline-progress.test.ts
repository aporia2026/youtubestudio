import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock every external dependency the pipeline reaches. The test only
// cares about the orchestration order + the onProgress contract.
vi.mock('@/lib/atlas-cloud-images', () => ({
  generateAtlasT2I: vi.fn(),
}));
vi.mock('@/lib/gpt-image-2-edit', () => ({
  generateGptImage2Edit: vi.fn(),
}));
vi.mock('@/lib/ai', () => ({
  generateText: vi.fn(),
}));
vi.mock('@/lib/model-defaults', () => ({
  getEffectiveModelId: vi.fn(async () => 'mock-model'),
}));
vi.mock('@/lib/production-doc-styles', () => ({
  getBuiltInStyle: vi.fn(() => ({
    ai_image_suffix: 'mock doodle style suffix',
  })),
}));

import { generateDoodleAssets } from '@/lib/shorts-doodle-asset-pipeline';
import { generateAtlasT2I } from '@/lib/atlas-cloud-images';
import { generateGptImage2Edit } from '@/lib/gpt-image-2-edit';
import { generateText } from '@/lib/ai';
import type { GenerationProgressState } from '@/lib/shorts-types';

const mockedT2I = vi.mocked(generateAtlasT2I);
const mockedEdit = vi.mocked(generateGptImage2Edit);
const mockedGenerateText = vi.mocked(generateText);

/** Build a minimal planner response that parses cleanly. The pipeline
 *  routes raw output through `parseDoodleVariantResult` which extracts
 *  the JSON block from arbitrary surrounding prose. */
function plannerResponse(variantCount: number): string {
  const variants = Array.from({ length: variantCount }, (_, i) => ({
    caption_chunk_start_index: i,
    edit_prompt: `Variant ${i} edit prompt with enough characters to pass`,
  }));
  return JSON.stringify({
    base_prompt: 'A character on a white canvas, full-body composition with negative space.',
    variants,
  });
}

beforeEach(() => {
  mockedT2I.mockReset();
  mockedEdit.mockReset();
  mockedGenerateText.mockReset();
});

describe('generateDoodleAssets — onProgress contract', () => {
  it('fires planning → base → variant(1/N) → variant(2/N) → variant(N/N) in order', async () => {
    mockedGenerateText.mockResolvedValue(plannerResponse(3));
    mockedT2I.mockResolvedValue({
      url: 'https://r2.test/base.png',
      predictionId: 'p-1',
    });
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/v.png',
      vendorUsed: 'atlas',
      fallbackUsed: false,
      costUsd: 0.011,
      durationMs: 100,
      providerRequestId: 'edit-1',
    });

    const events: GenerationProgressState[] = [];
    await generateDoodleAssets({
      workspaceId: 'ws-1',
      projectId: null,
      shortId: 'short-1',
      shortScript: 'A test script.',
      niche: 'general',
      captions: [
        { text: 'one', start_ms: 0, end_ms: 1000 },
        { text: 'two', start_ms: 1000, end_ms: 2000 },
        { text: 'three', start_ms: 2000, end_ms: 3000 },
      ],
      maxVariants: 3,
      onProgress: (state) => {
        events.push(state);
      },
    });

    const phases = events.map((e) => e.phase);
    expect(phases).toEqual(['planning', 'base', 'variant', 'variant', 'variant']);

    // Variant events carry current/total — the strip uses these for the
    // sub-progress bar. Check they're correct and monotonic.
    const variantEvents = events.filter((e) => e.phase === 'variant');
    expect(variantEvents.map((e) => e.current)).toEqual([1, 2, 3]);
    expect(variantEvents.every((e) => e.total === 3)).toBe(true);

    // Every event tags the style_id so the strip can title itself.
    expect(events.every((e) => e.style_id === 'doodle_explainer_2_short')).toBe(true);

    // Every event has a human-readable label.
    expect(events.every((e) => typeof e.label === 'string' && e.label.length > 0)).toBe(true);
  });

  it('still fires base event when planner returns zero variants (caption count = 0 edge)', async () => {
    mockedGenerateText.mockResolvedValue(plannerResponse(1));
    mockedT2I.mockResolvedValue({ url: 'https://r2.test/base.png', predictionId: 'p-2' });
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/v.png',
      vendorUsed: 'atlas',
      fallbackUsed: false,
      costUsd: 0.011,
      durationMs: 0,
      providerRequestId: 'e',
    });

    const events: GenerationProgressState[] = [];
    await generateDoodleAssets({
      workspaceId: 'ws-1',
      projectId: null,
      shortId: 'short-1',
      shortScript: 'A.',
      niche: 'general',
      captions: [{ text: 'a', start_ms: 0, end_ms: 500 }],
      maxVariants: 1,
      onProgress: (state) => {
        events.push(state);
      },
    });

    expect(events.map((e) => e.phase)).toEqual(['planning', 'base', 'variant']);
  });

  it('does not crash the pipeline when onProgress throws', async () => {
    mockedGenerateText.mockResolvedValue(plannerResponse(2));
    mockedT2I.mockResolvedValue({ url: 'https://r2.test/base.png', predictionId: 'p-3' });
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/v.png',
      vendorUsed: 'atlas',
      fallbackUsed: false,
      costUsd: 0.011,
      durationMs: 0,
      providerRequestId: 'e',
    });

    // safeProgress wraps the callback; any error inside should be caught
    // and logged, not killing the pipeline. Without this guarantee a
    // flaky DB write could cost us a $0.07 run.
    const result = await generateDoodleAssets({
      workspaceId: 'ws-1',
      projectId: null,
      shortId: 'short-1',
      shortScript: 'A test script.',
      niche: 'general',
      captions: [
        { text: 'a', start_ms: 0, end_ms: 500 },
        { text: 'b', start_ms: 500, end_ms: 1000 },
      ],
      maxVariants: 2,
      onProgress: async () => {
        throw new Error('DB write hiccup');
      },
    });

    expect(result.variants).toHaveLength(2);
    expect(result.base_url).toBe('https://r2.test/base.png');
  });

  it('works without an onProgress callback (back-compat)', async () => {
    mockedGenerateText.mockResolvedValue(plannerResponse(1));
    mockedT2I.mockResolvedValue({ url: 'https://r2.test/base.png', predictionId: 'p-4' });
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/v.png',
      vendorUsed: 'atlas',
      fallbackUsed: false,
      costUsd: 0.011,
      durationMs: 0,
      providerRequestId: 'e',
    });

    const result = await generateDoodleAssets({
      workspaceId: 'ws-1',
      projectId: null,
      shortId: 'short-1',
      shortScript: 'A.',
      niche: 'general',
      captions: [{ text: 'a', start_ms: 0, end_ms: 500 }],
      maxVariants: 1,
    });

    expect(result.variants).toHaveLength(1);
  });

  it('threads variantEditPrimary into every variant Edit call (Phase 15.14)', async () => {
    mockedGenerateText.mockResolvedValue(plannerResponse(2));
    mockedT2I.mockResolvedValue({ url: 'https://r2.test/base.png', predictionId: 'p-5' });
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/k.png',
      vendorUsed: 'kie',
      fallbackUsed: false,
      costUsd: 0.05,
      durationMs: 0,
      providerRequestId: 'k',
    });

    await generateDoodleAssets({
      workspaceId: 'ws-1',
      projectId: null,
      shortId: 'short-1',
      shortScript: 'A.',
      niche: 'general',
      captions: [
        { text: 'a', start_ms: 0, end_ms: 500 },
        { text: 'b', start_ms: 500, end_ms: 1000 },
      ],
      maxVariants: 2,
      variantEditPrimary: 'kie',
    });

    expect(mockedEdit).toHaveBeenCalledTimes(2);
    for (const call of mockedEdit.mock.calls) {
      expect(call[0]).toMatchObject({ primary: 'kie' });
    }
  });
});
