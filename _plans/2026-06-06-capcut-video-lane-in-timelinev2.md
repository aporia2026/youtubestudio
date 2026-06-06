# Bring the CapCut video lane into TimelineV2

**Date:** 2026-06-06
**Status:** Awaiting approval
**Owner:** info@flexelent.com (yoavm7-code)

## Goal

Replace the inner shot-card video timeline at [src/components/editor/Timeline.tsx](../src/components/editor/Timeline.tsx) with a CapCut-style timeline (driven by `@xzdarcy/react-timeline-editor`) **inside** the existing multi-lane TimelineV2 shell at [src/components/editor/timeline-v2/TimelineV2.tsx](../src/components/editor/timeline-v2/TimelineV2.tsx), so the legacy `/edit/[projectId]` editor gets the same CapCut interaction model the new `/timeline-editor/[id]` page already uses.

**Out of scope:**

- Replacing the legacy editor's command-pipeline state with the new `useDocHistory` snapshot model. The CapCut lane will dispatch existing commands (`RESIZE_SHOT`, `SPLIT_SHOT`, etc.), not call the pure mutation helpers.
- Migrating voiceover-segment cut/trim into the legacy editor's AudioLane. Voiceover stays read-only in the legacy editor for now; the AudioLane keeps its existing wavesurfer waveform.
- Deleting `Timeline.tsx`. We swap the import inside TimelineV2 first and verify no other callers depend on it before removing.
- Touching the new `/timeline-editor/[id]` page. It keeps using its own snapshot model.

## Constraints

- The legacy editor's command pipeline ([src/lib/editor/store.ts](../src/lib/editor/store.ts)) stays the source of truth. Every drag, click, split, reorder dispatches a `EditorCommand` via `apply(cmd)`.
- Selection, playhead, and undo continue to flow through `useEditorStore`. The CapCut lane is a controlled component: it reads `selection`, `playheadMs`, `videoConfig` from props and fires callbacks; it owns no editor state.
- ShotInspector, SetTimingPopover, captions panel, overlays panel, brush-mask takeover all keep working unchanged.
- The TimelineV2 shell (audio waveform lane, captions lane, overlays lane, minimap, ruler, shared horizontal scroll, shared playhead) stays.

## Why this matters

`/edit/[projectId]` is the power-user editor — it has ShotInspector, brush masks, region zooms, motion-collage thumbnails, captions, overlays. The shot-card video lane is the only surface the user touches that doesn't have CapCut-style drag-trim / split / reorder UX. After today's audio-repeat fix, that's now the biggest UX gap between the two editor pages, and the legacy editor is the one a real user spends the most time in.

## Feature parity audit

The legacy `<Timeline>` exposes 12 interaction props the parent wires to commands. The new `<TimelineEditor>` exposes 6. Migration must preserve every legacy feature OR explicitly defer it with a reason. Honest gap analysis:

| Legacy `<Timeline>` prop | Legacy command | New `<TimelineEditor>` analogue | Action |
|---|---|---|---|
| `onSelect(shotIndex)` | `SET_SELECTION` | `onClickAction` | ✅ wire |
| `onResize(shotIndex, durationMs)` (right edge) | `RESIZE_SHOT` | `onActionResizing` (right) | ✅ wire |
| `onLeadingResize(shotIndex, startMs)` (left edge) | `SET_SHOT_TIMING` | `onActionResizing` (left) | ✅ wire — library exposes `dir: 'left' \| 'right'` |
| `onReorder(fromIndex, toIndex)` | `REORDER_SHOTS` | `onActionMoveEnd` + `targetIndexFromDropMs` | ✅ wire |
| `onTrim(shotIndex, { trimStartMs, trimEndMs })` (B-roll source trim) | `PATCH_ROW` | none — separate concept | ⚠️ port handles or defer (see below) |
| `onToggleTransition(shotIndex, kind)` (cross-fade) | `PATCH_ROW` (`transition_in`) | `setRowTransitionIn` mutation helper | ⚠️ port to context menu or per-card toggle |
| `splitAvailableShotIndex` + `onSplit()` (scissors at playhead) | `SPLIT_SHOT` | `S` keyboard shortcut | ⚠️ port the visible button affordance |
| `onShotContextMenu(shotIndex, x, y)` (right-click) | delegated | none | ⚠️ port the contextmenu event |
| `onInsertScene(atIndex, mode, carveFrom)` + seam "+" buttons | `INSERT_BLANK_SHOT` | none | ⚠️ port |
| `rowImages[]` (thumbnail per shot) | — | `data.imageUrl` (string only) | ✅ extend `data` shape |
| `rowTrims[]` (visible head/tail trim handles) | — | none | ⚠️ port handles or defer |
| `rowTransitions[]` (per-card cross-fade glyph) | — | shows via badge text only | ✅ extend `data` shape |

