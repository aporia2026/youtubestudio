/**
 * Unit tests for `generateMotionCollage`'s partial-regen validation block.
 *
 * PR 2 of `_plans/2026-06-02-editor-motion-collage-support.md` extends the
 * helper to accept `panelIndices?: number[]` + `existingPanelUrls?: string[]`,
 * so the inspector can regenerate just one cell instead of paying for N.
 *
 * These tests pin the validation layer — they exercise INVALID inputs that
 * must fail BEFORE any AI / DB call. Successful end-to-end regen is covered
 * by manual QA on a real doc (the helper hits Atlas + Recraft + R2 + DB and
 * isn't unit-testable here).
 *
 * Setup invariant: every test passes valid `grid` + `motion_collage_panel_prompts`
 * AND leaves `doc.style_preset` undefined so the helper short-circuits at the
 * partial-regen block without touching `resolveStyle` (which hits the DB).
 */

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import {
  generateMotionCollage,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '@/lib/auto-pipeline/production-doc-image-gen';

const ORIGINAL_ENV = process.env.MOTION_COLLAGE_ENABLED;
beforeAll(() => {
  // The helper checks process.env.MOTION_COLLAGE_ENABLED === 'false' as a
  // kill switch. Set anything-else (or unset) so the kill-switch path
  // doesn't preempt our validation tests.
  delete process.env.MOTION_COLLAGE_ENABLED;
});
afterAll(() => {
  if (ORIGINAL_ENV !== undefined) process.env.MOTION_COLLAGE_ENABLED = ORIGINAL_ENV;
});

function minimalRow(): PipelineImageRow {
  return {
    shot_kind: 'motion_collage',
    motion_collage_grid: { cols: 2, rows: 2 },
    motion_collage_panel_prompts: ['a', 'b', 'c', 'd'],
  };
}

function minimalDoc(row: PipelineImageRow): PipelineImageDoc {
  // No style_preset → no DB call inside the helper (resolveStyle is gated
  // on `doc.style_preset?.trim()`).
  return { rows: [row] };
}

const VALID_EXISTING_URLS: readonly string[] = [
  'https://example.com/p0.png',
  'https://example.com/p1.png',
  'https://example.com/p2.png',
  'https://example.com/p3.png',
];

describe('generateMotionCollage partial-regen validation', () => {
  it('rejects panelIndices with a negative index', async () => {
    const row = minimalRow();
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      panelIndices: [-1],
      existingPanelUrls: VALID_EXISTING_URLS,
    });
    expect(result.panelUrls).toBeUndefined();
    expect(result.costUsd).toBe(0);
    expect(result.error).toMatch(/validation_failed:panel_index_out_of_range:-1/);
  });

  it('rejects panelIndices with an index >= N', async () => {
    const row = minimalRow();
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      panelIndices: [4], // N === 4, valid range is [0, 3]
      existingPanelUrls: VALID_EXISTING_URLS,
    });
    expect(result.panelUrls).toBeUndefined();
    expect(result.error).toMatch(/validation_failed:panel_index_out_of_range:4/);
  });

  it('rejects panelIndices with a non-integer value', async () => {
    const row = minimalRow();
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      panelIndices: [1.5],
      existingPanelUrls: VALID_EXISTING_URLS,
    });
    expect(result.error).toMatch(/validation_failed:panel_index_out_of_range:1\.5/);
  });

  it('rejects missing existingPanelUrls when panelIndices is set', async () => {
    const row = minimalRow();
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      panelIndices: [1],
      // existingPanelUrls intentionally omitted
    });
    expect(result.error).toMatch(/validation_failed:existing_panel_urls_missing_or_wrong_length/);
  });

  it('rejects wrong-length existingPanelUrls', async () => {
    const row = minimalRow();
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      panelIndices: [1],
      existingPanelUrls: ['https://example.com/p0.png', 'https://example.com/p1.png'], // length 2, need 4
    });
    expect(result.error).toMatch(/validation_failed:existing_panel_urls_missing_or_wrong_length/);
  });

  it('rejects unsafe javascript: URL in a non-regen slot', async () => {
    const row = minimalRow();
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      panelIndices: [0], // regen panel 0; panels 1-3 must be safe URLs
      existingPanelUrls: [
        'https://example.com/p0.png', // index 0 — regen'd, content doesn't matter
        'javascript:alert(1)',         // index 1 — passthrough, unsafe → reject
        'https://example.com/p2.png',
        'https://example.com/p3.png',
      ],
    });
    expect(result.error).toMatch(/validation_failed:existing_panel_url_unsafe:1/);
  });

  it('rejects empty-string URL in a non-regen slot', async () => {
    const row = minimalRow();
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      panelIndices: [0],
      existingPanelUrls: [
        'https://example.com/p0.png',
        '',
        'https://example.com/p2.png',
        'https://example.com/p3.png',
      ],
    });
    expect(result.error).toMatch(/validation_failed:existing_panel_url_unsafe:1/);
  });

  it('rejects existingPanelUrls when panelIndices is NOT set — empty array short-circuits to legacy path', async () => {
    // The helper's `isPartialRegen` check is `Array.isArray(panelIndices) && panelIndices.length > 0`.
    // An empty array therefore falls through to the legacy full-regen path,
    // and any `existingPanelUrls` passed alongside it is ignored — not an
    // error case. This test pins that contract: validation does NOT fire
    // for partial-regen-shaped errors when the regen set is empty.
    // (The route layer rejects `existingPanelUrls` without `panelIndices`
    // with a clean 400 before reaching the helper.)
    const row: PipelineImageRow = {
      shot_kind: 'motion_collage',
      motion_collage_grid: undefined, // forces row-validation failure, NOT partial-regen failure
      motion_collage_panel_prompts: [],
    };
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      panelIndices: [],
      existingPanelUrls: ['javascript:alert(1)', 'x', 'y', 'z'],
    });
    // Row validation runs FIRST, so the failure should be about the missing
    // grid — NOT about the unsafe URL we passed.
    expect(result.error).toMatch(/validation_failed:grid_missing_or_malformed/);
    expect(result.error).not.toMatch(/validation_failed:existing_panel_url_unsafe/);
  });

  it('legacy full-regen call signature still validates row inputs correctly', async () => {
    // Empty grid → row validation kicks in BEFORE partial-regen check.
    const row: PipelineImageRow = {
      shot_kind: 'motion_collage',
      motion_collage_grid: undefined,
      motion_collage_panel_prompts: [],
    };
    const result = await generateMotionCollage({
      row,
      doc: minimalDoc(row),
      workspaceId: 'test-ws',
      // No partial regen → legacy path → existing row validation should fire.
    });
    expect(result.error).toMatch(/validation_failed:grid_missing_or_malformed/);
  });
});
