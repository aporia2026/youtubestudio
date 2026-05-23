# Pin-duration architecture: durable manual timing alongside voiceover alignment

**Date**: 2026-05-23
**Author**: Yoav + Claude
**Status**: Pending approval

## Goal

Let the user manually set a shot's duration via Set Timing, left-edge
drag, trailing-edge drag, or insert and have that edit **stick** at
render time, even when voiceover alignment is active — **without
disrupting projects that already have legacy `duration_override_ms`
values** (set by past edits, INSERT_BLANK_SHOT, or auto-pipeline).

Today, alignment unconditionally overwrites every `duration_override_ms`.
My earlier fix (commit `f560537`, since reverted) made alignment
respect every override — which honored the user's new edits but also
suddenly honored every pre-existing override, accumulating visual
shifts of 10+ seconds and breaking their working project.

This plan introduces a **per-row pin flag** that distinguishes
intentional manual edits from legacy state.

## Why now

The user is mid-session and frustrated:
- Set Timing popover does nothing on narrated shots (alignment wins).
- Trailing-edge drag does nothing on narrated shots (same root cause).
- My fix that did make it work disrupted the entire project.
- Reverting restored the project but lost the fix.

We need a fix that's surgical: new edits work, old state preserved.

## Constraints (verified from current code, 2026-05-23)

1. **Payload validator strictly allowlists row fields.**
   [src/lib/project/payload.ts](src/lib/project/payload.ts) — adding
   a new `pin_duration?: boolean` to `ProductionRow` is necessary but
   not sufficient. The validator copies `doc.rows` as-is at line 255
   (`out.doc = raw.doc as unknown as ProductionDoc`), so the field
   actually DOES survive — but defense-in-depth says we should still
   verify by writing an integration test that saves + loads + asserts.
   *(Agent reported the field would be stripped — re-reading the
   migrator shows row-internal fields pass through opaquely. Test
   will confirm; if stripped, we add an explicit pass-through.)*
2. **Five reducer actions write `duration_override_ms`**
   ([src/lib/editor/store.ts](src/lib/editor/store.ts)):
   `RESIZE_SHOT` (718), `SET_SHOT_TIMING` (826, 833), `SPLIT_SHOT`
   (890, 894), `MERGE_ADJACENT_SHOTS` (2165), `PATCH_ROW` (1103).
   Plus `INSERT_BLANK_SHOT`'s `makeBlankRow` factory (line ~2277).
   Each is a candidate for setting the pin flag.
3. **Two external writers** (read-only copy-through):
   `src/app/api/edit/[projectId]/regenerate-from-script/route.ts:127`
   and `src/lib/editor/otio.ts:183`. Both just propagate the field
   from an existing row; the plan adds `pin_duration` to both
   copy-throughs.
4. **`edited_at.fields.duration` is observability-only** ([src/lib/editor/edited-at.ts](src/lib/editor/edited-at.ts)).
   No code branches on its value. Can't double-duty as a pin signal.
