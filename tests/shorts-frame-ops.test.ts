import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks at top so the imports below resolve to mocked versions. The
// frame-ops module hits two vendor wrappers — we mock them outright so
// the tests are pure and never reach the network.
vi.mock('@/lib/atlas-cloud-images', () => ({
  generateAtlasT2I: vi.fn(),
}));
vi.mock('@/lib/gpt-image-2-edit', () => ({
  generateGptImage2Edit: vi.fn(),
}));

import {
  regenerateBaseFrame,
  regenerateVariantFrame,
  appendVariantFrame,
  deleteVariantFrame,
} from '@/lib/shorts-frame-ops';
import { generateAtlasT2I } from '@/lib/atlas-cloud-images';
import { generateGptImage2Edit } from '@/lib/gpt-image-2-edit';
import type { ShortRow } from '@/lib/shorts-types';

const mockedT2I = vi.mocked(generateAtlasT2I);
const mockedEdit = vi.mocked(generateGptImage2Edit);

beforeEach(() => {
  mockedT2I.mockReset();
  mockedEdit.mockReset();
});

/** Doodle row fixture with a fully-populated frame block. Tests pick
 *  what they need by overriding `style_assets` per case. */
function doodleRow(overrides: Partial<ShortRow> = {}): ShortRow {
  return {
    id: 'short-1',
    workspace_id: 'ws-1',
    project_id: null,
    source_script_id: null,
    kind: 'extracted',
    medium: 'short_native',
    title: 'Test short',
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
        base_prompt: 'A character holding a sign.',
        variants: [
          { url: 'https://r2.test/v0.png', caption_chunk_start_index: 0, edit_prompt: 'wave hand' },
          { url: 'https://r2.test/v1.png', caption_chunk_start_index: 3, edit_prompt: 'jump' },
          { url: 'https://r2.test/v2.png', caption_chunk_start_index: 5, edit_prompt: 'smile' },
        ],
      },
    },
    captions_config: {},
    generation_progress: {},
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

// ───────────────────────── regenerateBaseFrame ─────────────────────────

describe('regenerateBaseFrame', () => {
  it('replaces base_url + base_prompt and leaves variants intact', async () => {
    mockedT2I.mockResolvedValue({
      url: 'https://r2.test/new-base.png',
      predictionId: 'pred-99',
      predictTimeMs: 12_345,
    });
    const row = doodleRow();
    const result = await regenerateBaseFrame(row, { prompt: 'A character in a hat.' });

    expect(mockedT2I).toHaveBeenCalledOnce();
    expect(result.style_assets.doodle?.base_url).toBe('https://r2.test/new-base.png');
    expect(result.style_assets.doodle?.base_prompt).toBe('A character in a hat.');
    expect(result.style_assets.doodle?.variants).toEqual(row.style_assets.doodle?.variants);
    expect(result.costUsd).toBe(0.04);
  });

  it('routes Paint shorts to the paint sub-block', async () => {
    mockedT2I.mockResolvedValue({ url: 'https://r2.test/p.png', predictionId: 'p-1' });
    const row = doodleRow({
      style_id: 'paint_explainer_v1_short',
      style_assets: {
        paint: {
          base_url: 'https://r2.test/p-base.png',
          base_prompt: 'paint scene',
          variants: [],
        },
      },
    });
    const result = await regenerateBaseFrame(row, { prompt: 'paint scene v2' });
    expect(result.style_assets.paint?.base_url).toBe('https://r2.test/p.png');
    expect(result.style_assets.paint?.base_prompt).toBe('paint scene v2');
    expect(result.style_assets.doodle).toBeUndefined();
  });

  it('throws for non-frame-bearing styles', async () => {
    const row = doodleRow({ style_id: 'minimal_gradient_v1', style_assets: {} });
    await expect(regenerateBaseFrame(row, { prompt: 'whatever' })).rejects.toThrow(
      /only apply to Doodle or Paint/,
    );
    expect(mockedT2I).not.toHaveBeenCalled();
  });

  it('throws when assets block is missing (pipeline never ran)', async () => {
    const row = doodleRow({ style_assets: {} });
    await expect(regenerateBaseFrame(row, { prompt: 'whatever' })).rejects.toThrow(
      /no style_assets\.doodle block/,
    );
  });
});

// ───────────────────────── regenerateVariantFrame ──────────────────────

