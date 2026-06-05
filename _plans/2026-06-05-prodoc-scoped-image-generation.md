# Scoped image-generation batches in the Production-Doc redesign

Date: 2026-06-05
Status: approved, ready to ship
Owner: Yoav + Claude

## Goal

Give the user one-click ways to (re-)generate images for a *subset* of
rows in the current production doc, without having to click into each
row's inspector or run the whole auto-pipeline. The current RenderDock
only batches `Animate all` (image→video) and retries of failed image /
video rows; nothing scopes a *fresh* image batch by emptiness or by
shot type.

## Why now

Today's flow for "I just added 20 rows and want images for only those"
is: open each row → Image tab → Generate. Or: run the whole pipeline
and let it churn through every row sequentially. Neither is acceptable
once a doc has 300+ rows (see screenshot — `CIA Mind Control Iceberg`
doc, 306 scenes, 297 animation + 9 title card). The user explicitly
asked for: (a) re-run only images, (b) only fill empty rows, (c) scope
by shot type (motion collage / base / variants / animation).

## Requirements

1. **Scope kinds** (each is a one-click menu item with a live count):
   - `empty` — rows whose `rowImages[i].status === 'idle'` or no image
   - `failed` — rows whose `rowImages[i].status === 'error'`
   - `animation` — rows where `shot_kind !== 'motion_collage'` and
     `visual_type !== 'Title Card'`
   - `motion_collage` — rows where `shot_kind === 'motion_collage'`
   - `base_variant` — rows where `variant_index` is undefined or `0`
   - `non_base_variant` — rows where `variant_index !== undefined && > 0`
   - `title_card` — rows where `visual_type === 'Title Card'`
   - `all` — every row (destructive — confirm)
2. Each menu item shows its current row-count next to the label so the
   user knows blast radius before clicking. Items with count `0` are
   disabled with a muted style.
3. A scope that would *overwrite* existing images (`done` rows) pops
   `window.confirm` with the count first. `empty` and `failed` never
   confirm (they overwrite nothing).
4. Dispatch obeys the same per-tick cap the auto-pipeline uses (3
   concurrent per tick — see `MAX_*_PER_TICK` in AGENTS.md so the
   Vercel 300s budget stays intact when run during pipeline ticks).
5. While a scope is running, the dock shows the matching live progress
   label (same affordance as today's `batchInFlight` pattern for
   Animate-all / Retry-failed), and the dropdown is disabled.
6. Survives the existing `subMode === 'bulk-grid'` escape hatch — the
   dock is visible in both sub-modes, the dropdown works in both.

## Approach (chosen)

**Dropdown in RenderDock + confirm-once for overwriting scopes.**

### Files

1. **NEW** `src/lib/production-doc-image-scopes.ts` — pure helper
   - `export type ImageScopeKind = 'empty' | 'failed' | 'animation' | 'motion_collage' | 'base_variant' | 'non_base_variant' | 'title_card' | 'all'`
   - `getRowsMatchingScope(rows, rowImages, scope): number[]`
   - `getAllScopeCounts(rows, rowImages): Record<ImageScopeKind, number>`
     — one O(n) pass, called inside a `useMemo` in `page.tsx`
   - `scopeOverwritesExistingImages(scope): boolean` — `true` for every
     scope except `empty` and `failed`
   - `scopeLabel(scope): string` — UI label
2. **NEW** `tests/production-doc-image-scopes.test.ts` — unit tests
   covering each scope, mixed-state docs, edge cases (empty doc,
   undefined `variant_index`, undefined `rowImages[i]`).
3. **EDIT** `src/components/production-doc/redesign/RenderDock.tsx`
   - Add `imageScopeCounts?: Record<ImageScopeKind, number>` prop
   - Add `onGenerateImagesByScope?: (scope: ImageScopeKind) => void` prop
   - Add a "Generate images ▾" button next to the existing batch
     buttons. Clicking opens a popover (CSS-only, no portal) with
     two sections: state-based (Empty / Failed) and type-based
     (Animations / Motion collages / Base variants / Non-base / Title
     cards), separated by a divider, with "Re-generate ALL" at the
     bottom with a ⚠ marker. Each item shows `(N)` count.
   - Confirm-once via `window.confirm` for any scope where
     `scopeOverwritesExistingImages(scope) === true`.
   - Disabled state when `batchInFlight` is non-null OR when the
     scope's count is `0`.
4. **EDIT** `tests/prodoc-redesign-render-dock.test.tsx` — extend with
   ~6 tests: dropdown opens, items render with counts, count-0 items
   disabled, confirm fires for overwriting scopes, no-confirm for
   `empty`/`failed`, callback fires with correct kind.