**Verdict:** 6 features port cleanly (✅), 6 need work (⚠️). Estimate: 2–3 focused days, not ~1.

## Phased plan

### Phase 1 — Adapter + skeleton (half day)

1. Create `src/components/editor/timeline-v2/CapCutVideoLane.tsx`. Same prop surface as legacy `<Timeline>`; takes the same callbacks; internally renders `<TimelineLib>` from `@xzdarcy/react-timeline-editor`.
2. Build a local doc-to-rows adapter that mirrors `timeline-data-adapter.ts:docToTimelineRows` but uses the LEGACY video config (`config.shots[]`) as the source of truth instead of `doc.rows[]`. Reason: the legacy editor's `videoConfig.shots[].startMs` may already include alignment + cascade + pin overrides, so reading from there matches what the Player plays. The new editor reads `doc.rows` directly because alignment isn't in the timeline editor path.
3. Wire `onClickAction` → `onSelect(shotIndex)`.
4. Wire `onActionResizing` with `dir === 'right'` → `onResize(shotIndex, durationMs)`.
5. Wire `onActionResizing` with `dir === 'left'` → `onLeadingResize(shotIndex, startMs)`.
6. Wire `onActionMoveEnd` → compute `toIndex` from drop position, call `onReorder`.
7. Swap the import in TimelineV2.tsx: `Timeline` → `CapCutVideoLane`. Don't delete `Timeline.tsx` yet.
8. Smoke-test in the browser. The ShotInspector, SetTimingPopover, audio waveform, captions, overlays, minimap should all still work; only the video lane's visual + interaction model changes.

**Acceptance:** every legacy interaction still works (resize, leading-resize, reorder, select). Tests for `editor-pin-duration`, `editor-set-shot-timing`, `editor-insert-blank-shot`, `editor-reindex-for-command`, `editor-variants-and-titlecards` all stay green.

### Phase 2 — Affordances on top of the library (half day)

The library doesn't natively render a right-click menu, a scissors button, or a "+" seam affordance. Build them as DOM overlays positioned by reading the library's `start`/`end` (px coordinates). All three are positioned absolutely inside the lane container.

