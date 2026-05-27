/**
 * Tests for the `reindexForCommand` pure helper that maps editor
 * commands to their server-side `project_assets` reindex side-effect.
 *
 * Pinned because the wrong mapping causes silent data drift: an
 * unintended reindex shifts every later shot's assets by one position
 * on the server, and on next refresh the user sees images on the wrong
 * shots. Equally bad is the *missing* mapping — a real insert/delete
 * that doesn't reindex leaves the server's project_assets keys out of
 * sync with the editor's view.
 *
 * See `_plans/2026-05-24-project-assets-extraction.md` §Reindex.
 */
import { describe, expect, it } from 'vitest';
import { reindexForCommand } from '@/lib/editor/reindex-for-command';
import type { EditorCommand } from '@/lib/editor/store';

describe('reindexForCommand', () => {
  it('maps INSERT_BLANK_SHOT to insert at the same atIndex', () => {
    const cmd: EditorCommand = {
      type: 'INSERT_BLANK_SHOT',
      atIndex: 5,
      mode: 'shift',
      durationMs: 2000,
    };
    expect(reindexForCommand(cmd)).toEqual({ op: 'insert', atIndex: 5 });
  });

  it('maps REMOVE_INSERTED_SHOT to delete at the same atIndex', () => {
    const cmd: EditorCommand = {
      type: 'REMOVE_INSERTED_SHOT',
      atIndex: 5,
    };
    expect(reindexForCommand(cmd)).toEqual({ op: 'delete', atIndex: 5 });
  });

  it('maps DELETE_SHOT ripple to delete at shotIndex', () => {
    const cmd: EditorCommand = { type: 'DELETE_SHOT', shotIndex: 3, mode: 'ripple' };
    expect(reindexForCommand(cmd)).toEqual({ op: 'delete', atIndex: 3 });
  });

  it('returns null for DELETE_SHOT blank (slot stays in place)', () => {
    const cmd: EditorCommand = { type: 'DELETE_SHOT', shotIndex: 3, mode: 'blank' };
    expect(reindexForCommand(cmd)).toBeNull();
  });

  it('maps RESTORE_ROW insert to insert at the same atIndex', () => {
    const cmd: EditorCommand = {
      type: 'RESTORE_ROW',
      atIndex: 2,
      row: {
        timecode: '',
        script_text: '',
        visual_type: '',
        visual_description: '',
        stock_search_terms: '',
        ai_image_prompt: '',
        on_screen_text: '',
        notes: '',
      },
      rowImageUrl: null,
      mode: 'insert',
    };
    expect(reindexForCommand(cmd)).toEqual({ op: 'insert', atIndex: 2 });
  });

  it('returns null for RESTORE_ROW replace (overwrites slot, no shift)', () => {
    const cmd: EditorCommand = {
      type: 'RESTORE_ROW',
      atIndex: 2,
      row: {
        timecode: '',
        script_text: '',
        visual_type: '',
        visual_description: '',
        stock_search_terms: '',
        ai_image_prompt: '',
        on_screen_text: '',
        notes: '',
      },
      rowImageUrl: null,
      mode: 'replace',
    };
    expect(reindexForCommand(cmd)).toBeNull();
  });

  it('returns null for unrelated commands', () => {
    const commands: EditorCommand[] = [
      { type: 'SET_SELECTION', shotIndex: 1 },
      { type: 'UNDO' },
      { type: 'REDO' },
      { type: 'SET_ROW_IMAGE', shotIndex: 0, url: 'https://example.com/a.png' },
      { type: 'MARK_SAVED', version: 1, savedAt: Date.now() },
      { type: 'SYNC_SERVER_VERSION', version: 2 },
    ];
    for (const cmd of commands) {
      expect(reindexForCommand(cmd), `for ${cmd.type}`).toBeNull();
    }
  });

  // ── variant commands ────────────────────────────────────────────
  // ADD_VARIANT_ROW intentionally returns null because the insert
  // index is derived from the doc at dispatch time, not embedded in
  // the command. EditorClient computes the position from state.doc +
  // the base index and calls the server reindex directly. The inverse
  // (REVERT_ADD_VARIANT_ROW) DOES carry the index so undo works
  // through the standard reindexForCommand path.

  it('returns null for ADD_VARIANT_ROW (caller computes insert index)', () => {
    expect(reindexForCommand({ type: 'ADD_VARIANT_ROW', baseIndex: 4 })).toBeNull();
  });

  it('maps REVERT_ADD_VARIANT_ROW to delete at variantIndex', () => {
    expect(
      reindexForCommand({
        type: 'REVERT_ADD_VARIANT_ROW',
        variantIndex: 7,
      }),
    ).toEqual({ op: 'delete', atIndex: 7 });
  });

  it('maps DELETE_VARIANT_ROW to delete at rowIndex', () => {
    expect(
      reindexForCommand({ type: 'DELETE_VARIANT_ROW', rowIndex: 12 }),
    ).toEqual({ op: 'delete', atIndex: 12 });
  });

  it('maps RESTORE_VARIANT_ROW to insert at atIndex', () => {
    expect(
      reindexForCommand({
        type: 'RESTORE_VARIANT_ROW',
        atIndex: 5,
        row: {
          timecode: '',
          script_text: '',
          visual_type: '',
          visual_description: '',
          stock_search_terms: '',
          ai_image_prompt: '',
          on_screen_text: '',
          notes: '',
          group_id: 'g-1',
          variant_index: 2,
        },
        rowImageUrl: null,
      }),
    ).toEqual({ op: 'insert', atIndex: 5 });
  });

  it('returns null for MOVE_VARIANT_ROW (swap, not splice)', () => {
    expect(
      reindexForCommand({ type: 'MOVE_VARIANT_ROW', rowIndex: 3, direction: 'down' }),
    ).toBeNull();
  });

  // ── title-card commands ─────────────────────────────────────────

  it('maps SPLIT_AS_TITLE_CARD to insert at rowIndex', () => {
    expect(
      reindexForCommand({
        type: 'SPLIT_AS_TITLE_CARD',
        rowIndex: 8,
        heading: 'Section 1',
      }),
    ).toEqual({ op: 'insert', atIndex: 8 });
  });

  it('maps REVERT_SPLIT_AS_TITLE_CARD to delete at atIndex', () => {
    expect(
      reindexForCommand({
        type: 'REVERT_SPLIT_AS_TITLE_CARD',
        atIndex: 8,
        sourceRowIndex: 9,
        restoreScriptText: '## Section 1 — body',
      }),
    ).toEqual({ op: 'delete', atIndex: 8 });
  });

  it('returns null for SET_ROW_VISUAL_TYPE (slot stays in place)', () => {
    expect(
      reindexForCommand({
        type: 'SET_ROW_VISUAL_TYPE',
        rowIndex: 4,
        visualType: 'Title Card',
        promoteFields: true,
      }),
    ).toBeNull();
  });

  it('returns null for APPLY_TITLE_CARD_AS_SECTION_TITLE (no slot shift)', () => {
    expect(
      reindexForCommand({
        type: 'APPLY_TITLE_CARD_AS_SECTION_TITLE',
        rowIndex: 0,
      }),
    ).toBeNull();
    expect(
      reindexForCommand({
        type: 'REVERT_APPLY_TITLE_CARD_AS_SECTION_TITLE',
        restore: [{ rowIndex: 1, priorSectionTitle: undefined }],
      }),
    ).toBeNull();
  });
});