5. **EDIT** `src/app/(app)/production-doc/page.tsx`
   - `useMemo` `imageScopeCounts` from `doc.rows` + `rowImages`
   - `runImageScope(scope)` writer — gathers indices, dispatches
     `generateImageForRow` with a 3-wide concurrency window via the
     same `runWithConcurrency`-style pattern the existing batch
     helpers use. Skips motion-collage rows whose panel prompts are
     all empty (logs `[prodoc image-scope] skipped no-prompts row` so
     the user can see why a count is lower than expected in logs).
   - Wires into the `renderDock` prop bundle on `ProductionDocShell`
     via the existing pass-through chain.
6. **EDIT** `src/components/production-doc/redesign/RenderDock.tsx`'s
   `RenderDockProps` interface to carry the new fields.

### Concurrency cap

Each scope dispatch runs at most 3 in-flight `generateImageForRow`
calls at any time. Existing `runRetryFailedImages` uses the same
3-wide pattern via `runWithConcurrency`. New helper does NOT introduce
a new concurrency primitive — it reuses the same one.

### Motion-collage caveat

`generateImageForRow(i, prompt)` short-circuits on empty `prompt`. For
motion_collage rows, `ai_image_prompt` is intentionally cleared on
conversion (see legacy convert-to-motion-collage code in `page.tsx`),
so the function would noop. Scopes that include motion_collage rows
will route to the collage-generation path used by today's per-row
Generate button (look up the exact function name during code — likely
`generateMotionCollageForRow` or equivalent). Rows whose
`motion_collage_panel_prompts` are still all blank are skipped with a
log line — generating an empty collage is a footgun.

## Alternatives rejected

- **Compound filter modal** (status × type × section). More powerful
  but two extra clicks for the 90% case. Defer.
- **Bulk-Grid checkboxes + "Generate selected"**. Most precise but
  forces a scroll/select-all path through the grid for "all empty".
  Defer — could layer on later if user requests row-by-row picking.
- **Always-on "Overwrite existing" toggle** in the dropdown. Less
  destructive than confirm-once, but every batch becomes two clicks.
  Confirm-once is cheaper.
- **Two menu items per scope** ("Generate empty motion collages" +
  "Re-generate ALL motion collages"). Doubles the menu length. The
  confirm modal already disambiguates.

## Security (rule 13)

- No new attack surface. The dispatch path is the existing
  `generateImageForRow` — unchanged validation, no new server route.
- "Re-generate ALL" is the only path that can destroy work in one
  click. `window.confirm` is the safety. The dropdown also reports
  counts inline so the user sees the size before they click.
- Counts derive from local `doc.rows` + `rowImages` state. No user
  input, no injection risk.

## Observability (rule 14)

Namespace: `[prodoc image-scope]`. Lines:

- `console.info('[prodoc image-scope] dropdown-open', { counts })`
- `console.info('[prodoc image-scope] scope-selected', { scope, count })`
- `console.info('[prodoc image-scope] confirm-shown', { scope, count })`
- `console.info('[prodoc image-scope] confirm-cancelled', { scope })`
- `console.info('[prodoc image-scope] scope-dispatched', { scope, rowIndices })`
- `console.info('[prodoc image-scope] skipped-no-prompt', { rowIndex, reason })`
- `console.info('[prodoc image-scope] scope-complete', { scope, succeeded, failed, skipped })`

Backend mirroring: not applicable — dispatch reuses the existing
`generateImageForRow` server path which already logs.

## Settings audit (rule 15)

Walked the feature: nothing in here is a long-term user preference. The
scopes are data-driven and the confirm is a safety net, not a default.
Nothing to add to the settings layer. Intentionally not exposed:

- "Default scope to remember on dropdown open" — premature; the menu
  shows counts so re-discovery is cheap.
- "Always confirm even on empty/failed" — paranoid; not needed.
- "Disable the ALL option" — handled by the confirm.

## Testing (rule 18)

- **Unit (pure helper)**: every scope kind, mixed-state doc, empty doc,
  undefined `variant_index`, undefined `rowImages[i]`,
  `scopeOverwritesExistingImages` matrix.
- **Component (RenderDock)**: dropdown opens, items + counts render,
  count-0 disabled, confirm fires + cancel path, callback dispatch.
- **Manual (UI)**: dev server check — dropdown placement on narrow
  viewports (the existing RenderDock fix had wrap issues; rule 6).
- Not covered by automated tests: `page.tsx` page-level integration.
  Per the existing convention for this page, page-level wiring is
  validated through the helper + component test pairs.

## Open questions

- Motion-collage dispatch function name — verify during code (see
  caveat above). If the per-row Generate button on a motion_collage
  row goes through a different helper than `generateImageForRow`, the
  scope helper picks it up via the same branch.

## Out of scope

- Video-side scoping (re-generate B-roll by type). Out of scope for
  this PR — if the user wants it later it falls out naturally from
  the same helper pattern applied to `rowVideoClips`.
- Section-level filtering (only rows in section X). Defer.
- Cross-doc scopes. Always doc-local for now.
