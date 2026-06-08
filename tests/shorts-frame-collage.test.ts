import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// Mock the t2i dispatcher AND the R2 helpers. The orchestrator's
// per-vendor wire details belong to their own test files; here we just
// verify the orchestration sequence + the data shape persisted on the
// row.
vi.mock('@/lib/shorts-base-t2i', async () => {
  const actual = await vi.importActual<typeof import('@/lib/shorts-base-t2i')>(
    '@/lib/shorts-base-t2i',
  );
  return {
    ...actual,
    generateShortsBaseT2I: vi.fn(),
  };
});
vi.mock('@/lib/r2', () => ({
  uploadToBucket: vi.fn(async () => undefined),
  getImagesBucket: vi.fn(() => 'images-test-bucket'),
  getDownloadUrlForBucket: vi.fn(
    async (_bucket: string, key: string) => `https://r2-test.example/${key}`,
  ),
}));

import {
  appendCollageVariant,
  COLLAGE_PANEL_COUNT,
  COLLAGE_GRID_DIMENSIONS,
} from '@/lib/shorts-frame-collage';
import { generateShortsBaseT2I } from '@/lib/shorts-base-t2i';
import { uploadToBucket } from '@/lib/r2';
import type { ShortRow } from '@/lib/shorts-types';

const mockedT2I = vi.mocked(generateShortsBaseT2I);
const mockedUpload = vi.mocked(uploadToBucket);

/** Synthetic PNG sharp can decode. Solid colour at the requested size
 *  so the orchestrator's resize + composite work end-to-end. Without
 *  this, the orchestrator's fetch → resize step would throw on a
 *  bogus payload, making it impossible to verify composition. */
async function syntheticPng(size = 256): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 80, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

beforeEach(() => {
  mockedT2I.mockReset();
  mockedUpload.mockReset();
  mockedUpload.mockResolvedValue(undefined);

  // Replace global fetch with one that returns synthetic PNG bytes so
  // the orchestrator's per-panel fetch+resize step has real image data
  // to work with. Restored automatically after each test by vitest's
  // mock cleanup model.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => (await syntheticPng()).buffer,
    })) as unknown as typeof fetch,
  );
});

