# 2026-06-07 — Ripple-delete CapCut semantics

User report: "Timeline is still goofy — if I delete a frame, the frame
to the right is suddenly becoming huge. I want CapCut behavior."

## Root cause

Row duration is derived from inter-row timecode deltas, not stored on
each row. See [src/lib/editor/store.ts:3535](src/lib/editor/store.ts#L3535):

```ts
function naturalRowDurationMs(doc, index) {
  const start = parseTimecodeMs(doc.rows[index]?.timecode);
  if (start === null) return EDITOR_MIN_SHOT_MS;
  const next = doc.rows[index + 1];
  if (!next) return EDITOR_MIN_SHOT_MS;
  const end = parseTimecodeMs(next.timecode);
  if (end === null || end <= start) return EDITOR_MIN_SHOT_MS;
  return end - start;
}
```

Renderer-side equivalent at [src/remotion/utils.ts:297](src/remotion/utils.ts#L297)
(`calcShotIntervals`): each row's natural end = `next row's timecode`
(or `totalDurationMs` for the last row).

`DELETE_SHOT` (ripple) at [src/lib/editor/store.ts:2105](src/lib/editor/store.ts#L2105)
just splices the array — does NOT touch timecodes or
`duration_override_ms`. Consequence:

- Row N-1's `next` was the deleted row at N (timecode T_N). After
  splice, N-1's `next` is the row that was at N+1 (timecode T_{N+1}).
  N-1's natural duration grows from `T_N - T_{N-1}` to `T_{N+1} -
  T_{N-1}` — **balloons by the deleted row's duration**. That's the
  user's "neighbor becomes huge".
- If the deleted row was the LAST row, the new last row's natural
  duration formula changes from inter-row delta to `totalDurationMs -
  newLastRow.tc` — also balloons.
- If the deleted row was the FIRST row, the new first row's timecode
  is unchanged so the rendered timeline starts at that timecode,
  leaving a leading gap.

## Fix shape

CapCut model: each clip owns its own duration; deleting one shifts
positions, not sizes. Map that onto our model surgically inside
`DELETE_SHOT` (ripple):

1. **Lock the left neighbor's duration.** If the deleted row's left
   neighbor (`rows[shotIndex - 1]`) has no `duration_override_ms`,
   stamp one equal to its current effective duration. That row's
   natural-duration formula is about to change; stamping locks it.

2. **Lock the new-last-row's duration.** If the deleted row is the
   LAST row, the new last row is `rows[shotIndex - 1]` (already
   handled above). Otherwise the last row is unchanged. But if we
   shift later timecodes (step 3), the last row's natural-duration
   formula (`totalDur - lastRow.tc`) yields a bigger value because
   the tc moved left. Stamp `duration_override_ms` on the last row
   too unless it already has one.

3. **Shift later timecodes left by deleted duration.** Every row at
   index ≥ shotIndex (after splice) gets its `timecode` decreased
   by `deletedEffectiveMs`. This makes the timeline visually ripple
   like CapCut: the deleted slice vanishes, everything after it
   slides left, durations stay the same.

4. **Inverse for undo.** `RESTORE_ROW` (mode 'insert') grows an
   optional `restoreRowFields?: Array<{ rowIndex, prevTimecode?,
   prevDurationOverrideMs? }>` so undo can restore the original
   timecodes + clear the stamped overrides. The indices are
   post-restore (i.e., positions in the array AFTER the deleted
   row is re-inserted).

## Why this preserves existing behaviour

- Rows that already had `duration_override_ms` keep it. No stomp.
- Rows without an override: we stamp a value equal to their current
  effective duration. The cascade then produces the same per-row
  width as before, but timecode-independence is restored.
- Selection logic, image reindexing, and the inverse semantics all
  carry over from the current ripple path.
- `total_duration` on the doc stays as-is (a string field used for
  display + the `calcShotIntervals` last-row natural-duration
  formula). The stamped overrides on the last row make that formula
  irrelevant for the post-delete cascade.

## Tests

`tests/timeline-mutations.test.ts` (extend):

- Deleting a middle row preserves each surviving row's effective
  duration. (Reproduces the user's exact bug.)
- Deleting the LAST row preserves the new-last row's duration.
- Deleting the FIRST row preserves remaining rows' durations AND
  makes the new first row's timecode 0.
- Undo restores both the deleted row and the original timecodes +
  override fields on every modified neighbor.
- Pre-existing per-row `duration_override_ms` is preserved (we don't
  overwrite).

## Observability

- New log namespace on the delete branch: `[editor delete-shot
  ripple]` with `{ shotIndex, deletedDurationMs, stampedLeftNeighbor,
  stampedLastRow, shiftedTimecodeCount }`.

## Out of scope

- `DELETE_VARIANT_ROW` — variants live in alternate groups and may
  not occupy distinct timeline slots in the same way. Will tackle
  separately if the user reports the same symptom there.
- `MERGE_ADJACENT_SHOTS` — already uses `restoredDurationOverrideMs`
  in its inverse path; behaves correctly for its scope.
- Refactoring the codebase off timecode-derived durations entirely
  — much larger change; this surgical fix removes the user-visible
  symptom now.
