# Insert blank scene between existing scenes (timeline "+" affordance)

**Date**: 2026-05-23
**Author**: Yoav + Claude
**Status**: Approved (pending build)

---

## Goal

Let the editor user insert a new blank scene between any two existing scenes
on the timeline by clicking a "+" affordance that appears when hovering the
seam between scene cards. Two insert modes:

- **Carve** (default): the new scene steals duration from a neighbor; total
  project length unchanged; downstream visuals stay aligned with their
  voiceover. This is the "fix a mismatch at this seam" mode.
- **Shift**: the new scene adds time; total project length grows; downstream
  visuals slide later in absolute time, voiceover plays through. This is the
  "I want more breathing room" mode.

The user explicitly wants both — carve is the primary use case ("fix
mismatches"), shift is the secondary.

## Why now

The screenshot showed scenes 69 and 70 on the timeline with no way to add a
scene between them. The editor today supports append-style cloning
(`DUPLICATE_SHOT`) but no seam-based insertion. Users are blocked when the
voiceover narration jumps ahead of the visuals at a specific moment and they
need to slot a corrective visual into that gap.

## Constraints (verified from current code)

1. Voiceover is a single continuous `<Audio>` at the composition root
   ([src/remotion/compositions/YouTubeVideo.tsx:173-179](src/remotion/compositions/YouTubeVideo.tsx#L173-L179)).
   Inserting a visual row does NOT mutate the audio — audio plays straight
   through. Confirmed: no per-row chunks, no `startFrom`/`endAt`.
2. `duration_override_ms` on a row wins over alignment
   ([src/remotion/utils.ts:814-832](src/remotion/utils.ts#L814-L832)).
   `realignVideoConfig` remaps within the override structure but does not
   null it out.
3. Row-keyed maps (`rowImages`, `rowOverlays`, `rowVideoClips`) must be
   reindexed when a row is inserted. Helper exists:
   [reindexRecord at src/lib/editor/store.ts:465](src/lib/editor/store.ts#L465).
4. Minimum shot duration is `EDITOR_MIN_SHOT_MS = 2000`
   ([src/lib/editor/store.ts:52](src/lib/editor/store.ts#L52)), mirroring
   `DEFAULT_MIN_SCENE_MS = 2000` in the renderer. Carve must never push a
   neighbor below this floor.
5. Two timeline UIs ship today: [Timeline.tsx](src/components/editor/Timeline.tsx)
   (v1) and [timeline-v2/TimelineV2.tsx](src/components/editor/timeline-v2/TimelineV2.tsx)
   (v2). Both need the affordance.
6. Edits go through `applyCommand` → reducer → undo stack → 800ms autosave
   PATCH to `/api/edit/[projectId]`
   ([src/lib/editor/store.ts](src/lib/editor/store.ts),
   [use-editor-store.tsx:44](src/lib/editor/use-editor-store.tsx#L44)).
   Insertion must integrate with this flow — no bypass paths.

## Requirements

### Functional

- Hovering the gap between any two adjacent scene cards (v1 or v2) reveals
  a vertical "+" button at the seam, height ≈ card height, width ≈ 14px,
  centered on the seam line.
- Clicking "+" opens a small popover with two buttons:
  - **"Carve from neighbor"** (default, prominent)
  - **"Add 2s of new time"**
- Pressing Enter (or clicking outside) commits the default (carve).
- Clicking either button dispatches `INSERT_BLANK_SHOT` and closes the
  popover. The new scene is selected. The popover dismisses on outside
  click and on Escape.
- A "+" also appears before scene 0 (insert at start) and after the last
  scene (insert at end). Insert-at-end has no carve neighbor on the right,
  so the popover only shows "Add new time" (carve disabled with tooltip
  "No right neighbor — use Add new time"). Insert-at-start is symmetric
  for the left case in carve mode (carves from index 0).
- Carve mode rules:
  - Carve from the **right neighbor** by default.
  - Carve amount: `min(2000ms, neighborDuration - EDITOR_MIN_SHOT_MS)`. If
    the right neighbor cannot give even 1ms while staying ≥ 2000ms, fall
    back to the left neighbor. If neither neighbor can give, carve is
    disabled and the button shows a tooltip explaining why; only "Add new
    time" remains clickable.
  - The neighbor's `duration_override_ms` is set to its prior effective
    duration minus the carve amount. The new row gets
    `duration_override_ms` equal to the carve amount.
- Shift mode rules:
  - New row gets `duration_override_ms = 2000` (or user's setting).
  - No neighbor mutation.
- New row defaults:
  - `script_text: ''`
  - `timecode: ''` (will be recomputed by the cascade)
  - No image (`rowImages[newIndex]` unset)
  - No broll (`rowVideoClips[newIndex]` unset)
  - No overlays (`rowOverlays[newIndex]` unset)
  - `edited_at`: stamped to now (so re-gen passes know it was user-touched
    and do not overwrite it)
- Insert is fully undoable. `INSERT_BLANK_SHOT` inverse is a custom
  rollback that removes the inserted row AND restores the carved
  neighbor's prior `duration_override_ms` (or removes the override if
  the neighbor had none before).
- After insert, all downstream row-keyed maps shift by +1 (uses
  `reindexRecord`).
- Save flow: dispatch flips `isDirty`, the 800ms debounce PATCHes the
  new doc shape. No new endpoint needed.

### Non-functional

- Hover affordance must not cause layout shift when revealed (use
  `position: absolute` on the "+" overlay, not flow layout).
- Hover detection must work even when scrolling horizontally
  (the v2 timeline is virtualized — verify the seam zone tracks the
  scrollLeft of the strip).
- Popover must be keyboard-accessible (Tab into buttons, Esc to close,
  Enter to commit default). ARIA: `role="dialog"`, `aria-label="Insert
  scene at position N"`.
- Touch users: long-press on the seam (≥500ms) opens the popover. Tap-
  outside-popover closes it.
- Reducer mutation must be pure and fast (<1ms for typical 100-row docs).

## Chosen approach (Option C from chat)

One reducer action, two modes, popover UI shared by both timeline
implementations.

### Reducer (`src/lib/editor/store.ts`)

New command type, sibling to `DUPLICATE_SHOT`:

```ts
| {
    type: 'INSERT_BLANK_SHOT';
    /** Position to insert at. Valid range: [0, rows.length].
     *  0 = before first row; rows.length = after last row. */
    atIndex: number;
    mode: 'carve' | 'shift';
    /** Desired duration of the new row, in ms. Default 2000.
     *  In carve mode, clamped to what the chosen neighbor can give. */
    durationMs: number;
    /** Carve mode only. 'right' tries right neighbor first;
     *  'left' tries left first; 'auto' picks the larger.
     *  Ignored in shift mode. */
    carveFrom?: 'left' | 'right' | 'auto';
  }
```

New mutation handler `case 'INSERT_BLANK_SHOT'`:

1. Validate `atIndex` in `[0, rows.length]`. Out-of-range → no-op.
2. Compute the blank row from a small factory function
   `makeBlankRow(stampEditedAt)`. Copies the project's default
   `min_scene_ms` consideration via the renderer-side cascade — the row
   itself just needs `script_text: ''`, `timecode: ''`,
   `edited_at: stampEditedAt()`, and `duration_override_ms` (see step 4).
3. If `mode === 'carve'`:
   a. Find candidate neighbors: right (`rows[atIndex]` after the splice
      point) and left (`rows[atIndex - 1]`).
   b. For each candidate, compute its effective duration via the same
      logic the timeline uses for display (read
      `duration_override_ms` if set; else derive from cascade). Use a
      helper `getEffectiveRowDurationMs(state, rowIndex)` — extract from
      the existing timeline logic into a shared util.
   c. Pick the carve source per `carveFrom`. If chosen source can't
      yield `EDITOR_MIN_SHOT_MS` worth of slack, try the other side.
      If neither can, return a no-op with a console warn and a result
      flag the UI can read to show a toast.
   d. Compute `carveAmount = min(durationMs, sourceDuration - EDITOR_MIN_SHOT_MS)`.
   e. Patch the source row's `duration_override_ms` to
      `sourceDuration - carveAmount`. Remember the prior value for the
      inverse.
   f. New row's `duration_override_ms = carveAmount`.
4. If `mode === 'shift'`: new row's
   `duration_override_ms = max(durationMs, EDITOR_MIN_SHOT_MS)`. No
   neighbor mutation.
5. Splice the new row into `rows` at `atIndex`.
6. Reindex `rowImages`, `rowOverlays`, `rowVideoClips` via
   `reindexRecord(map, atIndex, +1)`.
7. Update selection to the new index.
8. Build inverse: `{ type: 'REMOVE_INSERTED_BLANK_SHOT', atIndex,
   restoreNeighborOverride?: { rowIndex, value | undefined } }`.

New inverse handler `case 'REMOVE_INSERTED_BLANK_SHOT'`:
1. Remove `rows[atIndex]`.
2. Reindex maps with `reindexRecord(map, atIndex, -1)`.
3. If `restoreNeighborOverride` is present: set/clear the neighbor's
   `duration_override_ms`. Be careful that the neighbor's index is the
   one in the POST-removal `rows` (because removing shifted indices).
4. Inverse of the inverse is the original `INSERT_BLANK_SHOT` with
   exact-fit `durationMs` so a redo restores the exact prior state.

Add `INSERT_BLANK_SHOT` to the `isEditingCommand` switch ([src/lib/editor/store.ts:402](src/lib/editor/store.ts#L402))
so it lands on the undo stack and triggers `isDirty`.

### Shared UI component (`src/components/editor/InsertSceneAffordance.tsx`)

New small component, used by both v1 and v2 timelines.

```tsx
interface Props {
  atIndex: number;          // insertion position in rows
  leftNeighbor?: { index: number; effectiveDurationMs: number };
  rightNeighbor?: { index: number; effectiveDurationMs: number };
  onInsert: (mode: 'carve' | 'shift', carveFrom?: 'left' | 'right') => void;
  defaultDurationMs: number;
}
```

- Renders the "+" hover affordance and the popover.
- Computes whether carve is possible per neighbor (the slack check).
- Disables the carve button with a tooltip when neither neighbor has
  enough slack.
- Calls `onInsert` with the chosen mode; parent dispatches.
- Uses the project's existing popover primitive
  (Radix `Popover`, if used — verify by searching the editor for
  existing popover usage; if absent, use a small portaled `<div>` with
  click-outside detection).

### Timeline wiring

**v1** ([src/components/editor/Timeline.tsx](src/components/editor/Timeline.tsx)):
- For each adjacent pair of cards, render an `<InsertSceneAffordance>`
  positioned absolutely between them. Width 14px, centered on the seam.
- Also render one at the start (before card 0) and one at the end.
- Hand it the effective durations from whatever helper the existing
  resize/drag logic uses.

**v2** ([src/components/editor/timeline-v2/TimelineV2.tsx](src/components/editor/timeline-v2/TimelineV2.tsx)):
- Same component, positioned in the ShotsLane at each seam.
- Verify the seam tracks horizontal scroll.

### Hook layer (`src/lib/editor/use-editor-store.tsx`)

No new exports needed — the existing `dispatch`/`apply` interface is
sufficient. Add the namespaced log just before dispatch (see
Observability).

## Security (rule 13)

- No new HTTP endpoint. Insertion reuses the existing PATCH
  `/api/edit/[projectId]` with the same validation, version check,
  rate limit (120/min/IP), and payload-size cap.
- The new row's `script_text` is empty at insert. When the user edits
  it later, that input goes through the same `SET_ROW_SCRIPT` path as
  every other narration edit — no new XSS surface.
- No new asset URLs. The new row has no `video_url_override`, no image,
  no broll. No new fetch.
- No new user input goes to a third party at insert time. Voiceover
  regen is explicitly out of scope (the user wants the voiceover
  preserved).
- Reducer is pure; can't be exploited by a malformed `atIndex` because
  range-check is the first thing it does.
- Undo stack is bounded at 200 (existing cap). Mass-insertion can't
  blow up memory.

## Observability (rule 14)

Logs per rule 14: namespace `[editor insert-shot]`, console.info,
include actual values not just "X happened".

In the UI handler (before dispatch):

```ts
console.info('[editor insert-shot] dispatch', {
  atIndex,
  mode,
  carveFrom,
  durationMs,
  leftNeighborMs: leftNeighbor?.effectiveDurationMs,
  rightNeighborMs: rightNeighbor?.effectiveDurationMs,
});
```

In the reducer (inside the carve branch):

```ts
console.info('[editor insert-shot] carve resolved', {
  atIndex,
  source: chosenSide,           // 'left' | 'right'
  sourceIndex,
  sourceDurationBefore,
  sourceDurationAfter,
  newRowDurationMs,
  fallbackUsed: chosenSide !== requestedSide,
});
```

In the reducer (no-op path):

```ts
console.warn('[editor insert-shot] no-op', {
  reason: 'no neighbor with sufficient slack',
  atIndex,
  leftDurationMs,
  rightDurationMs,
  requiredFloor: EDITOR_MIN_SHOT_MS,
});
```

In the save handler — no new log; the existing PATCH log already
covers it.

UI toast on no-op: "Can't carve here — both neighbors are at the 2-second
minimum. Use 'Add new time' instead." (Lazy-user friendly — tells them
what to do next.)

## Settings audit (rule 15)

The editor today has no centralized settings UI per a quick check
(verify before implementing — if it has one, slot into it; if not,
flag and propose). New controls to expose:

- **Default insert mode** — `carve | shift | always-ask`. Default
  `carve`. Drives the popover's primary button.
- **Default new-scene duration** — number input, 500–10000ms, default
  2000ms. Used as the `durationMs` in both modes.
- **Default carve source** — `right | left | larger neighbor`. Default
  `right`. Drives `carveFrom`.

Group as a new "Editor → Timeline" section. If the project has no
settings layer yet, **flag this in the PR description** rather than
silently inventing one — that's a bigger product call and shouldn't
piggy-back on this feature. v1 of the insert feature ships with
hardcoded defaults (carve, 2000ms, right neighbor); settings is a
fast-follow once the surface exists.

## UI/UX (rules 10 + 16)

- "+" is only visible on seam hover (no permanent clutter).
- "+" is 14px wide × full card height; click target is generous;
  hover area extends 6px on either side of the seam to forgive imprecise
  pointing.
- Popover appears inline at the seam, anchored above the card row so it
  doesn't cover the cards. Two buttons stacked or side-by-side
  depending on width.
- Primary button (Carve) is filled / visually heavier; secondary (Shift)
  is outlined.
- Disabled state for Carve: button is dimmed with a tooltip explaining
  exactly why (which neighbor is too short, what the floor is).
- After insert, the new card is auto-selected and the timeline scrolls
  to it (already standard behavior on selection — verify).
- No modal, no confirmation, no "are you sure" — fully undoable, so
  friction is wrong here.
- Empty-narration placeholder text on the new card: "New scene — click
  to add narration" in the placeholder text style already used by the
  editor.

## Alternatives rejected

**Option A — Shift only.** Simplest implementation (~1 day), but
directly breaks the user's stated primary use case ("fix mismatches"):
shift-inserting in the middle of a 200-scene doc shifts every
downstream visual later by 2 seconds and creates a cascade of NEW
mismatches. The fix-one-create-a-hundred dynamic is not a tradeoff
worth making for marginal simplicity.

**Option B — Carve only.** Solves the mismatch case cleanly but
leaves no escape valve for "I genuinely need more total runtime here."
Users would then have to add a beat at the END and manually drag the
new scene into position, which is the kind of workflow that drives a
lazy user away (rule 10). Two buttons in one popover is a tiny
incremental cost.

**Per-card right-click "insert after" menu** — considered as the
primary UI. Less discoverable, requires the user to know context
menus exist on the cards. Hover-seam "+" is what Premiere, CapCut,
and Descript all use; matches the user's existing mental model.

**Inline text input in the popover** ("type narration to create the
scene") — considered as a content-first variant. Rejected for v1
because it adds two more interactions (focus → type → enter) where
the blank placeholder is one click. Worth revisiting if "ghost empty
scenes" become a usability complaint.

**Voiceover regen / partial regen at insert** — out of scope. The
user explicitly wants the voiceover preserved and added "fix
mismatches" as their use case. Regen at insert time is the wrong
default. A future "Regenerate voiceover from current scripts" button
elsewhere in the editor is the right surface for regen, not this
feature.

## Open questions

1. **Settings surface**: does the editor already have a settings
   panel where the three new defaults can live? If not, do we
   hardcode for v1 and open a follow-up plan to introduce one?
   Confirm before starting Phase 3.
2. **Transitions**: if scene N had `transition_in: 'cross-fade'`
   into N+1, should the inserted scene inherit/break that transition?
   Proposed default: the inserted scene has `transition_in: null`
   (clean cut on both sides), but the OLD N → (now N+2) cross-fade
   is removed because they are no longer adjacent. Confirm.
3. **Section markers**: does the production doc have section
   boundaries (intro / body / outro grouping) that should govern
   which "side" of a section the new scene lands on? If so, inserting
   at a section seam needs a rule: does the new scene join the left
   section or the right? Defer to user.

## Execution phases

Each phase is a separate commit. Each phase ends with an extreme QA
pass (rule 6).

**Phase 0 — Verify open questions**: read the existing settings
surface, check transition handling, check section markers. ~30min.
Update plan with answers before starting Phase 1.

**Phase 1 — Reducer + types**: add `INSERT_BLANK_SHOT` and
`REMOVE_INSERTED_BLANK_SHOT` actions, the mutation handlers, the
`makeBlankRow` factory, the `getEffectiveRowDurationMs` helper, the
`isEditingCommand` entry. Write unit tests for: shift mode, carve
right, carve left fallback, carve no-op when both neighbors at floor,
undo restores neighbor override, redo restores insertion, reindex
maps are correct, insert at index 0, insert at rows.length.
Acceptance: all reducer tests pass; no UI yet. ~half day.

**Phase 2 — Shared UI component**: build `InsertSceneAffordance`,
the "+" hover affordance, the popover, the disabled state, the
keyboard handling. Storybook story if Storybook exists; otherwise a
small dev page. Acceptance: visual review on a mock scene strip.
~half day.

**Phase 3 — Wire v1 timeline**: render the affordance at each seam
in [Timeline.tsx](src/components/editor/Timeline.tsx). Wire the
`onInsert` callback to `dispatch({ type: 'INSERT_BLANK_SHOT', ... })`.
Add the `[editor insert-shot]` logs. Manual QA: insert at start,
end, middle; carve from each side; carve no-op tooltip; shift mode;
undo; redo; save round-trip. ~half day.

**Phase 4 — Wire v2 timeline**: same in
[TimelineV2.tsx](src/components/editor/timeline-v2/TimelineV2.tsx).
Extra check: seam tracks horizontal scroll. ~half day.

**Phase 5 — QA + polish** (rule 6): walk through the golden path
and every edge case (insertion next to a row with broll generating;
insertion in a doc with transitions; insertion with the user's
unsaved edits pending; insertion immediately followed by undo +
redo; 409 conflict on save mid-insert; insertion at index 0 when
row 0 has special handling, e.g., title card). Fix everything that
breaks. ~half day.

**Phase 6 — Settings (deferred)**: if a settings surface exists by
this point, expose the three defaults. Otherwise, log a follow-up
plan and ship Phase 5 with hardcoded defaults.

**Total estimate**: 2-3 working days for Phases 0-5. Phase 6
depends on settings surface state.

## Done criteria

- "+" appears on hover at every seam in both timelines.
- Click → popover → click Carve → new blank scene inserted, neighbor
  shrinks, total duration unchanged, downstream visuals stay aligned
  with their voiceover, save PATCH succeeds, undo restores exact
  prior state.
- Click → popover → click Shift → new blank scene inserted, total
  duration grows by the configured ms, downstream visuals shift later,
  voiceover unchanged in absolute time.
- Carve no-op tooltip works when both neighbors are at the floor.
- Empty narration placeholder visible on the new card.
- All logs land in console as specified.
- No new permission warnings, no new API surface, no new pricing.
- Manual QA passes for all edge cases in Phase 5.