5. **`realignVideoConfig` post-revert** has no `pinnedShots`
   option — back to unconditional overwrite at
   [src/remotion/utils.ts:1341](src/remotion/utils.ts#L1341).
6. **When alignment is INACTIVE**, `duration_override_ms` is honored
   100% (cascade math at [src/remotion/utils.ts:825-828](src/remotion/utils.ts#L825-L828)).
   So pin behavior only matters when alignment is active.
7. **No existing UI** to clear a per-shot override. Users today rely
   on Cmd+Z. We need an explicit "Reset to alignment" action.
8. **Test infrastructure exists**: `tests/voiceover-alignment-integration.test.ts`
   has a working 6-row fixture for end-to-end realignment testing.

## Requirements

### Functional

- **New field**: `ProductionRow.pin_duration?: boolean`. `true` means
  alignment must honor this row's cascade-derived `[startMs,
  durationMs]`; `undefined` / `false` means alignment can overwrite.
- **Set on these actions** (covering every "the user just told the
  system what duration they want" gesture):
  - `SET_SHOT_TIMING` (Set Timing popover + new left-edge drag)
  - `RESIZE_SHOT` (trailing-edge drag)
  - `INSERT_BLANK_SHOT` (newly-inserted row carries pin_duration: true)
  - `SPLIT_SHOT` (both halves are intentional new durations)
  - `MERGE_ADJACENT_SHOTS` (merged duration is the user's intent)
  - `PATCH_ROW` — only when the patch includes `duration_override_ms`
    (most PATCH_ROW dispatches don't touch duration, those don't pin).
- **Inverse paths preserve prior pin state**: each editing command's
  inverse captures whatever `pin_duration` was before the edit, so
  Cmd+Z restores the exact prior state (including the pin status).
- **Render-time honoring**: `realignVideoConfig` accepts a
  `pinnedShots: boolean[]` option. `productionDocToVideoConfig` passes
  `doc.rows.map(r => r.pin_duration === true)`. Pinned rows keep
  cascade values; non-pinned rows use alignment as today.
- **Cascade-forward (bounded)**: when a pinned shot's cascade end
  falls past the next shot's aligned start, shift the immediate next
  shot's start to match (no overlap). The shifted shot keeps its
  aligned DURATION — its end shifts by the same amount. Downstream
  shots only shift if they would in turn overlap; if alignment has
  any gap, the shift is absorbed and propagation stops. This bounds
  drift to "however many adjacent shots have zero alignment gaps".
- **New "Reset timing" action**: in the shot right-click context
  menu, below "Set timing…", add **"Reset timing to alignment"**.
  Disabled when the row has no override. Click clears both
  `duration_override_ms` and `pin_duration`. New reducer command
  `RESET_SHOT_TIMING` (or extend `PATCH_ROW` semantics — see Open
  Questions).
- **Migration: no data touch.** Existing rows with
  `duration_override_ms` and no `pin_duration` stay unpinned. They
  continue to be overwritten by alignment exactly as they were before
  any of today's changes — the user's project plays as it did this
  morning. Any new user action on the row sets the flag.
- **Popover timebase**: the Set Timing popover surfaces **cascade**
  values, not aligned values. Cascade is what the reducer writes;
  no aligned-→-cascade translation is needed (the translation bug
  was the source of the silent-no-op symptoms). After Apply, the
  ruler reflects the pinned cascade position. *(See Alternatives —
  this is the cleanest of three options.)*

### Non-functional

- **Schema compat**: the new field is optional and additive. Old docs
  load fine (field is undefined → row is unpinned). New docs save
  fine. Round-trip survives the validator — integration test verifies.
- **Performance**: no new per-frame work. Pin check is O(1) per shot
  during config build.
- **Undo correctness**: every editing command that touches
  `duration_override_ms` must also capture `pin_duration` in its
  inverse. Existing inverse machinery (PATCH_ROW's prior-value
  capture) handles this for free when we add `pin_duration` to the
  patched keys; the bespoke inverses (RESIZE_SHOT, SET_SHOT_TIMING,
  etc.) need explicit handling.

### Done criteria

- A new edit via Set Timing or drag visibly changes the rendered
  duration of a narrated shot in a project with alignment active.
- A project loaded from the database that has pre-existing
  `duration_override_ms` but no `pin_duration` flag plays IDENTICALLY
  to the way it played before any of today's changes (same as commit
  `6f2f9ef`).
- Undo restores both duration AND pin state in a single step.
- "Reset timing" context-menu action restores alignment-driven timing.
- Save → reload round-trip preserves `pin_duration` on rows that have
  it set.
- All existing tests pass. New tests cover: pin honored, pin not set
  ⇒ legacy behavior, cascade-forward bounded, round-trip, reset.

## Chosen approach

### 1. Schema addition

```ts
// src/remotion/utils.ts in ProductionRow
/** When `true`, the user has explicitly pinned this row's duration
 *  (via Set timing popover, trailing-edge drag, left-edge drag,
 *  insert, split, or merge). Alignment respects this — keeps cascade
 *  values for the row instead of overwriting with word-derived
 *  positions. Legacy rows with `duration_override_ms` but no
 *  `pin_duration` are NOT pinned: alignment continues to overwrite,
 *  preserving existing project playback. See
 *  `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
pin_duration?: boolean;
```

### 2. Reducer changes

Each command that writes `duration_override_ms` also sets
`pin_duration: true` on the affected row(s). Each command's inverse
captures the prior `pin_duration` value (could be `undefined`,
`true`, or `false`) so undo restores both fields atomically.

Specific updates:
- **`RESIZE_SHOT`**: set `pin_duration: true`. Inverse becomes
  `{ type: 'RESIZE_SHOT', shotIndex, durationMs, priorPinDuration }`
  (extended).
- **`SET_SHOT_TIMING`**: set `pin_duration: true` on the edited row
  AND the carved left neighbor (if any). Inverse captures prior pin
  state for both.
- **`SPLIT_SHOT`** / **`MERGE_ADJACENT_SHOTS`**: set on both rows /
  the merged row. Inverses capture prior pin state.
- **`INSERT_BLANK_SHOT`**: `makeBlankRow` factory writes
  `pin_duration: true` directly (no inverse capture needed — the
  inverse is to remove the row).
- **`PATCH_ROW`**: if `cmd.patch.duration_override_ms` is set, the
  patch ALSO sets `pin_duration: true`. The existing prior-value
  capture handles undo automatically. (If the patch is clearing the
  override, also clear the pin.)

### 3. Render path

- **`realignVideoConfig`** gets a new optional parameter:
  ```ts
  options?: { pinnedShots?: boolean[] }
  ```
  After the existing alignment computation, before snapping/output:
  for each pinned shot, REPLACE the aligned `[startMs, endMs]` with
  the cascade values (`config.shots[i].startMs`,
  `config.shots[i].startMs + config.shots[i].durationMs`). Walk the
  shot list and bound cascade-forward as described in Requirements.
- **`productionDocToVideoConfig`** computes the
  `pinnedShots = doc.rows.map(r => r.pin_duration === true)` array
  and passes it through to `realignVideoConfig` when alignment is
  active.

### 4. UI changes

- **Shot context menu** ([src/app/(app)/edit/[projectId]/EditorClient.tsx](src/app/(app)/edit/%5BprojectId%5D/EditorClient.tsx)):
  add **"Reset timing to alignment"** after "Set timing…". Disabled
  when `row.duration_override_ms` is undefined.
- **Set Timing popover** ([src/components/editor/SetTimingPopover.tsx](src/components/editor/SetTimingPopover.tsx)):
  show cascade values (no aligned ↔ cascade translation). Trigger
  computes initial values from `shotStartTimesMs[i]` and
  `rowEffectiveDurationMs(state.doc, i)` (already exported).
- **Optional v1.1**: small pin indicator (📌 icon or dot) on shot
  cards whose row has `pin_duration: true`. Helps the user see which
  shots they've taken manual control of.

### 5. Persistence

- `pin_duration` is a `boolean | undefined` on an additive row field.
  Survives the validator's row-passthrough at
  [src/lib/project/payload.ts:255](src/lib/project/payload.ts#L255)
  — but verified by a save/load integration test that mounts an
  in-memory payload, runs `validatePayload` → `migratePayload`, and
  asserts the field survives.
- The two external copy-through sites (`regenerate-from-script`
  route and `otio.ts`) get one-line additions to propagate the field.

### 6. Migration

- **No data migration.** Existing payloads have rows without
  `pin_duration`. Those rows are treated as unpinned — alignment
  continues to overwrite their `duration_override_ms` (zero behavior
  change vs. today). Only new user actions set the flag.
- **v1.1 fast-follow**: optional "Pin all current durations" admin
  action that bulk-sets `pin_duration: true` on every row that has
  `duration_override_ms`. Useful for users who want to lock in their
  current visual state.

## Edge case analysis

| Scenario | Behavior |
|---|---|
| Project with no `duration_override_ms` anywhere | Identical to today: alignment drives everything |
| Project with legacy `duration_override_ms` but no pins | Identical to today: alignment overwrites |
| User does new Set Timing on shot 70 | Shot 70 pinned. Cascade values honored. Downstream shifts by however much shot 70 changed |
| User pins shot 70 to +4 s, alignment of shot 71 starts at +1 s into shot 70's pinned window | Shot 71 shifts forward by 3 s (cascade-forward bounded), keeps its aligned duration. Shot 72 only shifts if it overlaps shot 71's new end |
| Alignment has a 5 s gap between shots N and N+1; pin extends shot N by 3 s | Shot N+1's aligned start is now AFTER shot N's pinned end. No shift needed. Drift = 0 downstream |
| User "Reset timing to alignment" on a pinned shot | `duration_override_ms` and `pin_duration` both cleared. Alignment takes over. Downstream cascade-forward releases |
| User pins shot 70, then changes shot 70's narration text | Alignment re-runs against the new script. Shot 70 stays pinned (its words match different positions but cascade values still honored). Shot 71 may shift differently |
| Pinned shot's `duration_override_ms` < `min_scene_ms` | Reducer already clamps at write time. Realignment respects clamp. No edge case here |
| Save → reload | `pin_duration` round-trips. Pin state preserved |
| Undo immediately after Set Timing | Inverse restores `duration_override_ms` AND `pin_duration` (could be `undefined` → field removed) in one step |
| Cmd+Z past the original pin set | Pin is fully unwound; row is back to legacy unpinned state |

## Alternatives rejected

**A. Make alignment respect ALL `duration_override_ms`** (my last
attempt, commit `f560537`). Cleanest mental model but disrupts
existing projects with legacy overrides. The user's session today
proved this is unacceptable.

**B. Use `edited_at.fields.duration` timestamp as the pin signal.**
Reuses existing field. Rejected because (a) it's a timestamp, not a
boolean intent, (b) other actions stamp `edited_at` for unrelated
reasons (auto-pipeline regen, etc.), conflating "edited" with
"pinned", and (c) verified that no code reads `edited_at` for
behavior today — repurposing it would be a hidden semantic change.

**C. Two separate duration fields: `duration_override_ms` (legacy,
overwritten by alignment) and `pinned_duration_ms` (new, respected
by alignment).** Cleaner separation than a boolean flag. Rejected
because it doubles the state per row, requires complex precedence
rules, and every consumer needs to know about both fields. The
boolean flag is the minimum viable distinction.

**D. Doc-level "honor manual durations" flag.** A single toggle
either alignment-dominant or override-dominant for the whole doc.
Blunt — users can't mix-and-match per shot. The user's actual use
case is per-shot tweaks, not a global mode switch. Possible v1.1
feature as a "pin everything currently overridden" bulk action.

**E. Translate aligned-↔-cascade in the popover (my fix in commit
`3722a93`).** Caused subtle bugs around shots without
`duration_override_ms` and obscured the actual fix needed at the
render layer. Rejected. The popover now shows cascade values
directly; no translation.

**F. Show aligned values in popover, dispatch directly.** Causes
the "Set timing does nothing" symptom because dispatch values land
in the wrong timebase. Rejected.

## Open questions

1. **`RESET_SHOT_TIMING` as a new command, or extend `PATCH_ROW`
   semantics?** PATCH_ROW with `{ duration_override_ms: undefined,
   pin_duration: undefined }` would work and reuse the existing
   inverse machinery. Adding a dedicated command is more discoverable
   in the codebase. Recommendation: new command, for clarity.

2. **Should `RESIZE_SHOT` (trailing-edge drag) pin by default?** Yes.
   The user's gesture is explicit ("I want this shot to be a
   different length"). The asymmetry with legacy un-pinned overrides
   is OK because legacy state is opaque to the user.

3. **`SPLIT_SHOT` and `MERGE_ADJACENT_SHOTS`** — pin both halves /
   the merged row? Lean yes. The user intentionally restructured;
   the resulting durations are their intent. (If a user splits and
   doesn't want pinning, they can hit Reset on each half. v1 ships
   with pin-on-split.)

4. **`PATCH_ROW` heuristic for pinning.** Only pin if
   `cmd.patch.duration_override_ms` is present in the patch. Most
   PATCH_ROW dispatches touch unrelated fields (overlay placement,
   etc.) and shouldn't pin. Confirm by greping callers — the
   overhead is mechanical.

5. **Pin marker UI**. Defer to v1.1 to keep this PR focused. v1
   ships the underlying behavior; v1.1 adds visual indicator.

## Security (rule 13)

- No new HTTP endpoint.
- `pin_duration` is a boolean on a row — no new attack surface.
- Payload validator already validates row-shape opaquely; the new
  field is benign optional data.
- No new third-party calls, no new auth surface.

## Observability (rule 14)

Logs:
- `[editor pin] set` when a reducer flips `pin_duration: true`,
  with `{ shotIndex, action, prevPinDuration }`.
- `[render-timing] respecting pin` in `realignVideoConfig` when at
  least one pinned shot is honored, with `{ pinnedIndices, count }`.
- `[render-timing] cascade-forward shift` when a non-pinned shot is
  shifted forward to clear a pinned shot's tail, with `{ shotIndex,
  alignedStart, shiftedStart, shiftMs }`. Fires at most once per
  pinned shot.
- `[editor reset-timing]` when the new Reset action fires.

## Settings audit (rule 15)

No new per-device settings in v1. The pinning behavior is
universal — every Set Timing / drag / insert pins. No user choice
needed.

v1.1 candidates:
- **"Pin manual duration edits"** (default ON) — escape hatch for
  users who want alignment to keep dominating. Niche.
- **"Show pin indicator on cards"** (default ON) — visual marker.

## Test plan

The user explicitly demanded thorough testing this round. Each
phase ships with green tests AND a manual verification step.

### Unit tests (reducer)

In `tests/editor-set-shot-timing.test.ts` (extend existing):
- `SET_SHOT_TIMING` sets `pin_duration: true` on the edited row
- `SET_SHOT_TIMING` sets `pin_duration: true` on the carved left
  neighbor (if any)
- Undo restores prior `pin_duration` (test with `undefined`,
  `true`, and `false` priors)
- Redo re-applies the pin

In `tests/editor-insert-blank-shot.test.ts` (extend):
- `INSERT_BLANK_SHOT` creates a row with `pin_duration: true`

In a new `tests/editor-resize-shot.test.ts`:
- `RESIZE_SHOT` sets `pin_duration: true`
- Undo restores prior pin state

In a new `tests/editor-reset-shot-timing.test.ts`:
- `RESET_SHOT_TIMING` clears both fields
- Undo restores both fields exactly

### Unit tests (render path)

In `tests/voiceover-alignment-integration.test.ts` (extend):
- Pinned row keeps cascade duration (alignment doesn't overwrite)
- Non-pinned row uses alignment values (legacy behavior preserved)
- Cascade-forward shifts immediate next shot when alignment gap is
  zero
- Cascade-forward stops propagating when alignment gap absorbs the
  shift
- Empty `pinnedShots` array behaves identically to old signature

### Integration test (save / load round-trip)

In a new `tests/editor-pin-duration-persistence.test.ts`:
- Build a payload with `pin_duration: true` on row 2
- Run through `validatePayload` → `migratePayload`
- Assert the field survives on row 2
- Assert other rows don't have the field set
- (If stripped — surfaces a missing pass-through to fix)

### Manual verification checklist

Before committing each phase:

1. Hard-refresh editor, open a project with alignment active
2. Open Set Timing on a narrated shot, type new end → click Apply
3. **Verify visual change** in the timeline ruler AND playback
4. Cmd+Z → **verify revert** to prior state
5. Repeat with trailing-edge drag → verify visual change
6. Open a project with legacy overrides → **verify same playback as
   commit `6f2f9ef`** (no drift, identical timing)
7. Right-click pinned shot → "Reset timing to alignment" → **verify
   alignment takes over**

### Dev-server smoke

`npm run dev` → editor page loads cleanly → console shows no errors
related to the new field.

## Execution phases

**Phase 1 — Schema + persistence verification** (~30 min)
- Add `pin_duration?: boolean` to `ProductionRow`.
- Write the persistence round-trip test FIRST. If it fails, add the
  explicit migrator pass-through.
- Add field to the two external copy-throughs.
- Typecheck + test.

**Phase 2 — Reducer wiring** (~1 h)
- Update `RESIZE_SHOT`, `SET_SHOT_TIMING`, `SPLIT_SHOT`,
  `MERGE_ADJACENT_SHOTS`, `INSERT_BLANK_SHOT`, `PATCH_ROW` (when
  duration in patch).
- Each gets pin set + inverse capture.
- Write reducer tests covering each action + undo path.

**Phase 3 — Render path** (~1 h)
- Re-add `pinnedShots` option to `realignVideoConfig` (cleaner
  version of commit `f560537`, with bounded cascade-forward).
- Wire `productionDocToVideoConfig` to compute the array.
- Add the four render tests.

**Phase 4 — Reset action + popover update** (~45 min)
- New `RESET_SHOT_TIMING` reducer command + tests.
- Context-menu entry in EditorClient.
- Update Set Timing popover to show cascade values directly.
- Remove the aligned-↔-cascade translation logic.

**Phase 5 — Manual verification** (~30 min)
- Walk the manual checklist above on a real project.
- If anything fails, do not commit Phase 6.

**Phase 6 — Commit + push** (~10 min)
- Single commit covering the whole architecture change.
- Detailed commit message with the rationale and the migration
  guarantee.

**Total estimate**: ~4 working hours, ship today if approved.

## Risk assessment

Highest risk: persistence round-trip silently strips the field. The
plan front-loads this test in Phase 1 so the risk is caught before
any other work depends on it.

Second highest: cascade-forward semantics. My previous attempt
extended the shifted shot's duration, causing accumulated drift. The
plan specifies "shift start, keep aligned duration" — different
behavior. Tests verify it bounds correctly.

Third: inverse capture across 6 commands. Each one is a separate
code path. Test-per-action ensures coverage.

Lowest risk: the schema addition itself. Boolean optional field on
an already-opaque row. No serialization concerns.