1. **Context menu**: listen for `onContextMenu` on each clip (via the library's action renderer) → call `onShotContextMenu(shotIndex, x, y)`. Same prop shape as legacy.
2. **Scissors at playhead**: render an absolutely-positioned button at `playheadMs → pixels` when `splitAvailableShotIndex` is non-null. Click → `onSplit()`. Visible inside the selected card only.
3. **Insert-scene affordance**: render "+" buttons between clips (the library renders seams between actions; overlay our button on each seam). Click → `onInsertScene(atIndex, mode)` with the same menu the legacy editor uses today (carve-left / carve-right / shift).

**Acceptance:** right-click works on every clip; scissors button appears + cuts; "+" seam buttons appear + insert blank shots.

### Phase 3 — Head/tail trim handles + transition toggle (half day)

These are subtle. The legacy editor has two SEPARATE concepts that look like resize but mean different things:
- **Resize** (RESIZE_SHOT): change the shot's `duration_override_ms` — how long the scene plays.
- **Head/tail trim** (`trim_start_ms` / `trim_end_ms`): for B-roll clips, trim source seconds OFF the front/back without changing the scene duration. Implemented as inset handles 6px wide.

The library's resize is the first concept only. Port the head/tail trim as DOM overlays similar to the scissors button:

1. Render two thin handles inset 6px from the left/right edges of any clip whose `visual_type === 'broll'` (or has `video_url`).
2. Drag handle → `onTrim(shotIndex, { trimStartMs })` or `{ trimEndMs }`.
3. Cross-fade glyph: small badge inside each clip showing the `transition_in` indicator + an icon-button that fires `onToggleTransition`. Same look as today's `<Timeline>` cross-fade marker.

**Acceptance:** existing tests for `RESIZE_SHOT`, `SET_SHOT_TIMING` still pass; new test: head/tail trim drag dispatches `PATCH_ROW { trim_start_ms }`; cross-fade toggle dispatches `PATCH_ROW { transition_in }`.

### Phase 4 — Removal + cleanup (quick)

1. Confirm no other component imports `src/components/editor/Timeline.tsx`. If clean, delete the file and its CSS.
2. Delete `MotionCollageThumb`, `TitleCardThumb` only if they're not referenced anywhere else (they probably are — keep them).
3. Update TimelineV2's docstring to point at `CapCutVideoLane.tsx`.

**Acceptance:** `git grep "from '@/components/editor/Timeline'"` returns zero hits.

## Mapping the per-tick mutation pattern to commands

The new timeline-editor's mutations fire on every drag tick (`commit: false`) and commit on drag-end. The legacy editor's commands push to undo on every dispatch — there's no `commit: false` mode. This is the only real architectural friction.

**Solution:** the CapCut lane batches via a local `pendingCmd` ref. During `onActionResizing` we update local visual state only (no dispatch). On `onActionResizeEnd` we dispatch the single `RESIZE_SHOT` with the final value, going into undo as one command. This matches the current `<Timeline>`'s "live dispatch every move, store dedupes" behavior at the user-visible level, and avoids 60 `RESIZE_SHOT` entries flooding the undo stack per second.

The legacy `<Timeline>` dispatches `onResize` on every pointermove because [src/lib/editor/store.ts:903-927](../src/lib/editor/store.ts) detects no-ops via object identity and short-circuits. Verify the same no-op detection works for the new library's events; if not, use `requestAnimationFrame`-throttled dispatch to keep the undo stack clean.

## Mapping cont'd: drag-reorder

- Legacy: `@dnd-kit` sortable, fires `onDragEnd` with `(active.id, over.id)` → parent maps ids to indices, dispatches `REORDER_SHOTS`.
- New: library's `onActionMoveEnd` fires with `{ action, start }` in seconds → use `targetIndexFromDropMs(doc, fromIndex, dropMs)` (already in timeline-data-adapter.ts) to compute `toIndex`.

`targetIndexFromDropMs` already walks the unified cascade intervals after the 2026-06-06 unification. ✅ reusable.

## Observability (per rule 14)

Every new event dispatch gets a `[capcut-video-lane <event>]` log line:

- `[capcut-video-lane select]` — `{ shotIndex, fromUser }`.
- `[capcut-video-lane resize end]` — `{ shotIndex, durationMs, edge }`.
- `[capcut-video-lane split]` — `{ shotIndex, splitAtMs, validSplit }`.
- `[capcut-video-lane reorder]` — `{ fromIndex, toIndex, dropMs }`.
- `[capcut-video-lane trim end]` — `{ shotIndex, trimStartMs, trimEndMs }`.
- `[capcut-video-lane context menu]` — `{ shotIndex, x, y }`.
- `[capcut-video-lane insert]` — `{ atIndex, mode, durationMs }`.

Pair with the existing `[editor <COMMAND>]` logs (already emitted by the store) so a "I dragged X and nothing happened" report can be diagnosed end-to-end from console.

## Settings audit (per rule 15)

- **Timeline zoom (pixelsPerSecond)**: legacy editor settings already store this in `editor.timeline.pixelsPerSecond`. Pass through to the library's `scale` prop. No new setting.
- **Lane heights**: already in `editor.timeline.laneHeights.*`. Keep.
- **Show scissors at playhead**: new toggle? Defer — the existing UX is "show when split is valid", which is non-configurable and feels right.
- **Default insert-scene duration**: already in `editor.timeline.insertSceneDefaultDurationMs`. Keep.
- **Cross-fade default transition**: already exists. Keep.

No new settings introduced.

## Security & safety (per rule 13)

- The lane is a controlled component reading server-validated state. No new attack surface.
- The library is third-party (`@xzdarcy/react-timeline-editor`, ~2 years old, ~200 stars) — already a project dependency for the new timeline-editor page. No new supply-chain risk.
- All command dispatches go through the existing store; clamps + no-op detection live there. The lane can't bypass the store's invariants.

## Testing (per rule 18)

### Tests that must stay green unchanged

- `tests/editor-pin-duration.test.ts` (18 cases)
- `tests/editor-set-shot-timing.test.ts` (20 cases)
- `tests/editor-insert-blank-shot.test.ts`
- `tests/editor-reindex-for-command.test.ts`
- `tests/editor-variants-and-titlecards.test.ts`
- `tests/timeline-mutations.test.ts`, `tests/timeline-data-adapter.test.ts` (new editor still uses these)

These cover the command pipeline's invariants. Since the CapCut lane is a thin event adapter dispatching the same commands, no test in this list should need updating.

### New tests

- `tests/capcut-video-lane-adapter.test.ts` — pure adapter testing:
  - Drag-right-edge with given `end` seconds → emitted `RESIZE_SHOT` has correct `shotIndex` + `durationMs`.
  - Drag-left-edge → emitted `SET_SHOT_TIMING` has correct `shotIndex` + `startMs`, `endMs` unchanged.
  - `onActionMoveEnd` at drop position X → emitted `REORDER_SHOTS` has correct `fromIndex`/`toIndex` (uses unified `targetIndexFromDropMs`).
  - `S` key with valid split target → emitted `SPLIT_SHOT` has correct `shotIndex` + `splitAtMs`.
- Manual QA pass on `/edit/[projectId]` for: every existing interaction (select, resize, leading-resize, reorder, head/tail trim, transition toggle, scissors, context menu, insert-scene) survives the swap.

### Manual QA checklist

- [ ] Click a shot card → selection moves; ShotInspector populates.
- [ ] Drag right edge to shrink → duration updates; Player previews the new length.
- [ ] Drag left edge → start shifts; previous shot extends.
- [ ] Drag clip body horizontally → reorder lands on the nearest seam.
- [ ] Press S over a valid split target → shot splits; both halves carry `pin_duration: true`.
- [ ] Right-click a shot → context menu opens at cursor.
- [ ] Click "+" between two clips → insert-scene dropdown opens.
- [ ] Hover a B-roll clip → head/tail trim handles appear.
- [ ] Toggle cross-fade transition → glyph appears on the clip; Player crossfades.
- [ ] Undo (Cmd+Z) on a resize → returns to pre-drag duration.
- [ ] Redo (Cmd+Shift+Z) → reapplies.

## Risks

1. **Library prop ergonomics differ.** `@xzdarcy/react-timeline-editor` may not expose the events I need with the granularity I want. **Mitigation:** Phase 1 validates this against a small fixture before Phase 2 invests in affordances. If the library can't deliver, fall back to the existing `<Timeline>` (revert is one git revert).

2. **Per-tick dispatch could flood undo.** Already analyzed; mitigation is drag-end commit only.

3. **Sub-shots (variants) and multi-shot rows.** Some legacy ProductionRows expand into multiple shots (variants, title cards). The legacy `<Timeline>` handles this with `MotionCollageThumb` and `TitleCardThumb` per shot. The library only knows about `actions` per `row`. **Mitigation:** map each shot to one action regardless of which doc row produced it, keyed by `videoConfig.shots[i]`. The thumbnail rendering swaps from React components to image URLs (passed via `data.imageUrl`).

4. **Drag-reorder of variant siblings.** Reorder must respect variant boundaries. **Mitigation:** the existing `REORDER_SHOTS` command already enforces this — the CapCut lane just dispatches; the store rejects illegal moves with a console.warn.

5. **Audio sync.** The lane is decoupled from audio playback. **No risk** — audio comes through the YouTubeVideo composition; this is a UI-only change.

## Alternatives rejected

1. **Drop the legacy editor entirely, promote `/timeline-editor` to the main editor.** Means porting ShotInspector, SetTimingPopover, captions, overlays, brush mask, region zoom onto the snapshot state. Multi-week migration. Cleanest end state but far too risky right now.

2. **Leave them parallel.** Cheapest, but every new feature has to be shipped twice.

3. **Use the new editor's `useDocHistory` snapshot model inside the legacy editor.** Means rewriting the existing command pipeline. Loses the legacy command pipeline's invariants (which catch bugs the snapshot model can't). Strong no.

## Open questions

1. **Reorder strategy: drop-only or per-tick?** Legacy is drop-only (`REORDER_SHOTS` on `onDragEnd`). The library can do either. **Default: drop-only.** Matches legacy + avoids undo-stack pollution.

2. **Should the CapCut lane preserve the existing thumbnail rendering (MotionCollageThumb, TitleCardThumb)?** The library accepts arbitrary React children per action via a render-prop. **Default: yes — pass MotionCollageThumb / TitleCardThumb as render-prop returns so motion clips and title cards still look right.** Not vanilla rectangles.

3. **Does TimelineV2's existing minimap stay?** **Yes** — it's a separate component, unaffected.

4. **What does the user see during a drag — live preview or only on drop?** The new editor previews live (calls `onActionResizing` every frame). The legacy editor also previews live (dispatches `RESIZE_SHOT` on every move). **Default: keep live preview** so the Player reflects the drag in real time. Per-tick dispatch is fine because the store deduplicates identical values.

## What I need from you before starting

- Approval to start Phase 1 (the half-day skeleton + swap).
- A confirmation on Open Question 1 (drop-only reorder, default yes).
- A confirmation on Open Question 4 (live preview during drag, default yes).
