/**
 * Translate an editor command into its server-side reindex side-effect
 * on the `project_assets` table. Returns null for commands that don't
 * shift row indices.
 *
 * The four commands that DO shift indices:
 *   - INSERT_BLANK_SHOT    — insert a row at atIndex (shift up).
 *   - REMOVE_INSERTED_SHOT — undo of the above; delete the row (shift down).
 *   - DELETE_SHOT (ripple) — delete a shot and pull later shots earlier.
 *   - RESTORE_ROW (insert) — undo of ripple delete; re-insert the row.
 *
 * DELETE_SHOT in 'blank' mode and RESTORE_ROW in 'replace' mode keep
 * the row slot in place (just blank/restore content) and need no
 * reindex.
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
    default:
      return null;
  }
}