function doodleRow(overrides: Partial<ShortRow> = {}): ShortRow {
  return {
    id: 'short-1',
    workspace_id: 'ws-1',
    project_id: null,
    source_script_id: null,
    kind: 'extracted',
    medium: 'short_native',
    title: 'Test',
    short_script: 'A test script.',
    hook: null,
    payoff: null,
    word_count: 4,
    estimated_duration_seconds: 2,
    source_title: null,
    source_description: null,
    seo_result: null,
    voiceover_audio_url: null,
    voiceover_blob_pathname: null,
    voiceover_voice_id: null,
    voiceover_duration_seconds: null,
    rendered_video_url: null,
    ai_model: null,
    notes: null,
    hook_score: null,
    dismissed_at: null,
    source_youtube_video_id: null,
    clip_start_ms: null,
    clip_end_ms: null,
    style_id: 'doodle_explainer_2_short',
    style_assets: {
      doodle: {
        base_url: 'https://r2.test/base.png',
        variants: [
          { url: 'https://r2.test/v0.png', caption_chunk_start_index: 0 },
          { url: 'https://r2.test/v1.png', caption_chunk_start_index: 5 },
        ],
      },
    },
    captions_config: {},
    generation_progress: {},
    assets_context: null,
    qa_result: null,
    qa_score: null,
    qa_run_at: null,
    batch_id: null,
    youtube_video_id: null,
    youtube_status: null,
    youtube_publish_at: null,
    youtube_metadata: {},
    youtube_uploaded_at: null,
    youtube_upload_error: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('constants', () => {
  it('ships a 2×2 grid with 4 panels in v1', () => {
    expect(COLLAGE_PANEL_COUNT).toBe(4);
    expect(COLLAGE_GRID_DIMENSIONS).toEqual({ cols: 2, rows: 2 });
  });
});

describe('appendCollageVariant — happy path', () => {
  it('generates 4 panels in parallel, composes + uploads, and inserts sorted', async () => {
    // 4 distinct panel URLs so the assertions can verify ordering.
    mockedT2I
      .mockResolvedValueOnce({
        url: 'https://r2.test/p0.png',
        modelId: 'atlas-gpt-image-2',
        vendorUsed: 'atlas',
        costUsd: 0.009,
        durationMs: 30000,
        providerRequestId: 'pr-0',
      })
      .mockResolvedValueOnce({
        url: 'https://r2.test/p1.png',
        modelId: 'atlas-gpt-image-2',
        vendorUsed: 'atlas',
        costUsd: 0.009,
        durationMs: 30000,
        providerRequestId: 'pr-1',
      })
      .mockResolvedValueOnce({
        url: 'https://r2.test/p2.png',
        modelId: 'atlas-gpt-image-2',
        vendorUsed: 'atlas',
        costUsd: 0.009,
        durationMs: 30000,
        providerRequestId: 'pr-2',
      })
      .mockResolvedValueOnce({
        url: 'https://r2.test/p3.png',
        modelId: 'atlas-gpt-image-2',
        vendorUsed: 'atlas',
        costUsd: 0.009,
        durationMs: 30000,
        providerRequestId: 'pr-3',
      });

    const row = doodleRow();
    const result = await appendCollageVariant(row, {
      captionChunkStartIndex: 3,
      panelPrompts: [
        'A character on a white canvas waving their hand',
        'The character now holding a question mark sign',
        'The character now jumping with arms raised',
        'The character now smiling with an idea bulb',
      ],
    });

    // 4 panel generations, all parallel.
    expect(mockedT2I).toHaveBeenCalledTimes(4);
    expect(mockedUpload).toHaveBeenCalledOnce();

    // Inserted sorted: existing chunk indexes are [0, 5]; new=3 → idx 1.
    const variants = result.style_assets.doodle?.variants ?? [];
    expect(variants.map((v) => v.caption_chunk_start_index)).toEqual([0, 3, 5]);
    expect(result.newIndex).toBe(1);

    // New variant is a collage with all 4 panels persisted.
    const collageVariant = variants[1];
    expect(collageVariant.collage?.panels).toHaveLength(4);
    expect(collageVariant.collage?.grid).toEqual({ cols: 2, rows: 2 });
    expect(collageVariant.collage?.panels.map((p) => p.url)).toEqual([
      'https://r2.test/p0.png',
      'https://r2.test/p1.png',
      'https://r2.test/p2.png',
      'https://r2.test/p3.png',
    ]);
    // Composed image is 864×1536 (9:16). Two 9:16 panels stacked
    // horizontally + vertically preserve the aspect — matches the Shorts
    // viewport so no crop. See _plans/2026-06-04-shorts-images-must-be-9-16.md.
    expect(collageVariant.collage?.composed_width).toBe(864);
    expect(collageVariant.collage?.composed_height).toBe(1536);
    expect(
      collageVariant.collage!.composed_width / collageVariant.collage!.composed_height,
    ).toBeCloseTo(9 / 16, 5);

    // url points at the R2-hosted composed image, not at panel 0.
    expect(collageVariant.url).toMatch(/^https:\/\/r2-test\.example\/shorts-collage\//);

    // Aggregate cost = 4 × $0.009 = $0.036.
    expect(result.costUsd).toBeCloseTo(0.036, 4);
  });

  it('uses the brief verbatim when supplied; falls back to panel-0 otherwise', async () => {
    const panelResp = {
      url: 'https://r2.test/p.png',
      modelId: 'atlas-gpt-image-2' as const,
      vendorUsed: 'atlas' as const,
      costUsd: 0.009,
      durationMs: 0,
      providerRequestId: 'p',
    };
    mockedT2I.mockResolvedValue(panelResp);

    const row = doodleRow();
    const withBrief = await appendCollageVariant(row, {
      captionChunkStartIndex: 1,
      panelPrompts: [
        'A character on a white canvas',
        'The character pondering',
        'The character celebrating',
        'The character smiling',
      ],
      brief: 'Four moods of the same character',
    });
    expect(withBrief.style_assets.doodle?.variants[1].edit_prompt).toBe(
      'Four moods of the same character',
    );

    mockedT2I.mockResolvedValue(panelResp);
    const noBrief = await appendCollageVariant(row, {
      captionChunkStartIndex: 1,
      panelPrompts: [
        'A character on a white canvas',
        'The character pondering',
        'The character celebrating',
        'The character smiling',
      ],
    });
    expect(noBrief.style_assets.doodle?.variants[1].edit_prompt).toMatch(
      /^Collage: A character on a white canvas/,
    );
  });
});

describe('appendCollageVariant — validation', () => {
  it('throws when fewer than 4 prompts are supplied', async () => {
    const row = doodleRow();
    await expect(
      appendCollageVariant(row, {
        captionChunkStartIndex: 1,
        panelPrompts: [
          'A character on a white canvas',
          'The character now pondering',
        ],
      }),
    ).rejects.toThrow(/exactly 4 panel prompts/);
    expect(mockedT2I).not.toHaveBeenCalled();
  });

  it('throws when any panel prompt is too short', async () => {
    const row = doodleRow();
    await expect(
      appendCollageVariant(row, {
        captionChunkStartIndex: 1,
        panelPrompts: ['ok prompt one', 'ok prompt two', 'short', 'ok prompt four'],
      }),
    ).rejects.toThrow(/Panel 2 prompt is too short/);
  });

  it('throws when caption chunk index is negative', async () => {
    const row = doodleRow();
    await expect(
      appendCollageVariant(row, {
        captionChunkStartIndex: -1,
        panelPrompts: [
          'A character on a white canvas waving',
          'A character looking surprised',
          'A character looking happy',
          'A character looking puzzled',
        ],
      }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it('throws when the row is on a non-frame-bearing style', async () => {
    const row = doodleRow({ style_id: 'minimal_gradient_v1', style_assets: {} });
    await expect(
      appendCollageVariant(row, {
        captionChunkStartIndex: 1,
        panelPrompts: [
          'A character on a white canvas waving',
          'A character looking surprised',
          'A character looking happy',
          'A character looking puzzled',
        ],
      }),
    ).rejects.toThrow(/Doodle or Paint/);
  });
});

describe('appendCollageVariant — failure propagation', () => {
  it('throws + does not upload when any panel generation fails', async () => {
    mockedT2I
      .mockResolvedValueOnce({
        url: 'https://r2.test/p0.png',
        modelId: 'atlas-gpt-image-2' as const,
        vendorUsed: 'atlas',
        costUsd: 0.009,
        durationMs: 0,
        providerRequestId: 'pr-0',
      })
      .mockRejectedValueOnce(new Error('Atlas T2I timeout'))
      .mockResolvedValueOnce({
        url: 'https://r2.test/p2.png',
        modelId: 'atlas-gpt-image-2' as const,
        vendorUsed: 'atlas',
        costUsd: 0.009,
        durationMs: 0,
        providerRequestId: 'pr-2',
      })
      .mockResolvedValueOnce({
        url: 'https://r2.test/p3.png',
        modelId: 'atlas-gpt-image-2' as const,
        vendorUsed: 'atlas',
        costUsd: 0.009,
        durationMs: 0,
        providerRequestId: 'pr-3',
      });

    const row = doodleRow();
    await expect(
      appendCollageVariant(row, {
        captionChunkStartIndex: 1,
        panelPrompts: [
          'A character on a white canvas waving',
          'A character looking surprised',
          'A character looking happy',
          'A character looking puzzled',
        ],
      }),
    ).rejects.toThrow(/Atlas T2I timeout/);

    // Nothing should be persisted to R2 when any panel fails.
    expect(mockedUpload).not.toHaveBeenCalled();
  });
});
