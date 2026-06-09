import { describe, expect, it } from 'vitest';
import {
  MOTION_COLLAGE_MAX_CHAIN_DEPTH,
  findMissingPanelIndices,
  pickMotionCollageChunkSize,
  requiredExistingPanelSlots,
} from '@/lib/image-models-i2i';

// Phase 2 of `_plans/2026-06-09-motion-collage-async-bulk-regen.md`.
//
// These pure helpers drive the auto-pipeline's chunked motion-collage
// processing. Pinning them so:
//   - the per-tick chunk size stays vendor-aware (Atlas gets 4, Kie 3)
//     and a future registry edit can't silently turn that into 1 or
//     blow the budget back up to 9
//   - the chain-dependency analyzer (`requiredExistingPanelSlots`) doesn't
//     accidentally regress to "ALL non-regen slots required" which was
//     the bug that blocked Phase 2's first-chunk-on-a-fresh-row case
//   - the missing-slot detector matches the resumable-state contract
//     (sparse motion_collage_panel_urls) without over-counting

describe('pickMotionCollageChunkSize', () => {
  it('returns 4 for Atlas i2i (the cheaper vendor with shorter latency)', () => {
    expect(pickMotionCollageChunkSize('gpt-image-2-atlas-i2i')).toBe(4);
  });

  it('returns 3 for Kie i2i (slower vendor — keeps tick budget intact)', () => {
    expect(pickMotionCollageChunkSize('gpt-image-2-i2i')).toBe(3);
    expect(pickMotionCollageChunkSize('nano-banana-2-i2i')).toBe(3);
    expect(pickMotionCollageChunkSize('flux2-pro-i2i')).toBe(3);
  });

  it('returns 4 for undefined / unknown model (safe Atlas-matching default)', () => {
    expect(pickMotionCollageChunkSize(undefined)).toBe(4);
    expect(pickMotionCollageChunkSize('mystery-model')).toBe(4);
    expect(pickMotionCollageChunkSize('')).toBe(4);
  });

  it('per-chunk wall-clock estimate stays under the 255 s tick budget for both vendors', () => {
    // The whole point of vendor-aware chunking: each chunk must fit
    // inside one auto-pipeline tick. Sanity check the math behind
    // the constant choice so a registry edit can't silently turn a
    // formerly-fitting chunk into a 504 trap.
    //
    // Latencies are conservative wall-clock estimates from production
    // observation; if a vendor speeds up, the chunk size could grow
    // safely. We size for the SLOWEST observed call per vendor.
    const TICK_BUDGET_MS = 255_000;
    const ATLAS_I2I_MS = 30_000;
    const ATLAS_EDIT_MS = 40_000;
    const KIE_I2I_MS = 60_000;
    const KIE_EDIT_MS = 75_000;
    const atlasChunk = pickMotionCollageChunkSize('gpt-image-2-atlas-i2i');
    const atlasWorstCase = ATLAS_I2I_MS + (atlasChunk - 1) * ATLAS_EDIT_MS;
    expect(atlasWorstCase).toBeLessThan(TICK_BUDGET_MS);
    const kieChunk = pickMotionCollageChunkSize('gpt-image-2-i2i');
    const kieWorstCase = KIE_I2I_MS + (kieChunk - 1) * KIE_EDIT_MS;
    expect(kieWorstCase).toBeLessThan(TICK_BUDGET_MS);
  });
});

describe('findMissingPanelIndices', () => {
  it('returns every index when no URLs exist yet', () => {
    expect(findMissingPanelIndices(undefined, 4)).toEqual([0, 1, 2, 3]);
    expect(findMissingPanelIndices([], 4)).toEqual([0, 1, 2, 3]);
  });

  it('treats empty strings, whitespace, undefined, and null as missing', () => {
    expect(findMissingPanelIndices(['a', '', 'c', '   '], 4)).toEqual([1, 3]);
    expect(findMissingPanelIndices(['a', undefined, 'c', null], 4)).toEqual([1, 3]);
  });

  it('returns the gap when the array is shorter than the total grid', () => {
    expect(findMissingPanelIndices(['a', 'b'], 4)).toEqual([2, 3]);
  });

  it('returns empty when every panel has a populated URL', () => {
    expect(findMissingPanelIndices(['a', 'b', 'c', 'd'], 4)).toEqual([]);
  });

  it('preserves index order (left-to-right scan)', () => {
    expect(findMissingPanelIndices(['', 'b', '', 'd', '', ''], 6)).toEqual([0, 2, 4, 5]);
  });
});

