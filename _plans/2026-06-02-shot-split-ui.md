# Shot Split — finish the UI surfaces and harden the backend

**Date:** 2026-06-02
**Status:** Approved — execution started 2026-06-02
**Triggered by:** User wants to "trim/crop/split" a shot at the playhead so one
shot becomes two, with no change to total length, audio, or anything else.

## Goal

Make splitting a shot at the playhead a first-class operation in the editor.
After the split the project is byte-for-byte identical in every dimension
the user cares about — same total duration, same audio, same scenes visible
on screen — except the original row is now two adjacent rows the user can
edit independently.

## Surprise finding (read this before reviewing the rest)

A lot of this is already built. The audit turned up:

- **`SPLIT_SHOT` reducer already exists** in
  [src/lib/editor/store.ts:1163](src/lib/editor/store.ts#L1163). It validates
  both halves ≥ `EDITOR_MIN_SHOT_MS` (2000 ms), clones the row, pins both
  durations, stamps `edited_at`, returns `MERGE_ADJACENT_SHOTS` as the
  inverse so undo restores the prior state exactly.
- **Context-menu item** "Split at playhead" already wired in
  [EditorClient.tsx:6151](src/app/(app)/edit/[projectId]/EditorClient.tsx#L6151)
  with a `disabled` state when the playhead isn't inside the row.
- **Keyboard shortcut is already wired — but it's `B`**, not `S`. See
  [EditorClient.tsx:3530](src/app/(app)/edit/[projectId]/EditorClient.tsx#L3530).
  `B` is the conventional "blade tool" key in DaVinci Resolve and iMovie.
  You asked for `S`. Per rule 12 (brutal honesty): keeping `B` and adding
  `S` as an alias is the right call — `B` is the standard most NLE muscle
  memory already has, and `S` is also natural (CapCut uses it). Adding
  both costs three lines. I do **not** recommend remapping `B` to
  something else.
- Audio is one continuous .mp3 sliced visually by row durations
  ([store.ts:101](src/lib/editor/store.ts#L101)). A split inherently leaves
  audio playing naturally — zero work needed there.

## Gap analysis (what's actually missing)

| # | Surface | State today | Required work |
|---|---|---|---|
| 1 | Backend: `SPLIT_SHOT` motion-beat slicing | Both halves get a duplicated `motion_beats[]` array, so motion shots double-fire every beat | Slice beats by `splitAtMs`, drop spanners, rebase second-half `startMs` |
| 2 | Backend: `SPLIT_SHOT` variant-group handling | Both halves keep the same `group_id` / `variant_index`, putting two rows in the same group slot | Detach second half (clear `group_id`, `variant_index`, `variant_edit_prompt`, `variant_source_image_url`) |
| 3 | Backend: `MERGE_ADJACENT_SHOTS` inverse | Only restores `duration_override_ms` + `pin_duration` | Also restore `motion_beats[]` and variant fields so undo is symmetric |
| 4 | UI: Right-rail "Split at playhead" button | Doesn't exist | Add to `ShotInspector` header near the duration display |
| 5 | UI: Card button on selected shot | Doesn't exist | Add a small "Split" affordance on the selected shot's `Timeline` card, visible only when playhead is inside |
| 6 | Keyboard: S shortcut | Only `B` is wired | Add `S` as an alias next to `B` |
| 7 | Tests | Existing pin-duration tests cover duration math only | New unit tests for beat slicing, variant detach, and `MERGE` round-trip |
| 8 | Observability | No `[editor split]` log line | One info log on apply with shotIndex, splitAtMs, beatsKept, beatsDropped, variantDetached |

## Alternatives considered (rule 4)

### Option A — Backend hardening + all four UI surfaces (recommended)

Touch the reducer to slice beats and detach variants, restore symmetric
undo, add the two missing UI surfaces (right-rail button, card button), and
add `S` as a keyboard alias. Cover the backend changes with unit tests.

**Pros:** Matches the user's selections exactly. The backend becomes
correct for motion shots (today it's silently broken if you split one).
Four discovery paths means a lazy user (rule 10) can find it on day one.
**Cons:** Touches three files (store.ts, EditorClient.tsx, ShotInspector.tsx,
Timeline.tsx) plus a new test file. Largest change of the three options.

### Option B — UI surfaces only, defer the backend fixes

Add the two missing UI surfaces and the keyboard alias but skip the
motion-beat slicing and variant-detach work. Document the gaps as known
issues to revisit when `paint_explainer_v1` motion shots ship to production
QA.

**Pros:** Smaller, faster, lower risk. Static shots split correctly today
and that's the 99% case until motion shots clear QA. The user explicitly
flagged the backend choices as nice-to-haves with "Drop the spanning beat"
and "Detach the second half" picks — but those choices presume the
backend gets touched.
**Cons:** Splitting a `paint_explainer_v1` motion shot today double-fires
every beat — a silent rendering bug. Variant rows split into two in-group
rows confuse the variant inspector. Both are landmines waiting for the
next person.

### Option C — Backend hardening + one UI surface (the card button only)

Fix the backend, add only the timeline-card button (the most lazy-user
friendly surface), skip the right-rail button and the keyboard alias.

**Pros:** Smallest UI footprint. The card button alone covers most users.
**Cons:** Contradicts the four-trigger answer in the clarifying questions.
Power users typing-by-keyboard get nothing new (only `B`, which they
already had). Right-rail users (who live in the inspector) get nothing.

### Recommendation

**Option A.** The user selected all four UI triggers explicitly, asked
specifically for spanning-beat drop and variant detach, and the backend
gaps are real bugs waiting to bite the next motion-shot render. The
incremental cost of doing it once vs. in two passes is small — one
reducer function, three UI surfaces, one test file. Doing it now keeps the
SPLIT_SHOT contract honest.

## Detailed work plan

### File 1 — `src/lib/editor/store.ts` (reducer changes)

**Add a helper** above the `SPLIT_SHOT` case (around line 1163):

```ts
/**
 * Slice motion_beats[] for a SPLIT_SHOT at `splitAtMs` (relative to the
 * row start). Returns first-half (kept as-is) and second-half (startMs
 * rebased to the second half's local 0). Beats spanning the split are
 * dropped with a console.warn so the user can see what was lost in the
 * dev logs — splitting through an animation is rare and a clean drop
 * is less surprising than a partial render. See plan
 * `_plans/2026-06-02-shot-split-ui.md` §"Motion-beat policy".
 */
function sliceMotionBeats(
  beats: MotionBeat[] | undefined,
  splitAtMs: number,
): { first: MotionBeat[] | undefined; second: MotionBeat[] | undefined; dropped: number } {
  if (!beats || beats.length === 0) return { first: undefined, second: undefined, dropped: 0 };
  const first: MotionBeat[] = [];
  const second: MotionBeat[] = [];
  let dropped = 0;
  for (const b of beats) {
    const beatEnd = b.startMs + b.durationMs;
    if (beatEnd <= splitAtMs) first.push(b);
    else if (b.startMs >= splitAtMs) second.push({ ...b, startMs: b.startMs - splitAtMs });
    else dropped += 1;
  }
  return {
    first: first.length > 0 ? first : undefined,
    second: second.length > 0 ? second : undefined,
    dropped,
  };
}
```

Field choices on equality:
- `beatEnd <= splitAtMs` → first half (a beat ending exactly at the split
  has finished animating, belongs to the first half).
- `b.startMs >= splitAtMs` → second half (a beat starting exactly at the
  split is a clean second-half opener at relative t=0).
- Everything else spans → drop.

**Modify `SPLIT_SHOT` case** (lines 1163-1216):

1. Capture pre-split `motion_beats` and the variant trio (`group_id`,
   `variant_index`, `variant_edit_prompt`) into a new `restoreSlice` field
   on the inverse for symmetric undo.
2. Call `sliceMotionBeats(row.motion_beats, firstHalfMs)` and write
   `motion_beats` on each half from the slice result.
3. On the second half only: delete `group_id`, `variant_index`,
   `variant_edit_prompt`, and `variant_source_image_url` if present.
4. Add one `console.info` log at the end:
   ```ts
   console.info('[editor split] applied', {
     shotIndex, splitAtMs: firstHalfMs, secondHalfMs,
     beatsKept: { first: firstBeats?.length ?? 0, second: secondBeats?.length ?? 0 },
     beatsDropped: dropped,
     variantDetached: typeof row.group_id === 'string',
   });
   ```

**Modify `MERGE_ADJACENT_SHOTS` case** to consume the new `restoreSlice`
field: when merging the two halves back into one, the merged row's
`motion_beats` becomes the captured pre-split array (not the concatenation
of the two halves, which could lose dropped spanners), and the variant
fields are restored exactly. This keeps undo round-trip-symmetric.

### File 2 — `src/components/editor/Timeline.tsx` (card button)

**Add two new props** to `TimelineProps`:
- `splitAvailableShotIndex?: number | null` — which shot has a valid split
  position right now (parent computes from `splitTarget`).
- `onSplit?: () => void` — fires when the user clicks the card button.

**Add two new props** to `SortableShotCardProps`:
- `canSplit: boolean` — true when this card is the one the playhead is
  inside AND validSplit.
- `onSplit?: () => void` — same handler, only invoked when `canSplit`.

**Add a small split affordance** inside the card render. Position it in
the top-right area below the resize handle, only visible when both
`canSplit && isSelected` (so unselected cards stay clean). Use the
existing icon button styling from the trim/cross-fade chips for visual
consistency. Tooltip: "Split at playhead (B / S)".

### File 3 — `src/components/editor/ShotInspector.tsx` (right-rail button)

**Add two new props** to `ShotInspectorProps`:
- `canSplit: boolean` — true when this shot is the splittable one.
- `onSplit?: () => void`.

**Render the button** in the existing header (around
[line 642](src/components/editor/ShotInspector.tsx#L642), near the duration
display). Show "Split at playhead" + the relative offset (e.g. "at 4.2s"
when split point is 4.2 s into the shot). Hidden when `!canSplit` so the
header doesn't get noisy on shots the user isn't actively scrubbing.

### File 4 — `src/app/(app)/edit/[projectId]/EditorClient.tsx`

**Keyboard alias** at [line 3530](src/app/(app)/edit/[projectId]/EditorClient.tsx#L3530):
```ts
if (key === 'b' || key === 's') {
  e.preventDefault();
  handleSplit();
  return;
}
```
Update the `[editor shortcut]` log to include the actual `key` so we can
see which one the user pressed.

**Thread props** into `Timeline` and `ShotInspector`:
- `splitAvailableShotIndex={splitTarget?.validSplit ? splitTarget.shotIndex : null}`
- `onSplit={handleSplit}`
- For the inspector: `canSplit={splitTarget?.shotIndex === state.selection && splitTarget?.validSplit === true}`.

### File 5 — `tests/editor-split-shot.test.ts` (new file)

Mirror the structure of [tests/editor-pin-duration.test.ts](tests/editor-pin-duration.test.ts).
Coverage:

1. **Beats fully before the split** stay on first half with original
   `startMs`.
2. **Beats fully after the split** move to second half with rebased
   `startMs` (`startMs -= firstHalfMs`).
3. **Spanning beats** are dropped from both halves; the dropped count
   surfaces in the log (assert via a `vi.spyOn(console, 'info')`).
4. **A beat with `startMs === splitAtMs`** lands on the second half at
   relative 0 (boundary policy).
5. **A beat ending exactly at the split** stays on the first half.
6. **Empty / absent `motion_beats`** produces undefined on both halves
   (not an empty array — keeps the JSON compact and the field optional).
7. **Variant detach** — row with `group_id`, `variant_index: 0` produces
   a first half with those intact and a second half with both fields
   absent.
8. **Standalone row** — row without `group_id` produces two standalone
   halves (no change to variant fields).
9. **MERGE inverse restores original `motion_beats`** even after a
   spanning-beat drop (the inverse captures the pre-split array).
10. **MERGE inverse restores original `group_id` / `variant_index` /
    `variant_edit_prompt`** on the merged row.
11. **Existing pin-state tests still pass** (no regression).

## Settings audit (rule 15)

- Minimum shot duration after a split is `EDITOR_MIN_SHOT_MS` (2000 ms),
  defined in [src/lib/editor/store.ts](src/lib/editor/store.ts). Already
  surfaced in editor settings as the floor for resize / trim / split.
  **No new settings needed** — the existing duration floor governs split
  too, which is the right behavior (one knob, consistent meaning).
- Spanning-beat policy is hard-coded to "drop." Surfacing this as a
  setting would be premature — there's no evidence any user wants
  spanning beats clamped instead. If we hear that feedback, we'd add a
  `splitBeatPolicy: 'drop' | 'clamp-to-first' | 'keep-on-both'` setting
  later.
- Keyboard shortcut bindings (`B`, `S`) follow industry standard and are
  not user-configurable today. The editor's shortcut layer is centralized
  in [EditorClient.tsx:3500-3559](src/app/(app)/edit/[projectId]/EditorClient.tsx#L3500-L3559)
  and no shortcut in it is configurable yet. Out of scope here.

## Security & safety (rule 13)

- **Trust boundary:** `splitAtMs` is computed from the local playhead
  state, never from untrusted input. No new server endpoint, no new API
  surface.
- **State validation:** the reducer already validates both halves ≥
  `EDITOR_MIN_SHOT_MS` and rejects (no-op) otherwise. The new beat-slice
  logic adds no new failure modes — it operates on already-validated row
  data and a bounded `splitAtMs`.
- **Optimistic concurrency:** the doc PATCH endpoint enforces version
  optimistic locking (`EditorSavePayload.version`). A stale tab can't
  silently overwrite a fresh server-side doc. Unchanged.
- **No new secrets, no new third-party calls, no PII touched.**

## Observability (rule 14)

- New log: `[editor split] applied { shotIndex, splitAtMs, secondHalfMs,
  beatsKept, beatsDropped, variantDetached }` on every successful split.
- Existing `[editor shortcut] split { key, source: 'keyboard' }` already
  logs on B; extend to also log when S is pressed.
- The reducer's existing `console.warn('[editor store] split rejected — would
  produce shot below min duration', …)` covers the failure path.

## Testing (rule 18)

- New file [tests/editor-split-shot.test.ts](tests/editor-split-shot.test.ts)
  per the breakdown above. 11 unit cases. Run with `npm test -- editor-split-shot`.
- Re-run [tests/editor-pin-duration.test.ts](tests/editor-pin-duration.test.ts)
  to confirm no regression in the existing SPLIT_SHOT pin-state contract.
- Manual QA pass after the code lands:
  1. Static shot — split at playhead, confirm two halves render the same
     image, audio continues with no gap, total project length unchanged.
  2. Static shot with `pin_duration: true` — split, undo, confirm
     `pin_duration` restored on the merged row.
  3. Motion shot (`paint_explainer_v1`) with beats fully before / fully
     after / spanning the split — confirm in browser console that
     `beatsKept` and `beatsDropped` match expectations, confirm the
     render shows beats only in the correct half.
  4. Variant row (`variant_index > 0`) — split, confirm second half no
     longer appears in the variant mini-strip; undo, confirm it
     re-appears.
  5. Keyboard: press B then S with the playhead inside a shot — both
     produce one split each. Press either with playhead at the start /
     end of a shot — no split, no error toast.
  6. Right-rail button visibility — toggle the playhead inside / outside
     the selected shot, button appears / disappears.
  7. Card button visibility — same, on the selected card only.

## Open questions (none)

The four clarifying questions earlier locked the policy. The plan is
ready for approval.
