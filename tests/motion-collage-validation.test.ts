import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// generateMotionCollage's validation gate runs BEFORE any AI call:
//   1. env kill switch (MOTION_COLLAGE_ENABLED='false')
//   2. doc-level settings.allow_motion_collage === false
//   3. grid missing / non-integer / cells < 1
//   4. cells > MAX_COLLAGE_CELLS (hard cap)
//   5. cells > doc settings.max_grid_panels
//   6. panel_prompts.length !== cols × rows
//   7. any panel prompt empty / non-string
//   8. any panel prompt exceeds the per-panel cap
//
// These tests pin every rejection path. We mock the downstream
// modules (Atlas T2I, image-gen-dispatch, upscale, slicer, provider-
// generations, production-doc-styles) so the test file never touches
// real services and any IO leak would surface as an unexpected mock
// call.

vi.mock('@/lib/atlas-cloud-images', () => ({
  generateAtlasT2I: vi.fn(async () => ({ url: 'mock', predictionId: 'mock' })),
}));
vi.mock('@/lib/image-gen-dispatch', () => ({
  cropTo16x9AndUpload: vi.fn(async () => 'mock-cropped'),
}));
vi.mock('@/lib/upscale', () => ({
  // Each panel gets its own upscale call now (plan §D, per-panel
  // generation). Return distinct URLs so the happy-path assertion can
  // verify all N panels were produced and uploaded.
  upscaleViaRecraft: vi.fn(async (croppedUrl: string) => ({
    url: `${croppedUrl}-upscaled-${Math.random().toString(36).slice(2, 8)}`,
  })),
}));
vi.mock('@/lib/provider-generations', () => ({
  recordIntent: vi.fn(async () => ({ id: 'mock-intent' })),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
}));
vi.mock('@/lib/production-doc-styles', () => ({
  resolveStyle: vi.fn(async () => ({ ai_image_suffix: 'mock-suffix' })),
}));
vi.mock('@/lib/production-doc-styles-refs', () => ({
  loadStyleReferences: vi.fn(async () => []),
  mirrorPublicUrlRefToR2: vi.fn(async () => 'mock-mirror-url'),
}));

import {
  generateMotionCollage,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '@/lib/auto-pipeline/production-doc-image-gen';
import { generateAtlasT2I } from '@/lib/atlas-cloud-images';

const mockedAtlas = vi.mocked(generateAtlasT2I);

function validRow(overrides: Partial<PipelineImageRow> = {}): PipelineImageRow {
  return {
    shot_kind: 'motion_collage',
    motion_collage_grid: { cols: 2, rows: 2 },
    motion_collage_panel_prompts: [
      'Frame 1: stick figure standing',
      'Frame 2: same figure, one foot lifted',
      'Frame 3: same figure, mid-step',
      'Frame 4: same figure, foot landing',
    ],
    ...overrides,
  };
}

function docWithRow(row: PipelineImageRow, settings?: PipelineImageDoc['doodle_explainer_2_motion_collage_settings']): PipelineImageDoc {
  return {
    rows: [row],
    style_preset: 'doodle_explainer_2',
    doodle_explainer_2_motion_collage_settings: settings,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.MOTION_COLLAGE_ENABLED;
});

describe('generateMotionCollage — happy path (per-panel generation, plan §D)', () => {
  it('makes ONE Atlas call per panel and returns N panel URLs', async () => {
    const row = validRow();
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBeUndefined();
    expect(result.panelUrls).toHaveLength(4);
    // Per-panel mode: 4 Atlas calls for a 2×2 grid, NOT 1 call + slice.
    expect(mockedAtlas).toHaveBeenCalledTimes(4);
    expect(result.costUsd).toBeGreaterThan(0);
    // collageImageUrl mirrors panel 0 (no combined-collage image any more).
    expect(result.collageImageUrl).toBe(result.panelUrls![0]);
  });

  it('handles a 3×3 grid (9 panels) end-to-end with 9 Atlas calls', async () => {
    const row = validRow({
      motion_collage_grid: { cols: 3, rows: 3 },
      motion_collage_panel_prompts: Array.from({ length: 9 }, (_, i) => `Frame ${i + 1}`),
    });
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.panelUrls).toHaveLength(9);
    expect(mockedAtlas).toHaveBeenCalledTimes(9);
  });
});

describe('generateMotionCollage — kill switch + settings gates', () => {
  it('refuses when MOTION_COLLAGE_ENABLED=false without any AI call', async () => {
    process.env.MOTION_COLLAGE_ENABLED = 'false';
    const row = validRow();
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBe('kill_switch');
    expect(result.panelUrls).toBeUndefined();
    expect(result.costUsd).toBe(0);
    expect(mockedAtlas).not.toHaveBeenCalled();
  });

  it('runs when MOTION_COLLAGE_ENABLED is unset (default enabled)', async () => {
    const row = validRow();
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBeUndefined();
    // 2×2 grid = 4 per-panel Atlas calls (plan §D).
    expect(mockedAtlas).toHaveBeenCalledTimes(4);
  });

  it('refuses when doc-level allow_motion_collage is false', async () => {
    const row = validRow();
    const doc = docWithRow(row, { allow_motion_collage: false });

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBe('settings_disabled');
    expect(result.costUsd).toBe(0);
    expect(mockedAtlas).not.toHaveBeenCalled();
  });

  it('still runs when allow_motion_collage is explicitly true', async () => {
    const row = validRow();
    const doc = docWithRow(row, { allow_motion_collage: true });

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBeUndefined();
  });
});