describe('regenerateVariantFrame', () => {
  it('replaces only the targeted variant and preserves chunk index', async () => {
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/v1-new.png',
      vendorUsed: 'atlas',
      fallbackUsed: false,
      costUsd: 0.011,
      durationMs: 5000,
      providerRequestId: 'pred-2',
    });
    const row = doodleRow();
    const result = await regenerateVariantFrame(row, { index: 1, prompt: 'jump higher' });

    expect(mockedEdit).toHaveBeenCalledOnce();
    expect(mockedEdit.mock.calls[0][0]).toMatchObject({
      prompt: 'jump higher',
      sourceImageUrl: 'https://r2.test/base.png',
      primary: 'atlas',
    });
    const variants = result.style_assets.doodle?.variants ?? [];
    expect(variants).toHaveLength(3);
    expect(variants[1].url).toBe('https://r2.test/v1-new.png');
    expect(variants[1].edit_prompt).toBe('jump higher');
    // Chunk index was 3 before — must remain 3.
    expect(variants[1].caption_chunk_start_index).toBe(3);
    // Other variants untouched.
    expect(variants[0].url).toBe('https://r2.test/v0.png');
    expect(variants[2].url).toBe('https://r2.test/v2.png');
    // Base unchanged.
    expect(result.style_assets.doodle?.base_url).toBe('https://r2.test/base.png');
  });

  it('throws on out-of-range index', async () => {
    const row = doodleRow();
    await expect(
      regenerateVariantFrame(row, { index: 99, prompt: 'x' }),
    ).rejects.toThrow(/out of range/);
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it('throws on negative index', async () => {
    const row = doodleRow();
    await expect(
      regenerateVariantFrame(row, { index: -1, prompt: 'x' }),
    ).rejects.toThrow(/out of range/);
  });
});

// ───────────────────────── appendVariantFrame ──────────────────────────

describe('appendVariantFrame', () => {
  it('inserts a new variant in sorted position (middle)', async () => {
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/new.png',
      vendorUsed: 'atlas',
      fallbackUsed: false,
      costUsd: 0.011,
      durationMs: 5000,
      providerRequestId: 'pred-3',
    });
    const row = doodleRow();
    const result = await appendVariantFrame(row, {
      prompt: 'point left',
      captionChunkStartIndex: 4,
    });
    const variants = result.style_assets.doodle?.variants ?? [];
    // Original chunk indexes: [0, 3, 5]; new=4 → insert at index 2.
    expect(variants.map((v) => v.caption_chunk_start_index)).toEqual([0, 3, 4, 5]);
    expect(result.newIndex).toBe(2);
    expect(variants[2].url).toBe('https://r2.test/new.png');
    expect(variants[2].edit_prompt).toBe('point left');
  });

  it('appends to the end when chunk index is the largest', async () => {
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/tail.png',
      vendorUsed: 'atlas',
      fallbackUsed: false,
      costUsd: 0.011,
      durationMs: 0,
      providerRequestId: 'pred-4',
    });
    const row = doodleRow();
    const result = await appendVariantFrame(row, {
      prompt: 'tail',
      captionChunkStartIndex: 99,
    });
    const variants = result.style_assets.doodle?.variants ?? [];
    expect(variants.map((v) => v.caption_chunk_start_index)).toEqual([0, 3, 5, 99]);
    expect(result.newIndex).toBe(3);
  });

  it('puts ties after existing entries (stable order)', async () => {
    mockedEdit.mockResolvedValue({
      url: 'https://r2.test/tie.png',
      vendorUsed: 'atlas',
      fallbackUsed: false,
      costUsd: 0.011,
      durationMs: 0,
      providerRequestId: 'pred-5',
    });
    const row = doodleRow();
    // Insert at chunk 3 (already present at original index 1).
    const result = await appendVariantFrame(row, {
      prompt: 'after',
      captionChunkStartIndex: 3,
    });
    const variants = result.style_assets.doodle?.variants ?? [];
    expect(variants.map((v) => v.caption_chunk_start_index)).toEqual([0, 3, 3, 5]);
    expect(result.newIndex).toBe(2);
    expect(variants[1].url).toBe('https://r2.test/v1.png'); // existing first
    expect(variants[2].url).toBe('https://r2.test/tie.png'); // new after
  });

  it('throws on negative chunk index', async () => {
    const row = doodleRow();
    await expect(
      appendVariantFrame(row, { prompt: 'x', captionChunkStartIndex: -1 }),
    ).rejects.toThrow(/non-negative integer/);
    expect(mockedEdit).not.toHaveBeenCalled();
  });
});

// ───────────────────────── deleteVariantFrame ──────────────────────────

describe('deleteVariantFrame', () => {
  it('removes the variant at the given index', () => {
    const row = doodleRow();
    const result = deleteVariantFrame(row, { index: 1 });
    const variants = result.style_assets.doodle?.variants ?? [];
    expect(variants).toHaveLength(2);
    expect(variants.map((v) => v.url)).toEqual([
      'https://r2.test/v0.png',
      'https://r2.test/v2.png',
    ]);
    // Base untouched.
    expect(result.style_assets.doodle?.base_url).toBe('https://r2.test/base.png');
  });

  it('does not mutate the input row', () => {
    const row = doodleRow();
    const before = JSON.stringify(row.style_assets);
    deleteVariantFrame(row, { index: 0 });
    expect(JSON.stringify(row.style_assets)).toBe(before);
  });

  it('throws on out-of-range index', () => {
    const row = doodleRow();
    expect(() => deleteVariantFrame(row, { index: 99 })).toThrow(/out of range/);
  });
});
