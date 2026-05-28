import { describe, expect, it } from 'vitest';
import {
  CHAINED_VARIANT_IDENTITY_ANCHOR,
  composeVariantEditRequest,
  getBaseRow,
  getPreviousVariantRow,
  resolveVariantChainMode,
} from '@/remotion/utils';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';

// Phase 1.7 (chained variants) — dispatcher behaviour for the manual
// editor path. Spec: _plans/2026-05-28-doodle-2-chained-variants.md.
//
// Auto-pipeline parity lives in src/lib/auto-pipeline/production-doc-image-gen.ts
// and uses the same identity-anchor string; that path is exercised by
// auto-pipeline integration tests.

function makeRow(opts: Partial<ProductionRow> & { script_text: string }): ProductionRow {
  return {
    timecode: '0:00',
    visual_type: 'Animation',
    visual_description: 'desc',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...opts,
  } as ProductionRow;
}

function makeDoc(rows: ProductionRow[], extras: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    title: 'test',
    niche: 'test',
    total_duration: '0:30',
    total_words: 50,
    speaking_pace_wpm: 135,
    rows,
    ...extras,
  } as ProductionDoc;
}

describe('getBaseRow', () => {
  it('returns the variant_index=0 row of the group', () => {
    const rows = [
      makeRow({ script_text: 'A', group_id: 'g1', variant_index: 0, ai_image_prompt: 'base scene' }),
      makeRow({ script_text: 'B', group_id: 'g1', variant_index: 1, variant_edit_prompt: 'add hat' }),
    ];
    const base = getBaseRow(makeDoc(rows), 'g1');
    expect(base?.script_text).toBe('A');
  });

  it('returns undefined for an unknown group_id', () => {
    expect(getBaseRow(makeDoc([]), 'missing')).toBeUndefined();
  });
});

describe('getPreviousVariantRow', () => {
  const rows = [
    makeRow({ script_text: 'base', group_id: 'g1', variant_index: 0, ai_image_prompt: 'base scene' }),
    makeRow({ script_text: 'v1', group_id: 'g1', variant_index: 1, variant_edit_prompt: 'A' }),
    makeRow({ script_text: 'v2', group_id: 'g1', variant_index: 2, variant_edit_prompt: 'B' }),
    makeRow({ script_text: 'v3', group_id: 'g1', variant_index: 3, variant_edit_prompt: 'C' }),
  ];
  const doc = makeDoc(rows);

  it('returns the variant at index N-1', () => {
    expect(getPreviousVariantRow(doc, 'g1', 2)?.script_text).toBe('v1');
    expect(getPreviousVariantRow(doc, 'g1', 3)?.script_text).toBe('v2');
  });

  it('returns undefined for variant 1 (no previous variant to chain from)', () => {
    expect(getPreviousVariantRow(doc, 'g1', 1)).toBeUndefined();
  });

  it('returns undefined when the previous variant is missing from the group', () => {
    const sparse = makeDoc([
      makeRow({ script_text: 'base', group_id: 'g1', variant_index: 0, ai_image_prompt: 'base scene' }),
      makeRow({ script_text: 'v2', group_id: 'g1', variant_index: 2, variant_edit_prompt: 'B' }),
    ]);
    expect(getPreviousVariantRow(sparse, 'g1', 2)).toBeUndefined();
  });

  it('returns undefined for an empty group_id', () => {
    expect(getPreviousVariantRow(doc, '', 2)).toBeUndefined();
  });
});

