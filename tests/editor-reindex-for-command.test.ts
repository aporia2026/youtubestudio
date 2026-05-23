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
});
