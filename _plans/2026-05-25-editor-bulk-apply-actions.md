# Editor — Bulk-apply / clear-overrides for per-shot layout fields

**Date**: 2026-05-25
**Branch**: claude/video-creation-ui-pqXzS
**Status**: draft, pending user approval

## Goal

The production-doc page exposes bulk-apply and clear-overrides actions for
several per-row layout fields (section-title layout, pillarbox color,
scene zoom, scene fade, section-title text range, transition). The
shot-graph editor at `/edit/[projectId]` deliberately omitted these — its
inspector is per-shot. The omission shows up in real use: a creator picks
a pillarbox color or scene zoom for shot 1 and then has to repeat the
same change 11 more times, one shot at a time. This plan adds bulks back
into the editor inspector without removing any of the existing
per-shot affordances.

## What exists today

`ShotLayoutControls` ([src/components/editor/inspector/ShotLayoutControls.tsx](src/components/editor/inspector/ShotLayoutControls.tsx))
is the editor's "Layout" accordion inside the Shot inspector. Today it
exposes per-shot edits for:

- `section_title_layout` (overlay / letterbox / clear)
- `pillarbox_color` (color picker + hex input / clear)
- `scene_zoom` (50-200% slider / clear)
- `scene_fade` (default / cut / fade tri-state)
- `on_screen_text_mode` (default / overlay / bake / none)

The component's existing comment explicitly carves out bulk actions as
"production-doc's specialty." This plan reverses that decision for the
editor.

`ShotInspector` already has **one** bulk affordance — the Transform
card's `onApplyTransformToAll`, wired via `EditorClient.tsx:4357` to a
per-row `PATCH_ROW` loop. We follow the same pattern for the new
actions.

## Prod-doc's bulk model — the pattern to mirror

`SectionRowControls` ([src/components/production-doc/SectionRowControls.tsx](src/components/production-doc/SectionRowControls.tsx))
exposes these:

| Field | "Apply to all" semantics | "Clear overrides" semantics |
|---|---|---|
| `section_title_layout` | Set doc-level default (`section_title_layout_default`), leave per-row overrides intact. | Clear every row's `section_title_layout`. |
| `pillarbox_color` | Set `pillarbox_color_default`. | Clear every row's `pillarbox_color`. |
| `scene_zoom` | Set `scene_zoom_default`. | Clear every row's `scene_zoom`. |
| `section_title` (range) | Apply same title to a contiguous range of rows. | n/a |
| `section_title` (title-card propagate) | Stamp this title-card row's text onto every following row up to the next title-card or end-of-doc. | n/a |

Two important details from this model:

1. **"Apply to all" sets the doc default, then optionally clears
   overrides** — it does not stamp the value on every row. That keeps
   the doc small and lets future per-row overrides "stick out" from the
   default cleanly.
2. **Title propagation is range-aware**: title-card rows propagate their
   text forward to the next title card, not to every row. The editor
   already has this hooked up via `onApplyTitleForward` on
   `ShotInspector` — we're not touching that.

## Scope (what's in / out)

### In v1

Bulk affordances inside the Layout accordion for these fields:

- **Section-title layout** — `Apply to all` (sets doc default) +
  `Clear overrides` (wipes per-row).
- **Pillarbox color** — same two actions.
- **Scene zoom** — same two actions.
- **Scene fade** — `Apply to all` only. Scene-fade is a doc-wide
  toggle (`scene_fade_enabled`) plus per-row tri-state overrides; the
  "apply to all" action sets the doc toggle to the current shot's
  effective value. `Clear overrides` wipes every row's `scene_fade`.
- **On-screen text mode** — same two actions. Doc default is
  `on_screen_text_mode_default`.

### Out of v1

- **Section-title text propagation** — already wired
  (`onApplyTitleForward`). Not part of this plan.
- **Range-apply** (apply to shots N..M, not all) — prod-doc has this
  for `section_title`. The editor doesn't currently have any range UI;
  adding one is a separate design problem. Mark as v2.
- **Transition kind/speed/easing bulk-apply** — the editor doesn't
  currently surface per-shot transitions at all. Out of scope.
- **Region zoom padding bulk-apply** — surface area is small and the
  prod-doc affordance is narrowly used. v2.

## UX — where the affordances live

The accordion body for each field grows a third row (after the input +
`clear`) with two compact secondary buttons:

```
Pillarbox color · inherits #ffffff
[color] [#aabbcc] [clear]
       Apply to all · Clear overrides
```

Both are rendered at `text-[10px]`, muted color, no border — they read
as "advanced" controls, not primary calls to action. Tooltips spell out
the exact behaviour:

- `Apply to all` → "Make this the default for every shot. Per-shot
  overrides stay until you clear them."
- `Clear overrides` → "Reset every shot to the doc default for this
  field."

When the current row has no value AND the doc default is unset, both
buttons hide (nothing meaningful to propagate). When the current row's
value matches the doc default, `Apply to all` greys out as a no-op.

## State / data flow

We follow the existing transform-bulk pattern verbatim:

