/**
 * Tests for the ripple-safety bookkeeping added to DELETE_VARIANT_ROW
 * on 2026-06-07, alongside the matching DELETE_SHOT change.
 *
 * The reducer now stamps `duration_override_ms` on the left neighbor +
 * last row AND shifts later timecodes left — but only for rows with
 * parseable timecodes (so empty-timecode decorative variants are a
 * no-op, preserving the existing variant-test fixtures).
 *
 * Coverage:
 *   - Variants with empty timecodes (the common case) — no stamp, no
 *     shift, variant renumbering unaffected.
 *   - A variant with an EXPLICIT timecode (rare) — neighbor stamping
 *     fires + later timecodes ripple left.
 *   - UNDO restores both the deleted variant AND clears the stamped
 *     overrides + restores timecodes.
 */

import { describe, expect, it } from 'vitest';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import {
  applyCommand,
  initialEditorState,
  type EditorState,
} from '@/lib/editor/store';

function row(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '',
    script_text: '',
    visual_type: 'Animation',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...overrides,
  };
}

function makeDoc(rows: ProductionRow[], totalDuration = '5:00'): ProductionDoc {
  return {
    title: 'T',
    niche: 'N',
    total_duration: totalDuration,
    total_words: 100,
    speaking_pace_wpm: 150,
    rows,
  };
}

function makeState(rows: ProductionRow[]): EditorState {
  return initialEditorState({
    doc: makeDoc(rows),
    rowImages: {},
    version: 1,
  });
}

describe('DELETE_VARIANT_ROW — empty-timecode variants (common case)', () => {
  it('does NOT stamp duration_override_ms on neighbors when the deleted variant has no timecode', () => {
    const gid = 'g-1';
    const state = makeState([
      row({ group_id: gid, variant_index: 0, timecode: '0:00' }),
      row({ group_id: gid, variant_index: 1 }), // empty tc
      row({ group_id: gid, variant_index: 2 }), // empty tc
      row({ group_id: gid, variant_index: 3 }), // empty tc — will be deleted
    ]);
    const next = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 3 });
    expect(next.doc.rows).toHaveLength(3);
    // Empty-timecode siblings stay overrideless — the cascade behaviour
    // for them is unchanged.
    expect(next.doc.rows[1].duration_override_ms).toBeUndefined();
    expect(next.doc.rows[2].duration_override_ms).toBeUndefined();
  });

  it('leaves the base row\'s duration alone for empty-timecode deletions', () => {
    const gid = 'g-1';
    const state = makeState([
      row({ group_id: gid, variant_index: 0, timecode: '0:00' }),
      row({ group_id: gid, variant_index: 1 }), // will be deleted
      row({ group_id: gid, variant_index: 2 }),
    ]);
    const next = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 1 });
    // Base's tc is parseable but the DELETED row had no tc → deletedEffMs=0,
    // so no ripple happens regardless of the base being eligible.
    expect(next.doc.rows[0].duration_override_ms).toBeUndefined();
    expect(next.doc.rows[0].timecode).toBe('0:00');
  });

  it('still renumbers the remaining variants 1..N-1', () => {
    const gid = 'g-1';
    const state = makeState([
      row({ group_id: gid, variant_index: 0 }),
      row({ group_id: gid, variant_index: 1, variant_edit_prompt: 'v1' }),
      row({ group_id: gid, variant_index: 2, variant_edit_prompt: 'v2' }),
      row({ group_id: gid, variant_index: 3, variant_edit_prompt: 'v3' }),
    ]);
    const next = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 2 });
    expect(next.doc.rows[1].variant_edit_prompt).toBe('v1');
    expect(next.doc.rows[1].variant_index).toBe(1);
    expect(next.doc.rows[2].variant_edit_prompt).toBe('v3');
    expect(next.doc.rows[2].variant_index).toBe(2);
  });
});

describe('DELETE_VARIANT_ROW — explicit-timecode variant (rare ripple case)', () => {
  it('stamps the left neighbor + last row when deleting a variant with a real timecode', () => {
    const gid = 'g-1';
    // Variant carries a real 30s timecode → the cascade DOES feel its
    // deletion and the ripple machinery has to kick in.
    const state = makeState([
      row({ group_id: gid, variant_index: 0, timecode: '0:00' }),
      row({ group_id: gid, variant_index: 1, timecode: '0:30' }), // delete this
      row({ group_id: gid, variant_index: 2, timecode: '1:00' }),
      row({ group_id: gid, variant_index: 3, timecode: '1:30' }),
    ]);
    const next = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 1 });
    // Base (left neighbor) and final variant get stamped.
    expect(next.doc.rows[0].duration_override_ms).toBe(30_000);
    expect(next.doc.rows[next.doc.rows.length - 1].duration_override_ms).toBeDefined();
    // Later timecodes shifted left by 30s.
    expect(next.doc.rows[1].timecode).toBe('0:30');
    expect(next.doc.rows[2].timecode).toBe('1:00');
  });

  it('undo restores the deleted variant + clears stamped overrides + restores timecodes', () => {
    const gid = 'g-1';
    const state = makeState([
      row({ group_id: gid, variant_index: 0, timecode: '0:00' }),
      row({ group_id: gid, variant_index: 1, timecode: '0:30', variant_edit_prompt: 'v1' }),
      row({ group_id: gid, variant_index: 2, timecode: '1:00', variant_edit_prompt: 'v2' }),
    ]);
    const after = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 1 });
    expect(after.doc.rows).toHaveLength(2);
    expect(after.doc.rows[0].duration_override_ms).toBe(30_000); // stamped

    const undone = applyCommand(after, { type: 'UNDO' });
    expect(undone.doc.rows).toHaveLength(3);
    expect(undone.doc.rows[0].duration_override_ms).toBeUndefined(); // cleared
    expect(undone.doc.rows[0].timecode).toBe('0:00');
    expect(undone.doc.rows[1].variant_edit_prompt).toBe('v1');
    expect(undone.doc.rows[1].variant_index).toBe(1);
    expect(undone.doc.rows[2].variant_edit_prompt).toBe('v2');
    expect(undone.doc.rows[2].variant_index).toBe(2);
    expect(undone.doc.rows[2].timecode).toBe('1:00');
  });
});
