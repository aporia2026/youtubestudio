/**
 * Auto-rebase a local `ProjectPayload` on top of a remote one.
 *
 * Phase 3 of `_plans/2026-06-05-strengthen-doc-editor-sync.md`.
 *
 * The user's chosen UX (Decision C) is: when two tabs are dirty and
 * one of them commits first, the other tab silently re-applies its
 * local edits on top of the freshly-loaded remote payload, with a
 * 3-second toast "Merged a change from another tab" so the user
 * knows it happened. No banner, no "reload or continue" choice.
 *
 * This file owns the merge logic. `useProject` tracks which top-level
 * payload fields the user has touched since the last successful save
 * (`dirtyFieldsRef`); on conflict it loads the remote payload, calls
 * `rebasePayload(remote, local, dirtyFields)`, and PATCHes the result.
 *
 * Per-field semantics:
 *
 * - Fields in `dirtyFields` keep the LOCAL value (user's edits win
 *   for that field). For `doc.rows[]` this is last-write-wins at the
 *   whole-array level — the user is overwriting any concurrent row
 *   edits the remote made. We accept that trade-off in this pass
 *   because per-row merge needs row IDs, which is out of scope.
 *
 * - Every other field takes the REMOTE value. The remote tab's edits
 *   to those fields are picked up automatically.
 *
 * Pure function — no React, no DOM, no side effects. Unit-tested in
 * `tests/rebase-payload.test.ts`.
 */
import type { ProjectPayload } from './payload';

/**
 * Merge `localPayload`'s dirty fields on top of `remotePayload`.
 *
 * @param remotePayload  The fresh payload just fetched from the server.
 *                       Returned by `/api/edit/<id>` GET.
 * @param localPayload   The hook's in-memory payload — may have local
 *                       edits that haven't reached the server yet.
 *                       When `null`, the function returns `remotePayload`
 *                       unchanged (nothing to rebase).
 * @param dirtyFields    Top-level `ProjectPayload` field names the
 *                       user has touched since the last successful
 *                       save. Empty array → returns remote unchanged.
 *                       Unknown / unrecognized names are silently
 *                       ignored (defensive; the hook controls the
 *                       set).
 *
 * @returns A new payload object. Never mutates inputs.
 */
export function rebasePayload(
  remotePayload: ProjectPayload,
  localPayload: ProjectPayload | null,
  dirtyFields: ReadonlyArray<string>,
): ProjectPayload {
  if (!localPayload || dirtyFields.length === 0) {
    return remotePayload;
  }
  const rebased: Record<string, unknown> = { ...remotePayload };
  const local = localPayload as unknown as Record<string, unknown>;
  for (const k of dirtyFields) {
    if (k === 'version') continue; // version always belongs to the server
    if (!Object.prototype.hasOwnProperty.call(local, k)) continue;
    // QA fix (2026-06-05) — server-authoritative sub-field handling.
    // `flags.rowLockedAsStill` merges per-key on the server (Phase 4).
    // If the rebase also preserves the local flags wholesale, a stale
    // local lock map can resurrect a row another tab just unlocked
    // because the next PATCH would round-trip the stale value through
    // the LWW per-key merge. Special-case flags so we keep local's
    // other booleans (animateScenes / suppressLowerThirds /
    // overlaysDisabled — all per-doc toggles the user owns) but defer
    // to remote for the lock map (which is conceptually shared).
    if (k === 'flags') {
      const localFlags = local.flags as Record<string, unknown> | null | undefined;
      const remoteFlags = (remotePayload as unknown as Record<string, unknown>).flags as
        | Record<string, unknown>
        | null
        | undefined;
      if (localFlags && remoteFlags) {
        rebased.flags = {
          ...localFlags,
          rowLockedAsStill: remoteFlags.rowLockedAsStill,
        };
        continue;
      }
    }
    rebased[k] = local[k];
  }
  return rebased as unknown as ProjectPayload;
}

/**
 * Merge two `flags.rowLockedAsStill` maps server-side.
 *
 * Phase 4 sync (2026-06-05). Used by `saveProjectPatch` to combine
 * the current server map with the incoming patch so two tabs locking
 * different rows don't race-overwrite each other.
 *
 * Behavior: incoming wins for any key it specifies, server's keys
 * for rows the incoming patch doesn't mention survive.
 *
 * Known limitation (Phase 1b territory): the client today represents
 * an unlock by DELETING the key, not by sending `false`. So an
 * incoming map of `{}` doesn't tell the server "the user just
 * unlocked everything" vs "this client never touched any of the
 * locks." Under this merge, the latter wins — server's locks survive
 * an empty incoming map. Phase 1b will make the client send explicit
 * `false` for unlocks so the merge can distinguish.
 */
export function mergeRowLockedAsStill(
  serverMap: Record<number, boolean>,
  incomingMap: Record<number, boolean>,
): Record<number, boolean> {
  return { ...serverMap, ...incomingMap };
}