1. **`ShotLayoutControls` props grow five optional handlers**:
   - `onApplySectionTitleLayoutToAll?: (layout: 'overlay' | 'letterbox') => void`
   - `onClearSectionTitleLayoutOverrides?: () => void`
   - `onApplyPillarboxColorToAll?: (color: string) => void`
   - `onClearPillarboxColorOverrides?: () => void`
   - `onApplySceneZoomToAll?: (zoom: number) => void`
   - `onClearSceneZoomOverrides?: () => void`
   - `onApplySceneFadeToAll?: (sceneFade: boolean | undefined) => void`
   - `onClearSceneFadeOverrides?: () => void`
   - `onApplyOstModeToAll?: (mode: 'overlay' | 'bake' | 'none' | undefined) => void`
   - `onClearOstModeOverrides?: () => void`

   Per-field hide when undefined (parity with the existing transform
   pattern).

2. **`ShotInspector` adds the same optional props** and threads them
   through to `ShotLayoutControls`.

3. **`EditorClient.tsx` wires each handler** by either:
   - Setting a doc-default via `PATCH_DOC` (for `…ToAll` that targets
     the doc default field — pillarbox, scene zoom, layout, fade, ost
     mode).
   - Iterating `state.doc.rows.forEach((_, i) => apply({ type: 'PATCH_ROW', ... }))`
     (for `Clear…Overrides`).

4. **Reducer**: no new commands. We reuse `PATCH_DOC` and `PATCH_ROW`.

5. **Undo**: matches the transform-bulk behaviour — clear-overrides
   produces N undo entries (one per row). Acknowledged limitation,
   consistent with the existing pattern. A future plan could collapse
   these into a single batched command if it bites.

## Why this approach

- **Zero new reducer surface** keeps the change small.
- **Mirrors the established transform-bulk pattern** so a future
  reader sees one idiom for "bulk-apply from one shot."
- **Doc-default-first** matches prod-doc's semantics exactly — same
  field semantics on both pages, so doc state stays one-to-one.

## Alternatives considered

1. **A new "Bulk" panel** (separate tab/section): rejected. Forces the
   user to navigate away from the field they're editing. The whole
   point of the editor is per-shot context.
2. **Multi-select shots + global "apply" action**: rejected for v1.
   Requires a real selection model in the timeline, which the editor
   doesn't have for the layout fields. v2 candidate.
3. **One unified "Promote shot to defaults" button** that bulks every
   field at once: rejected. Too coarse — the lazy user wants to set
   pillarbox without also overwriting their carefully-chosen scene
   zoom.

## Cost (rule 8)

Zero. No new paid services, no new API calls. State mutations only.

## Security (rule 13)

Same auth surface — writes go through the same `PATCH_DOC` /
`PATCH_ROW` reducer paths the editor already uses, which save through
the same workspace-scoped doc-save endpoint. No new endpoints, no new
client-side state escaping the existing scope.

## QA plan (rule 6)

**Golden path**
- Open editor on a 12-shot doc, pick shot 5. Set pillarbox color to
  `#ff5577`. Click `Apply to all`. Confirm: doc default is now
  `#ff5577`. Switch to shot 6 — Layout accordion shows
  `inherits #ff5577`.
- Same for layout / scene zoom / fade / ost mode.
- `Clear overrides`: set per-shot pillarbox on three different shots,
  then `Clear overrides`. Confirm: all three return to inheriting the
  doc default.

**Edge cases**
- Current shot's value equals doc default — `Apply to all` is a no-op,
  button greys.
- Doc has no per-shot overrides anywhere — `Clear overrides` is a
  no-op; button still active (cheap to dispatch into a no-op loop).
- 50-shot doc — clear-overrides walks 50 PATCH_ROW dispatches. Stress
  test: confirm no perceptible UI freeze (the existing transform-bulk
  already does this).
- Save bar shows "Saving…" once and "Saved" once — no flicker storm.
- Undo: after `Apply to all`, one Cmd+Z reverts the doc default.
  After `Clear overrides`, Cmd+Z reverts N PATCH_ROW entries one at
  a time. Document this in the cheat sheet's existing undo tooltip.

**Error paths**
- Save fails mid-bulk: existing reducer rejects mid-flight; the
  optimistic state already has the new doc default applied, but the
  next save retry should reconcile. Confirm no inconsistent state in
  localStorage.

**Regression checks**
- Production-doc page bulk actions: untouched.
- Per-shot edits on `ShotLayoutControls`: behaviour unchanged when no
  bulk handlers are passed (props are optional).
- Existing transform-bulk: unchanged.

## Phases

### Phase 1 — Wire the handlers (~1 hour)

1. Add the 10 optional props to `ShotLayoutControls`.
2. Add the same to `ShotInspector` + forward.
3. Implement the handlers in `EditorClient.tsx` next to the existing
   `onApplyTransformToAll` block.

### Phase 2 — UI affordances (~2 hours)

1. Add the two-button row under each of the five fields in
   `ShotLayoutControls`.
2. Tooltips, disabled states, hide-when-no-op logic.
3. Visual pass — confirm the buttons read as secondary, not primary.

### Phase 3 — QA pass (~30 min)

Walk the golden path + edge cases above with the dev server.

**Total**: ~4 hours.

## Open questions

None — every handler maps to an existing PATCH_DOC or PATCH_ROW
dispatch, and the UX placement is settled.