describe('generateMotionCollage — grid validation', () => {
  it.each([
    { label: 'missing grid', overrides: { motion_collage_grid: undefined } },
    { label: 'cols 0', overrides: { motion_collage_grid: { cols: 0, rows: 2 } } },
    { label: 'rows 0', overrides: { motion_collage_grid: { cols: 2, rows: 0 } } },
    { label: 'negative cols', overrides: { motion_collage_grid: { cols: -1, rows: 2 } } },
    { label: 'non-integer cols', overrides: { motion_collage_grid: { cols: 1.5, rows: 2 } } },
    { label: 'non-integer rows', overrides: { motion_collage_grid: { cols: 2, rows: 2.5 } } },
  ])('rejects $label without any AI call', async ({ overrides }) => {
    const row = validRow(overrides as Partial<PipelineImageRow>);
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toMatch(/^validation_failed:grid_missing_or_malformed/);
    expect(result.costUsd).toBe(0);
    expect(mockedAtlas).not.toHaveBeenCalled();
  });

  it('rejects grids that exceed MAX_COLLAGE_CELLS (hard cap = 16)', async () => {
    const row = validRow({
      motion_collage_grid: { cols: 5, rows: 4 },
      motion_collage_panel_prompts: Array.from({ length: 20 }, (_, i) => `Frame ${i + 1}`),
    });
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toMatch(/^validation_failed:grid_exceeds_hard_cap:20>16/);
    expect(mockedAtlas).not.toHaveBeenCalled();
  });

  it('rejects grids that exceed the doc-level max_grid_panels even when under hard cap', async () => {
    const row = validRow({
      motion_collage_grid: { cols: 3, rows: 3 }, // 9 cells
      motion_collage_panel_prompts: Array.from({ length: 9 }, (_, i) => `Frame ${i + 1}`),
    });
    const doc = docWithRow(row, { max_grid_panels: 6 });

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toMatch(/^validation_failed:grid_exceeds_doc_setting:9>6/);
    expect(mockedAtlas).not.toHaveBeenCalled();
  });
});

describe('generateMotionCollage — panel_prompts validation', () => {
  it('rejects when panel_prompts.length !== cols × rows', async () => {
    const row = validRow({
      motion_collage_grid: { cols: 2, rows: 2 }, // expects 4
      motion_collage_panel_prompts: ['only', 'three', 'panels'],
    });
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBe('validation_failed:panel_prompts_length_mismatch');
    expect(mockedAtlas).not.toHaveBeenCalled();
  });

  it('rejects when panel_prompts is not an array', async () => {
    const row = validRow({ motion_collage_panel_prompts: undefined });
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBe('validation_failed:panel_prompts_length_mismatch');
  });

  it('rejects when any panel prompt is empty', async () => {
    const row = validRow({
      motion_collage_panel_prompts: ['ok', 'ok', '', 'ok'],
    });
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBe('validation_failed:panel_prompt_empty');
  });

  it('rejects when any panel prompt is whitespace-only', async () => {
    const row = validRow({
      motion_collage_panel_prompts: ['ok', '   \n  ', 'ok', 'ok'],
    });
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toBe('validation_failed:panel_prompt_empty');
  });

  it('rejects when any panel prompt exceeds the per-panel character cap (1500)', async () => {
    const row = validRow({
      motion_collage_panel_prompts: [
        'ok',
        'a'.repeat(1501),
        'ok',
        'ok',
      ],
    });
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toMatch(/^validation_failed:panel_prompt_too_long/);
  });
});

describe('generateMotionCollage — failure modes (per-panel generation, plan §D)', () => {
  it('reports `panels_failed:<indices>` when any panel errors', async () => {
    // First Atlas call throws — panel 0 fails. Remaining 3 calls
    // succeed but the whole row fails because the renderer needs ALL
    // N panels (partial sets are visually broken: gap in motion arc).
    mockedAtlas.mockRejectedValueOnce(new Error('atlas rate limit'));
    const row = validRow();
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toMatch(/^panels_failed:/);
    expect(result.panelUrls).toBeUndefined();
  });

  it('reports failed indices in the error string', async () => {
    // Reject the first TWO Atlas calls; succeed for the rest. We don't
    // assert on EXACT indices because the concurrency-limited launcher
    // may consume rejections out of strict input order, but the error
    // shape MUST include the colon-prefix and at least one index.
    mockedAtlas
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockRejectedValueOnce(new Error('rate limit'));
    const row = validRow();
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toMatch(/^panels_failed:\d/);
  });

  it('still charges (totalCostUsd > 0) for the panels that succeeded before the failure', async () => {
    // First call fails, remaining 3 succeed. Successful panels paid for
    // their atlas + recraft (~$0.0135 each) and the audit row marks
    // them delivered. The row fails as a whole but the cost reflects
    // what was actually charged.
    mockedAtlas.mockRejectedValueOnce(new Error('atlas glitch'));
    const row = validRow();
    const doc = docWithRow(row);

    const result = await generateMotionCollage({ row, doc, workspaceId: 'ws' });

    expect(result.error).toMatch(/^panels_failed:/);
    expect(result.costUsd).toBeGreaterThan(0);
    // ~3 panels × $0.0135 ≈ $0.04. Bound loose to allow per-panel
    // rounding without making the test brittle.
    expect(result.costUsd).toBeLessThan(0.05);
  });
});
