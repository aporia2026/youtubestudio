# Mount-time hydration of images + overlays from the history entry (Phase 3)

**Date**: 2026-05-17
**Branch**: phase-1-foundation
**Status**: approved by user, ready to implement
**Predecessors**:
  - [2026-05-17-render-state-hardening.md](2026-05-17-render-state-hardening.md) (Phase 1)
  - [2026-05-17-broll-doc-id-hydration.md](2026-05-17-broll-doc-id-hydration.md) (Phase 2)

## Goal

Close the last asset-loss gap: when `prodoc_last_result` saved partially
(quota exceeded → bundled fallback dropped overlays / clips / sometimes
images) and the user refreshes, the page should automatically restore from
the canonical server-side history entry instead of leaving rows visibly
"missing" until the user clicks the sidebar.

Phase 1 already persists `rowImages` + `rowOverlays` (+ `rowVideoClips`
clip ids) onto the history entry. Phase 1's history-sidebar restore reads
them on click. **What's missing**: a mount-time effect that does the same
thing automatically when `historyEntryId` is known but state looks empty.

## Why no new schema / API

Everything we need is already there:

- `entry.rowImages: Record<number, string>` → seeded by the persist
  effect in Phase 1 ([page.tsx](src/app/(app)/production-doc/page.tsx)).
- `entry.rowOverlays: Record<number, { status; url? }>` → same.
- `entry.rowVideoClips: Record<number, string>` → Phase 2 already covers
  clips via the DB filter `?productionDocId=…`, so we don't need to
  re-derive videoUrls from the entry. Skip clips in this phase.
- `getProductionDocHistoryCached()` is already called on page mount at
  [page.tsx:1650-1651](src/app/(app)/production-doc/page.tsx#L1650-L1651)
  to populate the sidebar. We piggyback on that — no extra fetch.

## Behavior

Add a new `useEffect` keyed on `[historyEntryId, docRowsLength, historyItems]`:

1. Bail if `historyEntryId` is null, `doc.rows` is empty, or
   `historyItems` is still loading (`length === 0`).
2. Find the entry: `historyItems.find(e => e.id === historyEntryId)`.
   Bail if none.
3. **rowImages merge**: for each row index in `entry.rowImages`, if the
   current state's row entry is missing OR has `status === 'idle'`,
   set it to `{ status: 'done', imageUrl: url }`. Leave `'done'`,
   `'loading'`, `'error'` as-is so the user's in-flight work or
   intentional clear isn't reverted.
4. **rowOverlays merge**: same idea — restore from entry only when the
   current state has no entry for that row index (or its status is
   `'idle'`). Skip `'loading'`, `'done'`, `'error'` to respect live state.
5. Use functional `setState` with a `changed` flag so the effect is a
   no-op once everything is hydrated. Idempotent across re-renders.
6. Log `[entry hydrate]` with applied counts.

## Edge cases

- **Localstorage bundle was complete** → state already has the data →
  the "only-merge-when-empty" guard makes this a no-op. ✓
- **User loaded a fresh doc (no historyEntryId)** → effect bails. ✓
- **Old history entry with no rowOverlays field** → that part of the
  merge skips. rowImages still restores. ✓
- **historyItems loads after a delay** → effect re-runs when it arrives.
  Subsequent runs are no-ops (merge already done). ✓
- **User clicked New Session mid-session** → `historyEntryId` is cleared,
  effect re-runs and bails. State stays clean. ✓
- **Race with history-sidebar click**: the sidebar click is what sets
  `setRowImages([])` then re-seeds. After the click, this effect re-runs
  with the new `historyEntryId` and merges back any rows the sidebar
  handler didn't already populate. Effectively a belt-and-braces. ✓

## Observability (rule 14)

- `[entry hydrate]` once per (historyEntryId, doc.rows-length) change:
  `{ historyEntryId, imagesFromEntry, imagesApplied, overlaysFromEntry, overlaysApplied }`.
- Skip-no-changes case logs `applied: 0` so a quiet log is visible too.

## Cost (rule 8)

Zero. Pure client-side, reads cached data.

## Security / safety (rule 13)

`entry.rowImages` / `entry.rowOverlays` are values the server returned
for this workspace's entries. Workspace-scoping is enforced at the
history fetch (existing). Length-cap on URLs not strictly necessary —
they're already R2 URLs we wrote in the first place.

## QA (rule 6)

Golden path:
1. Generate a doc with N rows. Generate stills on every row. Save (entry id).
2. DevTools → clear `prodoc_last_result` from localStorage.
3. Refresh. Bundle restore brings nothing back. Wait briefly.
4. Expect: `[entry hydrate]` log fires once `historyItems` loads,
   `rowImages` repopulates from the entry, cells show "done" stills.

Edge cases:
- User edits a row to clear the OST → mid-session, doesn't trigger re-hydration.
- User refreshes during an active image generation (`status: 'loading'`)
  → loading row preserved, completed rows hydrated.

## Files touched

- `src/app/(app)/production-doc/page.tsx` — one new effect, ~40 LOC.
