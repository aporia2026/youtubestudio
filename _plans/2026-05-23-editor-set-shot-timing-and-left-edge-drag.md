# Set shot timing — precise start/end inputs + left-edge drag

**Date**: 2026-05-23
**Author**: Yoav + Claude
**Status**: Approved (pending build)

## Goal

Let the user precisely set both edges of any scene on the timeline,
not just the trailing edge. Two surfaces:

1. **Left-edge drag handle on every card** — mirrors the existing
   right-edge resize. Dragging the left edge carves from / gives back
   to the left neighbor; total project length unchanged.
2. **"Set timing…" popover** — right-click any card → opens a popover
   with Start (m:ss), End (m:ss), Duration (s). Edit any one of the
   three; the other two derive. Apply dispatches a single atomic
   reducer command that carves from left and/or right neighbors to
   honor the requested timing.

Replaces the existing "Set duration…" context-menu entry (duration
becomes a derived field in the new popover).

## Why now

The user just inserted scene 71 between scenes 70 and 71 (via the
[insert-blank-scene plan](_plans/2026-05-23-editor-insert-blank-scene-between.md))
and immediately wanted to drag its leading edge from 5:40 back to
5:38. The current timeline has no way to do this — the only resize
handle is on the trailing edge of each card, and it follows shift
semantics (lengthens the project). Without a way to move a scene's
START, the insert-blank feature only solves half the seam-editing
problem.

## Constraints (verified from current code)

1. Scenes live in a **cascade**: scene N's `startMs` = sum of every
   previous scene's effective duration ([src/remotion/utils.ts:814-832](src/remotion/utils.ts#L814-L832)).
   You can't move a scene's start in isolation — you have to redistribute
   time across neighbors. This is the same architectural truth the
   insert-blank plan worked with.
2. **Right-edge resize today uses SHIFT semantics**: dragging extends
   the project ([src/lib/editor/store.ts case 'RESIZE_SHOT'](src/lib/editor/store.ts)).
   Changing this would be a breaking UX change for existing muscle
   memory. The new left-edge drag will use CARVE semantics (total
   length unchanged); the right-edge drag stays SHIFT. The popover
   uses CARVE on both edges (matches "precise timing" intent).