describe('requiredExistingPanelSlots — chain-dependency analyzer', () => {
  // The chain semantics this analyzer encodes are documented in
  // production-doc-image-gen.ts around the panel-1..N generation loop.
  // Recapped: panel 0 is the base; panels 1..MAX_CHAIN_DEPTH-1 chain
  // off the previous panel (and read panel 0 as composition anchor
  // from index >= 2); panels >= MAX_CHAIN_DEPTH fan out from panel 0.

  it('exports the chain depth constant in sync with production-doc-image-gen.ts', () => {
    expect(MOTION_COLLAGE_MAX_CHAIN_DEPTH).toBe(4);
  });

  it('regen = [0] (just panel 0) requires nothing', () => {
    expect(requiredExistingPanelSlots([0])).toEqual([]);
  });

  it('regen = [0..3] (the full chain segment, fresh row) requires nothing because every dependency is in the set', () => {
    expect(requiredExistingPanelSlots([0, 1, 2, 3])).toEqual([]);
  });

  it('regen = [4..8] (the fan-out segment) requires panel 0 only (the composition anchor)', () => {
    expect(requiredExistingPanelSlots([4, 5, 6, 7, 8])).toEqual([0]);
  });

  it('regen = [3, 4, 5] (bridges the chain-depth boundary) requires panels 0 and 2', () => {
    // Panel 3: chained — reads panel 2 (chain source) and panel 0 (anchor)
    // Panel 4: fan-out — reads panel 0
    // Panel 5: fan-out — reads panel 0
    expect(requiredExistingPanelSlots([3, 4, 5])).toEqual([0, 2]);
  });

  it('regen = [1] requires panel 0 (chain source) but not the anchor (K<2)', () => {
    expect(requiredExistingPanelSlots([1])).toEqual([0]);
  });

  it('regen = [2] requires panel 1 (chain source) AND panel 0 (anchor for K>=2)', () => {
    expect(requiredExistingPanelSlots([2])).toEqual([0, 1]);
  });

  it('regen = [5] (single fan-out panel) requires panel 0', () => {
    expect(requiredExistingPanelSlots([5])).toEqual([0]);
  });

  it('non-contiguous regen sets compute the union of dependencies correctly', () => {
    // [1, 5]: panel 1 needs 0, panel 5 needs 0 — union is {0}.
    expect(requiredExistingPanelSlots([1, 5])).toEqual([0]);
    // [2, 6]: panel 2 needs {0, 1}, panel 6 needs {0} — union is {0, 1}.
    expect(requiredExistingPanelSlots([2, 6])).toEqual([0, 1]);
  });

  it('respects a non-default chain depth (covers a future tuning of the constant)', () => {
    // depth=2: only panel 1 chains; panels 2+ fan out.
    // [2, 3]: both fan-out — require {0}.
    expect(requiredExistingPanelSlots([2, 3], 2)).toEqual([0]);
    // [1, 3]: panel 1 chains (needs 0), panel 3 fans out (needs 0) → {0}
    expect(requiredExistingPanelSlots([1, 3], 2)).toEqual([0]);
  });

  it('returns a sorted array (deterministic for snapshot/log stability)', () => {
    const out = requiredExistingPanelSlots([8, 4, 6, 2]);
    expect(out).toEqual([...out].sort((a, b) => a - b));
  });
});

describe('chunked-progress integration — slot-required matches chunk decisions', () => {
  // Cross-check that the helpers compose: when the stage handler picks
  // a chunk of `chunkSize` missing indices, the required-slots set
  // reflects only the chain dependencies of THAT chunk.

  it('first chunk on a fresh row (4 panels Atlas) needs nothing — the chunk covers all dependencies', () => {
    const totalN = 4;
    const existing: string[] = [];
    const missing = findMissingPanelIndices(existing, totalN);
    const chunk = missing.slice(0, pickMotionCollageChunkSize('gpt-image-2-atlas-i2i'));
    expect(chunk).toEqual([0, 1, 2, 3]);
    expect(requiredExistingPanelSlots(chunk)).toEqual([]);
  });

  it('first Kie chunk on a 9-panel row covers [0..2]; second chunk needs panel 0 + the chain source', () => {
    const totalN = 9;
    const existing: string[] = [];
    const chunkSize = pickMotionCollageChunkSize('gpt-image-2-i2i');
    const firstMissing = findMissingPanelIndices(existing, totalN);
    const firstChunk = firstMissing.slice(0, chunkSize);
    expect(firstChunk).toEqual([0, 1, 2]);
    expect(requiredExistingPanelSlots(firstChunk)).toEqual([]);
    const afterFirst: string[] = ['u0', 'u1', 'u2'];
    const secondMissing = findMissingPanelIndices(afterFirst, totalN);
    const secondChunk = secondMissing.slice(0, chunkSize);
    expect(secondChunk).toEqual([3, 4, 5]);
    // Panel 3 chains from panel 2 (existing); panels 4-5 anchor to panel 0.
    expect(requiredExistingPanelSlots(secondChunk)).toEqual([0, 2]);
  });

  it('last Kie chunk on a 9-panel row covers [6..8] (fan-out only) — needs just panel 0', () => {
    const totalN = 9;
    const existing: string[] = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'];
    const missing = findMissingPanelIndices(existing, totalN);
    const chunk = missing.slice(0, pickMotionCollageChunkSize('gpt-image-2-i2i'));
    expect(chunk).toEqual([6, 7, 8]);
    expect(requiredExistingPanelSlots(chunk)).toEqual([0]);
  });
});