describe('composeVariantEditRequest — chained variants (Phase 1.7)', () => {
  const baseRow = makeRow({
    script_text: 'base',
    group_id: 'g1',
    variant_index: 0,
    ai_image_prompt: 'A close-up of George holding a photograph at his side',
  });
  const v1Row = makeRow({
    script_text: 'v1',
    group_id: 'g1',
    variant_index: 1,
    variant_edit_prompt: 'raise the photograph to chest level',
    variant_derives_from_previous: true,
  });
  const v2Row = makeRow({
    script_text: 'v2',
    group_id: 'g1',
    variant_index: 2,
    variant_edit_prompt: 'raise the photograph to eye level',
    variant_derives_from_previous: true,
  });
  const v2Parallel = makeRow({
    script_text: 'v2-parallel',
    group_id: 'g1',
    variant_index: 2,
    variant_edit_prompt: 'add a question mark above his head',
  });
  const doc = makeDoc([baseRow, v1Row, v2Row]);

  it('appends the CHAINED_VARIANT_IDENTITY_ANCHOR when variant_derives_from_previous=true AND variant_index > 1', () => {
    const prepared = composeVariantEditRequest(doc, v2Row, 'https://r2/v1.png');
    expect(prepared.kind).toBe('ready');
    if (prepared.kind === 'ready') {
      expect(prepared.request.prompt).toContain(CHAINED_VARIANT_IDENTITY_ANCHOR);
      expect(prepared.request.prompt).toContain('eye level');
    }
  });

  it('does NOT append the anchor on variant 1 even with chain flag set (chain starts at base)', () => {
    // Variant 1 with the chain flag still falls back to the base by
    // convention — there is no "previous variant" before V1. The
    // anchor would be redundant: V1 IS editing the base directly.
    const prepared = composeVariantEditRequest(doc, v1Row, 'https://r2/base.png');
    expect(prepared.kind).toBe('ready');
    if (prepared.kind === 'ready') {
      expect(prepared.request.prompt).not.toContain(CHAINED_VARIANT_IDENTITY_ANCHOR);
    }
  });

  it('does NOT append the anchor when variant_derives_from_previous is unset (parallel default)', () => {
    const docParallel = makeDoc([baseRow, v1Row, v2Parallel]);
    const prepared = composeVariantEditRequest(docParallel, v2Parallel, 'https://r2/base.png');
    expect(prepared.kind).toBe('ready');
    if (prepared.kind === 'ready') {
      expect(prepared.request.prompt).not.toContain(CHAINED_VARIANT_IDENTITY_ANCHOR);
    }
  });

  it('does NOT append the anchor when variant_derives_from_previous=false explicitly', () => {
    const v2Explicit = { ...v2Parallel, variant_derives_from_previous: false } as ProductionRow;
    const docExplicit = makeDoc([baseRow, v1Row, v2Explicit]);
    const prepared = composeVariantEditRequest(docExplicit, v2Explicit, 'https://r2/base.png');
    expect(prepared.kind).toBe('ready');
    if (prepared.kind === 'ready') {
      expect(prepared.request.prompt).not.toContain(CHAINED_VARIANT_IDENTITY_ANCHOR);
    }
  });

  it('honors the per-group default `group_variant_chain_default = chained` when the variant own flag is unset (R5)', () => {
    // The base row sets the group default to chained; the variant
    // row leaves its own flag unset. The dispatcher should resolve
    // to chained anyway via tier 2 of the three-tier priority.
    const baseChained = { ...baseRow, group_variant_chain_default: 'chained' as const };
    const v2Inherits = { ...v2Parallel };
    delete (v2Inherits as Partial<ProductionRow>).variant_derives_from_previous;
    const docInherit = makeDoc([baseChained, v1Row, v2Inherits]);
    const prepared = composeVariantEditRequest(docInherit, v2Inherits, 'https://r2/v1.png');
    expect(prepared.kind).toBe('ready');
    if (prepared.kind === 'ready') {
      expect(prepared.request.prompt).toContain(CHAINED_VARIANT_IDENTITY_ANCHOR);
    }
  });

  it('per-variant flag still wins over the per-group default (tier 1 > tier 2)', () => {
    // Base says chained; this variant explicitly opts out. The
    // dispatcher should respect the per-variant override.
    const baseChained = { ...baseRow, group_variant_chain_default: 'chained' as const };
    const v2OptOut: ProductionRow = { ...v2Parallel, variant_derives_from_previous: false };
    const docOverride = makeDoc([baseChained, v1Row, v2OptOut]);
    const prepared = composeVariantEditRequest(docOverride, v2OptOut, 'https://r2/base.png');
    expect(prepared.kind).toBe('ready');
    if (prepared.kind === 'ready') {
      expect(prepared.request.prompt).not.toContain(CHAINED_VARIANT_IDENTITY_ANCHOR);
    }
  });

  it('CHAINED_VARIANT_IDENTITY_ANCHOR mentions the load-bearing identity guarantees', () => {
    // The anchor is the load-bearing anti-drift signal. If a future
    // refactor weakens these phrases, the chained-variants quality
    // benchmark will regress. Spot-check the explicit guarantees.
    expect(CHAINED_VARIANT_IDENTITY_ANCHOR).toContain('EXACTLY identical');
    expect(CHAINED_VARIANT_IDENTITY_ANCHOR).toContain('ORIGINAL base');
    expect(CHAINED_VARIANT_IDENTITY_ANCHOR).toContain('face, hair, clothing');
    expect(CHAINED_VARIANT_IDENTITY_ANCHOR).toMatch(/pose|motion|expression/);
  });

  it('every composed variant prompt ends with SAFE_FRAMING_EDIT_SUFFIX (2026-05-28 framing fix)', () => {
    // The variant path runs Atlas Edit at 1536×1024 → crops to 1536×864,
    // destroying 7.8% of pixels off top + bottom. Without this suffix
    // the model places character heads and bottom text in the destroy
    // band. Mirror of the auto-pipeline's generateVariantImage compose.
    const prepared = composeVariantEditRequest(doc, v1Row, 'https://r2/base.png');
    expect(prepared.kind).toBe('ready');
    if (prepared.kind === 'ready') {
      expect(prepared.request.prompt).toContain('central 70%');
      expect(prepared.request.prompt).toContain('15% empty padding from the top and bottom');
    }
  });
});