3. **EDITOR_MIN_SHOT_MS = 2000**, **EDITOR_MAX_SHOT_MS = 5 × 60 × 1000**
   ([src/lib/editor/store.ts:52,56](src/lib/editor/store.ts#L52-L56)).
   Carve from a neighbor must keep that neighbor ≥ 2 s.
4. **Voiceover is a single continuous `<Audio>` at composition root**
   (verified during the insert-blank plan). Carving + redistributing
   visual durations leaves the audio unaffected — exactly the
   "fix mismatches" property the user cares about.
5. **Right-click context menu exists** at [EditorClient.tsx:3824](src/app/(app)/edit/%5BprojectId%5D/EditorClient.tsx#L3824).
   Today it contains "Duplicate shot" and presumably "Set duration…"
   (need to confirm). The new "Set timing…" slots into the same menu.
6. **SetDurationPopover** at [src/components/editor/SetDurationPopover.tsx](src/components/editor/SetDurationPopover.tsx)
   is the existing precision input. New `SetTimingPopover` borrows
   the portal/dismiss idioms but adds three coupled inputs instead
   of one slider.
7. **Per-row maps reindex helpers** (`reindexRowImages`, `reindexRecord`)
   exist at [src/lib/editor/store.ts:452-485](src/lib/editor/store.ts#L452-L485)
   — not needed here (no row count change), noted for awareness.

## Requirements

### Functional

- **Left-edge drag**: every card gets a leftmost 8 px drag handle
  (mirrors the existing rightmost 8 px). Dragging right shortens this
  scene + lengthens the left neighbor (cap: left neighbor ≤ MAX).
  Dragging left lengthens this scene + shortens the left neighbor
  (floor: left neighbor ≥ MIN). At the project's very first scene
  (no left neighbor): handle is rendered but disabled with tooltip.
  Live preview during drag (same pattern as right-edge resize).
  Pointer-up commits a single `SET_SHOT_TIMING` command.

- **Right-click "Set timing…" popover**: opens at the cursor. Three
  fields:
  - **Start** — text input, format `m:ss` (or `mm:ss`). Defaults to
    current start.
  - **End** — text input, format `m:ss`. Defaults to current end.
  - **Duration** — number input in seconds (2 decimals). Defaults
    to current duration.
  - Editing **Start** keeps End fixed → recomputes Duration.
  - Editing **End** keeps Start fixed → recomputes Duration.
  - Editing **Duration** keeps Start fixed → recomputes End.
  - Apply / Enter dispatches `SET_SHOT_TIMING { shotIndex, startMs, endMs }`.
  - Cancel / Escape / outside-click dismisses without applying.
  - Total project length is preserved (start delta carved from left
    neighbor; end delta carved from right neighbor).

- **Clamp + tooltip on the popover's Apply path**: when the requested
  timing would push a neighbor below `EDITOR_MIN_SHOT_MS`, the reducer
  honors as much of the requested change as possible (clamp to neighbor
  floor) and the popover surfaces what actually happened in a small
  status line: "Scene 70 too short — clamped: start 5:38.5 (requested 5:38)".

- **Replace context-menu entry**: "Set duration…" goes away; "Set
  timing…" takes its place. The old `SetDurationPopover` component
  stays in the codebase (it may have other callers in future
  surfaces) but the editor shot menu no longer references it. If
  there are no other callers, it's deleted.

- **Drag + popover both feed the same reducer** (`SET_SHOT_TIMING`),
  so undo is one step regardless of how the edit was made.

- **First scene** (`shotIndex === 0`): left edge is anchored at 0 —
  cannot be moved. Drag handle disabled, popover Start field disabled.
- **Last scene** (`shotIndex === rows.length - 1`): right edge can
  extend total length when no right neighbor exists (shift fallback).
  The popover allows this and the status line notes "Extending project
  length by Xs."

### Non-functional

- The new drag handle must not fight the existing trim handle that
  sits at the leftmost `RESIZE_HANDLE_WIDTH / 2` of each card
  ([Timeline.tsx:749](src/components/editor/Timeline.tsx#L749)). Both
  handles are 6-8 px and overlap. Resolution: trim handle's z-index
  stays at 10; the new left-edge resize handle gets z 11 BUT only
  catches pointerdown — pointermove still bubbles to the trim handle
  for hover preview. Need to verify both stay usable; may need to
  collapse the trim handle into the resize handle (single drag, modifier
  key changes behavior) — flag during build.
- The popover's input parsing must accept the same formats the
  existing timecode regex parses (`parseTimecodeMs` in store.ts:1812)
  so users can paste a timecode from anywhere in the doc and have it
  work.
- The popover must survive narrow viewports (small editor windows).
  Mirror SetDurationPopover's viewport-edge clamp logic.

### Done criteria

- Every card has a draggable left edge that carves from / gives back
  to its left neighbor live, with the same ESC-cancels semantics as
  the right edge.
- Right-click any card → "Set timing…" opens a popover. Typing
  `5:38` in Start, `5:42` in End, clicking Apply: scene 71 spans
  5:38-5:42; scene 70 shrinks by the start delta; downstream visuals
  unchanged; voiceover unchanged.
- Clamping case: typing a Start that would push scene 70 below 2s
  shows the clamp tooltip + applies the maximum possible change.
- Undo restores the prior timing in one step (one undo for the whole
  operation, not separate undos for the carve + the resize).
- All reducer tests pass; full suite green; dev server starts clean.

## Chosen approach

### Reducer (`src/lib/editor/store.ts`)

New atomic command:

```ts
| {
    type: 'SET_SHOT_TIMING';
    shotIndex: number;
    /** Desired START of this shot, in ms from t=0. Clamped to
     *  `[startOf(shotIndex - 1) + MIN_SHOT_MS, currentEnd - MIN_SHOT_MS]`
     *  during apply. When shotIndex === 0, must equal 0 (the first
     *  scene's start is anchored). */
    startMs: number;
    /** Desired END of this shot, in ms from t=0. Clamped to
     *  `[startMs + MIN_SHOT_MS, …]`. When this is the last shot and
     *  the new end is past the current project total, the timeline
     *  extends (shift fallback). */
    endMs: number;
  }
```

Mutation handler builds the diff against the cascade-derived current
timing, then:

1. Compute `currentStart = sum(effectiveDuration(0..shotIndex-1))`.
2. Compute `currentEnd = currentStart + effectiveDuration(shotIndex)`.
3. `deltaStart = startMs - currentStart`.
4. `deltaEnd = endMs - currentEnd`.
5. **Left side** (if `shotIndex > 0` and `deltaStart !== 0`):
   - Left neighbor's new duration = `effectiveDuration(shotIndex - 1) + deltaStart`.
     (negative deltaStart → left grows; positive → left shrinks; wait
     that's reversed — let me re-derive: if deltaStart > 0, start
     moved RIGHT → scene starts later → left neighbor grows by
     deltaStart. If deltaStart < 0, scene starts earlier → left
     neighbor shrinks by |deltaStart|.)
   - Clamp to `[MIN_SHOT_MS, MAX_SHOT_MS]`. If clamped, adjust the
     scene's `startMs` accordingly (chosen start = current start +
     clamped delta).
6. **Right side** (if `shotIndex < rows.length - 1` and `deltaEnd !== 0`):
   - Right neighbor's new duration = `effectiveDuration(shotIndex + 1) - deltaEnd`.
     (positive deltaEnd → end moved right → right neighbor shrinks
     by deltaEnd. negative → right neighbor grows.)
   - Clamp similarly.
7. **This shot's new duration** = clampedEnd - clampedStart, also
   clamped to `[MIN_SHOT_MS, MAX_SHOT_MS]`.
8. Build new rows: set `duration_override_ms` on this shot + the
   left neighbor (if mutated) + the right neighbor (if mutated).
   Each mutated row gets `edited_at` stamped with category `'duration'`.
9. **Last-shot case** (`shotIndex === rows.length - 1` and
   `deltaEnd > 0`): no right neighbor to carve from; this is shift
   semantics — just extend this shot's duration. The result struct
   includes a `lastShotExtended: true` flag the popover reads to
   show its status line note.
10. Inverse is a single `SET_SHOT_TIMING { shotIndex, startMs:
   currentStart, endMs: currentEnd }` (restores prior timing exactly).

No-op detection: when both deltas resolve to 0 after clamping,
return unchanged state with `inverse: null`.

The handler also returns a small `result` object (NOT part of the
mutation contract — instead, dispatch via a wrapper that returns the
result to the caller via a `useRef` or callback). This is the
"actual delta" report the popover uses for its clamp tooltip.
Simpler approach: skip the result wrapper; the popover computes the
delta itself by reading state before + after.

### Drag handle (Timeline.tsx)

Mirror the existing `RESIZE_HANDLE_WIDTH = 8` right-edge handle.
Add `LEFT_RESIZE_HANDLE_WIDTH = 8` at the leftmost edge. Add to
`SortableShotCardProps`:
- `onLeadingResizePointerDown?(e)`
- `onLeadingResizePointerMove?(e)`
- `onLeadingResizePointerUp?(e)`

Hoist new state to the `Timeline` parent: `leadingResize:
LeadingResizeDragState | null`. The drag tracks `startClientX` and
`startStartMs` of the dragged shot. Each pointermove computes
`deltaPx → deltaMs`, then dispatches a live `SET_SHOT_TIMING` with
`startMs: startStartMs + deltaMs, endMs: <current endMs>` (end
unchanged during leading-edge drag).

Coexistence with trim handle (left side): trim handle sits at
`left: RESIZE_HANDLE_WIDTH / 2` and is 6 px wide. New left resize
handle at `left: 0` and 8 px wide overlaps the trim handle's
leftmost 4 px. Resolution: new resize handle has z 11; trim handle
z 10. Pointerdown on the leftmost 4 px → resize wins. Pointerdown
on the 4-10 px range → trim wins. Tooltip on each clarifies what
the user is grabbing.

If the conflict is too jarring in QA, fallback: move the trim
handle inward by 8 px so the two never overlap. Document the
decision.

### Popover (`src/components/editor/SetTimingPopover.tsx`)

New file. Reuses SetDurationPopover idioms: portal to body, dismiss
on outside mousedown + Escape, clamp to viewport.

Three coupled inputs:
- Start: text input, `m:ss` format via `formatMs` + new
  `parseHumanTimecode(value)` helper.
- End: text input, `m:ss`.
- Duration: number input, seconds (e.g., `4.5`), step 0.1.

State: `startMs`, `endMs`. Duration is computed as `endMs - startMs`.
The Duration input edits `endMs` (sets to `startMs + duration * 1000`).

Apply button:
- Disabled when fields are invalid (parse failures, end ≤ start,
  end - start < MIN_SHOT_MS, start < 0).
- On click: dispatches `SET_SHOT_TIMING` and closes the popover.
- After dispatch: read state (via a passed-in `getStateAfter` ref?)
  and compare delta vs requested → if clamped, write a one-line
  status note before closing. Actually simpler: don't try to read
  post-state — when the user clicks Apply, the popover closes
  immediately. The dispatcher (EditorClient) is responsible for
  surfacing the clamp via a brief toast. Move the clamp tooltip
  responsibility to EditorClient.

Layout: vertical stack, ~260 px wide:

```
INSERT SCENE TIMING
Start    [ 5:38   ]
End      [ 5:42   ]
Duration [ 4.0 s  ]
                    [Cancel] [Apply]
```

### EditorClient wiring

- Add `'Set timing…'` to the shot context menu, replacing 'Set
  duration…'. Position the popover at the cursor (use the existing
  context-menu coords).
- Pass `onLeadingResize` callback through TimelineV2 → Timeline
  to the SortableShotCard. Each move dispatches the live
  `SET_SHOT_TIMING`. Pointer-up commits a single non-transient
  command (the live moves use `transient: true`? — re-check how
  RESIZE_SHOT handles transient — looking at the code, it doesn't
  use transient; it dispatches every pointermove and relies on the
  reducer's no-op detection. Match that pattern: every pointermove
  fires `SET_SHOT_TIMING`, the reducer is idempotent for repeated
  values.)
- Surface clamp results: after dispatch, compare requested vs
  actual via the state's row durations. If clamped, show a 3-second
  toast using whatever toast system the editor already has (or
  console.warn if none exists — flag during build).

### Settings impact (rule 15)

The popover's defaults are derived from the current scene's timing,
not user preferences. No new settings keys. The existing carve-source
preference (`editor.insert.carveSource`) doesn't apply here because
the popover always touches both neighbors symmetrically.

Possible future settings:
- "Snap to frame boundaries" toggle (already implemented for RESIZE_SHOT
  at 30 fps via `frameStepMs` snap — reapply here)
- "Show timing in seconds vs frames" — but not for v1.

### Observability (rule 14)

Logs:
- `[editor set-shot-timing] dispatch` before each apply call
  (shotIndex, requested start/end/duration, current start/end/duration).
- `[editor set-shot-timing] clamp applied` in the reducer when the
  requested values were modified to honor MIN/MAX neighbor floors
  (shotIndex, requested vs actual deltas).
- `[editor timeline] leading-resize complete` on pointer-up
  (matches existing `[editor timeline] resize complete` format).

### Security (rule 13)

No new HTTP endpoint; reuses the existing PATCH route via the same
autosave debounce. No new user input goes to a third party. The
popover's text inputs are parsed locally; bad input is rejected
client-side and would simply fail validation (no XSS surface, no
SQL surface).

## Alternatives rejected

**Drag handle without popover (Option A from chat)**: users couldn't
type an exact timecode like "5:38". The user's specific request was
precise timing input — rejecting the popover would miss the explicit
ask.

**Popover without drag handle (Option B)**: for casual edits ("a
bit longer here") right-click + popover is friction. The drag handle
is the lazy-user path (rule 10).

**Cascade-spill into earlier scenes when the immediate neighbor
hits floor**: the user picked clamp + tooltip. Cascade-spill would
be more powerful but the rippling far-away change is exactly the
kind of "wait, why did scene 12 just change?" surprise that erodes
trust.

**Refuse with toast instead of clamp**: chosen against. Users would
have to do TWO actions (clear the toast, fix the neighbor manually,
try again). Clamping gives them SOMETHING immediately while
explaining what happened.

**Keep "Set duration…" alongside "Set timing…"**: rejected. Timing
subsumes duration. Two adjacent entries with overlapping behavior
adds menu noise.

**Change the existing right-edge drag to CARVE**: rejected. Breaks
muscle memory for users who rely on the current shift behavior.
Adding the new left-edge as CARVE is additive; changing the existing
right-edge would be subtractive.

## Open questions

1. **Trim handle overlap**: confirm during Phase 3 build whether the
   trim handle and the new left-resize handle can coexist with z-index
   layering, or whether the trim handle needs to move inward by 8 px.
2. **Toast system**: check whether the editor already has a toast
   primitive. If not, the clamp notification falls back to
   `console.warn` for v1 with a follow-up plan to add toasts.
3. **Existing "Set duration…" entry**: confirm it exists in the shot
   context menu today. If it doesn't (the menu only has Duplicate),
   "Set timing…" is purely additive — no replacement.

## Execution phases

**Phase 1** — reducer + tests. New command, mutation handler,
unit tests covering: edit start only, edit end only, edit both,
clamp from left, clamp from right, both-clamped, last-scene shift,
first-scene start-anchored, undo round-trip. ~half day.

**Phase 2** — SetTimingPopover component. Three-field coupled
inputs, timecode parsing, validation, dismiss handling. Storybook
or dev page for visual review. ~half day.

**Phase 3** — left-edge drag handle in Timeline.tsx. Mirror existing
right-edge code. Resolve trim-handle overlap. Manual QA. ~half day.

**Phase 4** — EditorClient wiring: context-menu entry swap,
popover integration, clamp surfacing. ~quarter day.

**Phase 5** — extreme QA (rule 6): walk through every scene-shape
edge case (first scene, last scene, single-row doc, scene next to
broll generating, scene with cross-fade transition_in, scene with
section_title). Dev-server smoke. ~half day.

**Total**: ~2 working days.
