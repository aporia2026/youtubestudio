/**
 * Translate an editor command into its server-side reindex side-effect
 * on the `project_assets` table. Returns null for commands that don't
 * shift row indices.
 *
 * Commands that DO shift indices:
 *   - INSERT_BLANK_SHOT       — insert a row at atIndex (shift up).
 *   - REMOVE_INSERTED_SHOT    — undo of the above; delete the row (shift down).
 *   - DELETE_SHOT (ripple)    — delete a shot and pull later shots earlier.
 *   - RESTORE_ROW (insert)    — undo of ripple delete; re-insert the row.
 *   - ADD_VARIANT_ROW         — insert a new variant slot (shift up).
 *   - REVERT_ADD_VARIANT_ROW  — undo of the above (shift down).
 *   - DELETE_VARIANT_ROW      — remove a variant slot (shift down).
 *   - RESTORE_VARIANT_ROW     — undo of the above (shift up).
 *   - SPLIT_AS_TITLE_CARD     — insert a title-card row above the source (shift up).
 *   - REVERT_SPLIT_AS_TITLE_CARD — undo of the above (shift down).
 *
 * MOVE_VARIANT_ROW swaps a pair of adjacent row indices in place. The
 * server-side table tracks slots by (project_id, row_index, slot) and
 * the swap is symmetric: image at row N moves to row N+1 AND image at
 * row N+1 moves to row N. Because the existing reindex helper only
 * supports insert/delete, swaps are intentionally NOT routed through
 * this helper — EditorClient persists the two affected slots via the
 * standard row-asset POST instead. Returning null here keeps the
 * server reindex step out of the path.
 *
 * Commands that don't shift indices (slot stays in place — just
 * content changes): DELETE_SHOT in 'blank' mode, RESTORE_ROW in
 * 'replace' mode, SET_ROW_VISUAL_TYPE, APPLY_TITLE_CARD_AS_SECTION_TITLE,
 * REVERT_APPLY_TITLE_CARD_AS_SECTION_TITLE.
 *
 * Lives in its own module so EditorClient can wire the side-effect AND
 * `tests/editor-reindex-for-command.test.ts` can pin the mapping
 * without pulling in the whole editor surface.
 *
 * See `_plans/2026-05-24-project-assets-extraction.md` §Reindex.
 */
import type { EditorCommand } from './store';

export interface AssetReindexEffect {
  op: 'insert' | 'delete';
  atIndex: number;
}

export function reindexForCommand(cmd: EditorCommand): AssetReindexEffect | null {
  switch (cmd.type) {
    case 'INSERT_BLANK_SHOT':
      return { op: 'insert', atIndex: cmd.atIndex };
    case 'REMOVE_INSERTED_SHOT':
      return { op: 'delete', atIndex: cmd.atIndex };
    case 'DELETE_SHOT':
      return cmd.mode === 'ripple' ? { op: 'delete', atIndex: cmd.shotIndex } : null;
    case 'RESTORE_ROW':
      return cmd.mode === 'insert' ? { op: 'insert', atIndex: cmd.atIndex } : null;
    case 'ADD_VARIANT_ROW':
      // The forward command inserts the variant right after the group's
      // tail — but the actual insertion index isn't part of the command
      // (it's derived from the base's group). The reducer's `selection`
      // update lands on the new row's index, which is what the server
      // reindex needs. Caller passes that selection through; if you
      // dispatch ADD_VARIANT_ROW directly, the server-side reindex
      // happens via the inverse-returned REVERT_ADD_VARIANT_ROW's
      // recorded variantIndex — see EditorClient's command dispatcher.
      // We return null here on purpose so callers route through the
      // inverse-based reindex path that DOES know the index.
      return null;
    case 'REVERT_ADD_VARIANT_ROW':
      return { op: 'delete', atIndex: cmd.variantIndex };
    case 'DELETE_VARIANT_ROW':
      return { op: 'delete', atIndex: cmd.rowIndex };
    case 'RESTORE_VARIANT_ROW':
      return { op: 'insert', atIndex: cmd.atIndex };
    case 'SPLIT_AS_TITLE_CARD':
      return { op: 'insert', atIndex: cmd.rowIndex };
    case 'REVERT_SPLIT_AS_TITLE_CARD':
      return { op: 'delete', atIndex: cmd.atIndex };
    default:
      return null;
  }
}