// ─── Phase 1.7 R5 — `resolveVariantChainMode` three-tier priority ────────────

describe('resolveVariantChainMode — three-tier priority (Phase 1.7 R5)', () => {
  const base: ProductionRow = makeRow({
    script_text: 'base', group_id: 'g1', variant_index: 0, ai_image_prompt: 'base scene',
  });
  const baseGroupChained: ProductionRow = { ...base, group_variant_chain_default: 'chained' };
  const baseGroupParallel: ProductionRow = { ...base, group_variant_chain_default: 'parallel' };
  const variantUnset: ProductionRow = makeRow({
    script_text: 'v', group_id: 'g1', variant_index: 2, variant_edit_prompt: 'X',
  });
  const variantTrue: ProductionRow = { ...variantUnset, variant_derives_from_previous: true };
  const variantFalse: ProductionRow = { ...variantUnset, variant_derives_from_previous: false };

  it('tier 1 wins — per-variant true → chained', () => {
    expect(resolveVariantChainMode(makeDoc([base, variantTrue]), variantTrue, base)).toBe('chained');
  });

  it('tier 1 wins — per-variant false → parallel even when group says chained', () => {
    expect(
      resolveVariantChainMode(makeDoc([baseGroupChained, variantFalse]), variantFalse, baseGroupChained),
    ).toBe('parallel');
  });

  it('tier 2 — base.group_variant_chain_default = chained, variant unset → chained', () => {
    expect(
      resolveVariantChainMode(makeDoc([baseGroupChained, variantUnset]), variantUnset, baseGroupChained),
    ).toBe('chained');
  });

  it('tier 2 — base.group_variant_chain_default = parallel beats doc-level chained', () => {
    expect(
      resolveVariantChainMode(
        makeDoc([baseGroupParallel, variantUnset], { variants_chained_by_default: true }),
        variantUnset,
        baseGroupParallel,
      ),
    ).toBe('parallel');
  });

  it('tier 3 — doc.variants_chained_by_default = true, both upper tiers unset → chained', () => {
    expect(
      resolveVariantChainMode(
        makeDoc([base, variantUnset], { variants_chained_by_default: true }),
        variantUnset,
        base,
      ),
    ).toBe('chained');
  });

  it('default — all three tiers unset → parallel', () => {
    expect(resolveVariantChainMode(makeDoc([base, variantUnset]), variantUnset, base)).toBe('parallel');
  });

  it('returns parallel when baseRow is undefined and no doc-level default', () => {
    expect(resolveVariantChainMode(makeDoc([variantUnset]), variantUnset, undefined)).toBe('parallel');
  });
});
