import { describe, expect, it } from 'vitest';
import { needsMouthRemoved } from '@/lib/auto-pipeline/stages/generate-production-doc-images';
import { generateMouthRemovedForCharacter } from '@/lib/auto-pipeline/production-doc-image-gen';
import type { PipelineImageRow } from '@/lib/auto-pipeline/production-doc-image-gen';

// ─── needsMouthRemoved ───────────────────────────────────────────────
//
// Small predicate, big blast radius. Gates the per-row $0.011 Atlas
// Edit call AND the renderer's MouthSwap mount. A regression that
// flipped its semantics either silently skips mouth-swap or runs up
// the per-video bill on every row.

describe('needsMouthRemoved', () => {
  it('returns false when motion_beats is undefined', () => {
    const row: PipelineImageRow = {};
    expect(needsMouthRemoved(row)).toBe(false);
  });

  it('returns false when motion_beats is an empty array', () => {
    const row: PipelineImageRow = { motion_beats: [] };
    expect(needsMouthRemoved(row)).toBe(false);
  });

  it('returns false when motion_beats has only non-mouth_swap kinds', () => {
    const row: PipelineImageRow = {
      motion_beats: [
        { kind: 'label_pop' },
        { kind: 'scribble_draw' },
        { kind: 'prop_slide' },
        { kind: 'micro_wiggle' },
        { kind: 'real_photo_punch' },
      ],
    };
    expect(needsMouthRemoved(row)).toBe(false);
  });

  it('returns true when motion_beats contains a single mouth_swap', () => {
    const row: PipelineImageRow = {
      motion_beats: [{ kind: 'mouth_swap' }],
    };
    expect(needsMouthRemoved(row)).toBe(true);
  });

  it('returns true when mouth_swap is mixed with other beat kinds', () => {
    const row: PipelineImageRow = {
      motion_beats: [
        { kind: 'label_pop' },
        { kind: 'mouth_swap' },
        { kind: 'micro_wiggle' },
      ],
    };
    expect(needsMouthRemoved(row)).toBe(true);
  });

  it('survives malformed beat entries without crashing (defense in depth)', () => {
    // An LLM hallucination could emit beats with no `kind` field. The
    // predicate should treat those as "not a mouth_swap" and move on.
    const row: PipelineImageRow = {
      // @ts-expect-error — intentional malformed payload
      motion_beats: [{}, { kind: null }, { kind: 'mouth_swap' }],
    };
    expect(needsMouthRemoved(row)).toBe(true);
  });

  it('returns false when motion_beats is not an array (type-erased input)', () => {
    // The schema is JSONB; a serialisation bug upstream could store
    // motion_beats as a string or object. The predicate should treat
    // any non-array value as "no beats."
    const row: PipelineImageRow = {
      // @ts-expect-error — intentional non-array payload
      motion_beats: 'mouth_swap',
    };
    expect(needsMouthRemoved(row)).toBe(false);
  });
});

// ─── generateMouthRemovedForCharacter input validation ──────────────
//
// The helper's happy path makes an Atlas API call we don't want to
// hit from tests. Input-validation paths bail BEFORE the API call,
// so they're testable without mocks.

describe('generateMouthRemovedForCharacter (input validation)', () => {
  it("returns { error: 'empty_base_image_url' } for an empty URL", async () => {
    const result = await generateMouthRemovedForCharacter({
      baseImageUrl: '',
      characterId: 'explainer-base',
    });
    expect(result.error).toBe('empty_base_image_url');
    expect(result.imageUrl).toBeUndefined();
    expect(result.costUsd).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns { error: 'empty_base_image_url' } for whitespace-only URL", async () => {
    const result = await generateMouthRemovedForCharacter({
      baseImageUrl: '   ',
      characterId: 'explainer-base',
    });
    expect(result.error).toBe('empty_base_image_url');
    expect(result.costUsd).toBe(0);
  });

  it("returns { error: 'empty_character_id' } when characterId is empty", async () => {
    const result = await generateMouthRemovedForCharacter({
      baseImageUrl: 'https://example.com/base.jpg',
      characterId: '',
    });
    expect(result.error).toBe('empty_character_id');
    expect(result.imageUrl).toBeUndefined();
    expect(result.costUsd).toBe(0);
  });

  it("returns { error: 'empty_character_id' } when characterId is whitespace-only", async () => {
    const result = await generateMouthRemovedForCharacter({
      baseImageUrl: 'https://example.com/base.jpg',
      characterId: '   \t',
    });
    expect(result.error).toBe('empty_character_id');
    expect(result.costUsd).toBe(0);
  });

  it('reports a non-negative durationMs on every validation failure', async () => {
    // The timer starts before the validation branch and the result
    // carries the elapsed ms regardless of which branch fires. A
    // negative value would imply a logic error.
    const empties = ['', '   '];
    for (const empty of empties) {
      const result = await generateMouthRemovedForCharacter({
        baseImageUrl: empty,
        characterId: 'explainer-base',
      });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
