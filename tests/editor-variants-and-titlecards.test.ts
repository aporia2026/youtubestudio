/**
 * Reducer tests for the variant + title-card editor commands added by
 * _plans/2026-05-27-editor-variants-titles-notes.md.
 *
 * Covers the editing-command surface that mutates `doc.rows`:
 *   - ADD_VARIANT_ROW  (+ REVERT_ADD_VARIANT_ROW inverse via UNDO)
 *   - DELETE_VARIANT_ROW (+ RESTORE_VARIANT_ROW inverse via UNDO)
 *   - MOVE_VARIANT_ROW (self-inverse with direction flipped)
 *   - SET_ROW_VISUAL_TYPE (with `promoteFields` Title Card path)
 *   - SPLIT_AS_TITLE_CARD (+ REVERT_SPLIT_AS_TITLE_CARD inverse)
 *   - APPLY_TITLE_CARD_AS_SECTION_TITLE (+ REVERT inverse)
 *
 * The reducer is pure — tests construct a minimal EditorState, apply
 * a command, and assert on the returned state shape + the inverse's
 * round-trip behavior via UNDO. No React / store wiring.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  initialEditorState,
  type EditorState,
} from '@/lib/editor/store';
import type { ProductionDoc } from '@/remotion/utils';

type Row = ProductionDoc['rows'][number];

function makeRow(overrides: Partial<Row>): Row {
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

function makeDoc(rows: Row[], overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    title: 'test',
    niche: 'test',
    total_duration: '5:00',
    total_words: 0,
    speaking_pace_wpm: 150,
    rows,
    ...overrides,
  };
}

function makeState(rows: Row[], rowImages: Record<number, string> = {}): EditorState {
  return initialEditorState({
    doc: makeDoc(rows),
    rowImages,
    version: 1,
  });
}

// ── ADD_VARIANT_ROW ──────────────────────────────────────────────

describe('ADD_VARIANT_ROW', () => {
  it('promotes a standalone row and inserts a variant directly after it', () => {
    const state = makeState([
      makeRow({ ai_image_prompt: 'A cat on a mat', visual_type: 'Animation', visual_description: 'cat' }),
      makeRow({ ai_image_prompt: 'next scene' }),
    ]);
    const next = applyCommand(state, { type: 'ADD_VARIANT_ROW', baseIndex: 0 });
    expect(next.doc.rows).toHaveLength(3);

    // Base got promoted with group_id + variant_index: 0
    const base = next.doc.rows[0];
    expect(base.group_id).toBeTruthy();
    expect(base.variant_index).toBe(0);
    expect(base.ai_image_prompt).toBe('A cat on a mat'); // unchanged

    // New variant inserted at index 1
    const variant = next.doc.rows[1];
    expect(variant.group_id).toBe(base.group_id);
    expect(variant.variant_index).toBe(1);
    expect(variant.variant_edit_prompt).toBe('');
    expect(variant.ai_image_prompt).toBe(''); // empty by design — dispatcher composes
    expect(variant.visual_type).toBe(base.visual_type); // cloned
    expect(variant.visual_description).toBe(base.visual_description); // cloned

    // Selection lands on the new variant
    expect(next.selection).toBe(1);
    // Sibling "next scene" pushed to index 2
    expect(next.doc.rows[2].ai_image_prompt).toBe('next scene');
  });

  it('extends an existing group by inserting after the last variant', () => {
    const gid = 'g-existing';
    const state = makeState([
      makeRow({ ai_image_prompt: 'A', group_id: gid, variant_index: 0 }),
      makeRow({ group_id: gid, variant_index: 1, variant_edit_prompt: 'smile' }),
      makeRow({ ai_image_prompt: 'unrelated' }),
    ]);
    const next = applyCommand(state, { type: 'ADD_VARIANT_ROW', baseIndex: 0 });
    expect(next.doc.rows).toHaveLength(4);
    // Variant slotted in at index 2, right after the existing variant
    expect(next.doc.rows[2].group_id).toBe(gid);
    expect(next.doc.rows[2].variant_index).toBe(2);
    // Unrelated row pushed to index 3
    expect(next.doc.rows[3].ai_image_prompt).toBe('unrelated');
  });

  it('refuses when the group is at MAX_VARIANTS_PER_GROUP (4)', () => {
    const gid = 'g-full';
    const state = makeState([
      makeRow({ group_id: gid, variant_index: 0 }),
      makeRow({ group_id: gid, variant_index: 1 }),
      makeRow({ group_id: gid, variant_index: 2 }),
      makeRow({ group_id: gid, variant_index: 3 }),
    ]);
    const next = applyCommand(state, { type: 'ADD_VARIANT_ROW', baseIndex: 0 });
    expect(next.doc.rows).toHaveLength(4); // no insert
    expect(next.isDirty).toBe(false); // no-op shouldn't dirty
  });

  it('UNDO restores TRUE standalone (un-promotes base AND removes variant)', () => {
    const state = makeState([
      makeRow({ ai_image_prompt: 'X' }),
    ]);
    const after = applyCommand(state, { type: 'ADD_VARIANT_ROW', baseIndex: 0 });
    expect(after.doc.rows).toHaveLength(2);
    expect(after.doc.rows[0].group_id).toBeTruthy(); // promoted

    const undone = applyCommand(after, { type: 'UNDO' });
    expect(undone.doc.rows).toHaveLength(1);
    // Critical: base must be FULLY standalone again — no dangling group_id
    expect(undone.doc.rows[0].group_id).toBeUndefined();
    expect(undone.doc.rows[0].variant_index).toBeUndefined();
    expect(undone.doc.rows[0].ai_image_prompt).toBe('X'); // untouched
  });

  it('UNDO of extension keeps base group_id intact', () => {
    const gid = 'g-keep';
    const state = makeState([
      makeRow({ group_id: gid, variant_index: 0 }),
      makeRow({ group_id: gid, variant_index: 1 }),
    ]);
    const after = applyCommand(state, { type: 'ADD_VARIANT_ROW', baseIndex: 0 });
    const undone = applyCommand(after, { type: 'UNDO' });
    expect(undone.doc.rows).toHaveLength(2);
    // Base + existing variant unchanged
    expect(undone.doc.rows[0].group_id).toBe(gid);
    expect(undone.doc.rows[0].variant_index).toBe(0);
    expect(undone.doc.rows[1].variant_index).toBe(1);
  });
});

// ── DELETE_VARIANT_ROW ───────────────────────────────────────────

describe('DELETE_VARIANT_ROW', () => {
  it('removes the variant and re-numbers the remainder 1..N-1', () => {
    const gid = 'g-1';
    const state = makeState([
      makeRow({ group_id: gid, variant_index: 0 }),
      makeRow({ group_id: gid, variant_index: 1, variant_edit_prompt: 'v1' }),
      makeRow({ group_id: gid, variant_index: 2, variant_edit_prompt: 'v2' }),
      makeRow({ group_id: gid, variant_index: 3, variant_edit_prompt: 'v3' }),
    ]);
    const next = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 2 });
    expect(next.doc.rows).toHaveLength(3);
    // v1 stays at index 1, v3 slides into index 2 and renumbers to 2
    expect(next.doc.rows[1].variant_edit_prompt).toBe('v1');
    expect(next.doc.rows[1].variant_index).toBe(1);
    expect(next.doc.rows[2].variant_edit_prompt).toBe('v3');
    expect(next.doc.rows[2].variant_index).toBe(2);
  });

  it('refuses on base rows (variant_index === 0)', () => {
    const gid = 'g-base';
    const state = makeState([
      makeRow({ group_id: gid, variant_index: 0 }),
      makeRow({ group_id: gid, variant_index: 1 }),
    ]);
    const next = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 0 });
    expect(next.doc.rows).toHaveLength(2); // no-op
    expect(next.isDirty).toBe(false);
  });

  it('reindexes rowImages around the removed slot', () => {
    const gid = 'g-img';
    const state = makeState(
      [
        makeRow({ group_id: gid, variant_index: 0 }),
        makeRow({ group_id: gid, variant_index: 1 }),
        makeRow({ group_id: gid, variant_index: 2 }),
        makeRow({ ai_image_prompt: 'after' }),
      ],
      { 0: 'BASE', 1: 'V1', 2: 'V2', 3: 'AFTER' },
    );
    const next = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 1 });
    // V1 dropped, V2 shifts down to slot 1, AFTER shifts down to slot 2
    expect(next.rowImages).toEqual({ 0: 'BASE', 1: 'V2', 2: 'AFTER' });
  });

  it('UNDO restores the deleted variant and renumbers back', () => {
    const gid = 'g-undo';
    const state = makeState([
      makeRow({ group_id: gid, variant_index: 0 }),
      makeRow({ group_id: gid, variant_index: 1, variant_edit_prompt: 'v1' }),
      makeRow({ group_id: gid, variant_index: 2, variant_edit_prompt: 'v2' }),
    ]);
    const after = applyCommand(state, { type: 'DELETE_VARIANT_ROW', rowIndex: 1 });
    expect(after.doc.rows).toHaveLength(2);
    expect(after.doc.rows[1].variant_edit_prompt).toBe('v2');
    expect(after.doc.rows[1].variant_index).toBe(1); // renumbered

    const undone = applyCommand(after, { type: 'UNDO' });
    expect(undone.doc.rows).toHaveLength(3);
    expect(undone.doc.rows[1].variant_edit_prompt).toBe('v1');
    expect(undone.doc.rows[1].variant_index).toBe(1);
    expect(undone.doc.rows[2].variant_edit_prompt).toBe('v2');
    expect(undone.doc.rows[2].variant_index).toBe(2);
  });
});

// ── MOVE_VARIANT_ROW ─────────────────────────────────────────────

describe('MOVE_VARIANT_ROW', () => {
  it('swaps adjacent variants in the same group + updates variant_index', () => {
    const gid = 'g-move';
    const state = makeState([
      makeRow({ group_id: gid, variant_index: 0, ai_image_prompt: 'base' }),
      makeRow({ group_id: gid, variant_index: 1, variant_edit_prompt: 'A' }),
      makeRow({ group_id: gid, variant_index: 2, variant_edit_prompt: 'B' }),
    ]);
    const next = applyCommand(state, { type: 'MOVE_VARIANT_ROW', rowIndex: 1, direction: 'down' });
    expect(next.doc.rows[1].variant_edit_prompt).toBe('B');
    expect(next.doc.rows[1].variant_index).toBe(1);
    expect(next.doc.rows[2].variant_edit_prompt).toBe('A');
    expect(next.doc.rows[2].variant_index).toBe(2);
  });

  it('refuses to move past the base (variant_index = 1 going up)', () => {
    const gid = 'g-base';
    const state = makeState([
      makeRow({ group_id: gid, variant_index: 0 }),
      makeRow({ group_id: gid, variant_index: 1 }),
    ]);
    const next = applyCommand(state, { type: 'MOVE_VARIANT_ROW', rowIndex: 1, direction: 'up' });
    expect(next.isDirty).toBe(false);
  });

  it('swaps rowImages along with the rows', () => {
    const gid = 'g-img';
    const state = makeState(
      [
        makeRow({ group_id: gid, variant_index: 0 }),
        makeRow({ group_id: gid, variant_index: 1 }),
        makeRow({ group_id: gid, variant_index: 2 }),
      ],
      { 0: 'BASE', 1: 'A', 2: 'B' },
    );
    const next = applyCommand(state, { type: 'MOVE_VARIANT_ROW', rowIndex: 1, direction: 'down' });
    expect(next.rowImages).toEqual({ 0: 'BASE', 1: 'B', 2: 'A' });
  });

  it('UNDO swaps back', () => {
    const gid = 'g-undo';
    const state = makeState([
      makeRow({ group_id: gid, variant_index: 0 }),
      makeRow({ group_id: gid, variant_index: 1, variant_edit_prompt: 'A' }),
      makeRow({ group_id: gid, variant_index: 2, variant_edit_prompt: 'B' }),
    ]);
    const after = applyCommand(state, { type: 'MOVE_VARIANT_ROW', rowIndex: 1, direction: 'down' });
    const undone = applyCommand(after, { type: 'UNDO' });
    expect(undone.doc.rows[1].variant_edit_prompt).toBe('A');
    expect(undone.doc.rows[2].variant_edit_prompt).toBe('B');
  });
});

// ── SET_ROW_VISUAL_TYPE ──────────────────────────────────────────

describe('SET_ROW_VISUAL_TYPE', () => {
  it('changes visual_type without touching other fields', () => {
    const state = makeState([
      makeRow({ visual_type: 'Animation', ai_image_prompt: 'cat' }),
    ]);
    const next = applyCommand(state, {
      type: 'SET_ROW_VISUAL_TYPE',
      rowIndex: 0,
      visualType: 'Statistics',
    });
    expect(next.doc.rows[0].visual_type).toBe('Statistics');
    expect(next.doc.rows[0].ai_image_prompt).toBe('cat'); // untouched
  });

  it('with promoteFields: Title Card, runs the production-doc promotion side-effects', () => {
    const state = makeState([
      makeRow({
        visual_type: 'Animation',
        ai_image_prompt: 'detailed prompt',
        visual_description: 'an animation of a cat',
        stock_search_terms: 'cat,feline',
        script_text: 'The Quick Brown Fox',
        on_screen_text: '',
        notes: 'prior note',
      }),
    ]);
    const next = applyCommand(state, {
      type: 'SET_ROW_VISUAL_TYPE',
      rowIndex: 0,
      visualType: 'Title Card',
      promoteFields: true,
    });
    const r = next.doc.rows[0];
    expect(r.visual_type).toBe('Title Card');
    expect(r.ai_image_prompt).toBe(''); // cleared
    expect(r.stock_search_terms).toBe(''); // cleared
    expect(r.on_screen_text).toBe('The Quick Brown Fox'); // promoted from script
    expect(r.visual_description).toContain('Title card displaying'); // synthesized
    expect(r.notes).toContain('prior note');
    expect(r.notes).toContain('backup-from-promote'); // prior prompt preserved
  });

  it('UNDO of promotion restores every clobbered field', () => {
    const original = makeRow({
      visual_type: 'Animation',
      ai_image_prompt: 'detailed prompt',
      visual_description: 'desc',
      stock_search_terms: 'tags',
      script_text: 'TITLE',
      on_screen_text: 'OST',
      notes: 'note',
    });
    const state = makeState([original]);
    const after = applyCommand(state, {
      type: 'SET_ROW_VISUAL_TYPE',
      rowIndex: 0,
      visualType: 'Title Card',
      promoteFields: true,
    });
    const undone = applyCommand(after, { type: 'UNDO' });
    expect(undone.doc.rows[0]).toMatchObject({
      visual_type: 'Animation',
      ai_image_prompt: 'detailed prompt',
      visual_description: 'desc',
      stock_search_terms: 'tags',
      on_screen_text: 'OST',
      notes: 'note',
    });
  });

  it('no-ops when the new visual_type matches and promoteFields is falsy', () => {
    const state = makeState([makeRow({ visual_type: 'Animation' })]);
    const next = applyCommand(state, {
      type: 'SET_ROW_VISUAL_TYPE',
      rowIndex: 0,
      visualType: 'Animation',
    });
    expect(next.isDirty).toBe(false);
  });
});

// ── SPLIT_AS_TITLE_CARD ──────────────────────────────────────────

describe('SPLIT_AS_TITLE_CARD', () => {
  it('extracts a leading ## heading into a new Title Card row above', () => {
    const state = makeState([
      makeRow({
        script_text: '## Chapter One\n\nThe story begins here.',
        visual_type: 'Animation',
        ai_image_prompt: 'old prompt',
      }),
    ]);
    const next = applyCommand(state, {
      type: 'SPLIT_AS_TITLE_CARD',
      rowIndex: 0,
      heading: 'Chapter One',
    });
    expect(next.doc.rows).toHaveLength(2);
    // Title card row inserted at 0
    expect(next.doc.rows[0].visual_type).toBe('Title Card');
    expect(next.doc.rows[0].on_screen_text).toBe('Chapter One');
    // Source row pushed to 1, script stripped of heading
    expect(next.doc.rows[1].script_text).toBe('The story begins here.');
    expect(next.doc.rows[1].ai_image_prompt).toBe('old prompt'); // untouched
  });

  it('handles the heading WITHOUT a leading ## (user-typed shorthand)', () => {
    const state = makeState([
      makeRow({ script_text: 'Chapter Two: more story' }),
    ]);
    const next = applyCommand(state, {
      type: 'SPLIT_AS_TITLE_CARD',
      rowIndex: 0,
      heading: 'Chapter Two',
    });
    expect(next.doc.rows[1].script_text).toBe('more story');
  });

  it('no-ops when the heading is not present in script_text', () => {
    const state = makeState([
      makeRow({ script_text: 'some unrelated text' }),
    ]);
    const next = applyCommand(state, {
      type: 'SPLIT_AS_TITLE_CARD',
      rowIndex: 0,
      heading: 'Not Found',
    });
    expect(next.doc.rows).toHaveLength(1);
    expect(next.isDirty).toBe(false);
  });

  it('UNDO removes the title card AND restores source script_text', () => {
    const original = '## Heading\n\nbody';
    const state = makeState([makeRow({ script_text: original })]);
    const after = applyCommand(state, {
      type: 'SPLIT_AS_TITLE_CARD',
      rowIndex: 0,
      heading: 'Heading',
    });
    const undone = applyCommand(after, { type: 'UNDO' });
    expect(undone.doc.rows).toHaveLength(1);
    expect(undone.doc.rows[0].script_text).toBe(original);
  });

  it('reindexes rowImages around the inserted title-card slot', () => {
    const state = makeState(
      [
        makeRow({ script_text: '## Heading\nbody' }),
        makeRow({ ai_image_prompt: 'next' }),
      ],
      { 0: 'A', 1: 'B' },
    );
    const next = applyCommand(state, {
      type: 'SPLIT_AS_TITLE_CARD',
      rowIndex: 0,
      heading: 'Heading',
    });
    // The source row (which had image A) moved from 0 to 1; downstream
    // row moved from 1 to 2. Title card slot at 0 is empty.
    expect(next.rowImages).toEqual({ 1: 'A', 2: 'B' });
  });
});

// ── APPLY_TITLE_CARD_AS_SECTION_TITLE ────────────────────────────

describe('APPLY_TITLE_CARD_AS_SECTION_TITLE', () => {
  it('propagates the title-card text to downstream rows until next Title Card', () => {
    const state = makeState([
      makeRow({ visual_type: 'Title Card', on_screen_text: 'Chapter 1' }),
      makeRow({ script_text: 'scene a' }),
      makeRow({ script_text: 'scene b' }),
      makeRow({ visual_type: 'Title Card', on_screen_text: 'Chapter 2' }),
      makeRow({ script_text: 'scene c' }),
    ]);
    const next = applyCommand(state, {
      type: 'APPLY_TITLE_CARD_AS_SECTION_TITLE',
      rowIndex: 0,
    });
    expect(next.doc.rows[1].section_title).toBe('Chapter 1');
    expect(next.doc.rows[2].section_title).toBe('Chapter 1');
    // Stops BEFORE the next Title Card
    expect(next.doc.rows[3].section_title).toBeUndefined();
    expect(next.doc.rows[4].section_title).toBeUndefined();
  });

  it('falls back to script_text when on_screen_text is empty', () => {
    const state = makeState([
      makeRow({ visual_type: 'Title Card', script_text: 'Chapter Fallback' }),
      makeRow({ script_text: 'a' }),
    ]);
    const next = applyCommand(state, {
      type: 'APPLY_TITLE_CARD_AS_SECTION_TITLE',
      rowIndex: 0,
    });
    expect(next.doc.rows[1].section_title).toBe('Chapter Fallback');
  });

  it('refuses on a non-Title-Card row', () => {
    const state = makeState([
      makeRow({ visual_type: 'Animation', script_text: 'x' }),
      makeRow({}),
    ]);
    const next = applyCommand(state, {
      type: 'APPLY_TITLE_CARD_AS_SECTION_TITLE',
      rowIndex: 0,
    });
    expect(next.isDirty).toBe(false);
  });

  it('UNDO restores prior section_titles (including undefined ones)', () => {
    const state = makeState([
      makeRow({ visual_type: 'Title Card', on_screen_text: 'Chapter 1' }),
      makeRow({ section_title: 'EXISTING' }),
      makeRow({}),
    ]);
    const after = applyCommand(state, {
      type: 'APPLY_TITLE_CARD_AS_SECTION_TITLE',
      rowIndex: 0,
    });
    expect(after.doc.rows[1].section_title).toBe('Chapter 1');
    expect(after.doc.rows[2].section_title).toBe('Chapter 1');

    const undone = applyCommand(after, { type: 'UNDO' });
    expect(undone.doc.rows[1].section_title).toBe('EXISTING');
    expect(undone.doc.rows[2].section_title).toBeUndefined();
  });
});
