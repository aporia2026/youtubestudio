# Editor shot-type filter

**Date:** 2026-06-02
**Status:** Approved, in progress

## Goal

Let the user filter the editor's SHOTS rail by shot kind (Titles, Collages, Motion, Animations, Statistics, B-Roll, Blank) and variant grouping (Bases, Variants). Multi-select within each axis, AND across axes, persisted per project.

## Constraints

- The SHOTS rail is narrow (~280–320 px). Nine chips won't fit on one row → horizontal scroll OR hide chips with count 0. We hide zero-count chips.
- Selection by index must still map to the *original* row index, not the filtered position. The timeline, preview, and inspector all key off the true row index.
- Filter state must persist across page reloads, per project, without a DB write on every click.
- Must coexist cleanly with the existing chip / badge system in `ShotKindBadge.tsx` — single source of truth for "what kind is this row" to prevent drift between filter and chip label.

## Requirements

- Chip strip above the SHOTS list with: All N • Titles (T) • Collages (C) • Motion (M) • Animations (A) • Statistics (S) • B-Roll (B) • Blank (X) | Bases (B) • Variants (V) | Clear (only when filter active).
- Each chip shows its count. Chips with count 0 are hidden.
- Click toggles selection (chip already on → turn off).
- Selecting a chip in a row OR's within that row; the two rows (kind, grouping) AND together.
- Empty filter = show everything.
- Persisted per project in `localStorage` under key `editor:shot-filter:{projectId}`.
- Currently-selected shot stays selected even if it becomes filtered out (we don't auto-jump).

## Chosen approach

State lives in `EditorClient` (which already owns `rows` and `selectedShotIndex`). It computes `visibleRows` once per render and passes the filtered list + true-index mapping into `ShotsTab`. The chip strip is rendered inside `ShotsTab` and emits `onFilterChange`.

A pure helpers module `src/lib/shot-filter.ts` owns the discriminant resolver, the predicate, and the localStorage serializer. `ShotKindBadge.tsx` is refactored to consume the discriminant from this module so the chip label and the filter axis never drift apart.

## State shape

```ts
type ShotKind = 'title' | 'collage' | 'motion' | 'anim' | 'stat' | 'broll' | 'blank';
type ShotGrouping = 'base' | 'variant';

type ShotFilter = {
  kinds: ShotKind[];          // empty = no filter on this axis
  grouping: ShotGrouping[];   // empty = no filter on this axis
};
```

Sets get serialized as sorted arrays for stable localStorage values.

## Filter predicate

```ts
function passes(row, filter) {
  const kindOk = filter.kinds.length === 0 || filter.kinds.includes(rowKind(row));
  const grpOk  = filter.grouping.length === 0 || filter.grouping.includes(rowGrouping(row));
  return kindOk && grpOk;
}
```

`rowKind(row)` mirrors `resolveShotKindLabel`'s precedence: `shot_kind === 'motion_collage'` → `collage`; `shot_kind === 'motion'` → `motion`; `visual_type === 'Title Card'` → `title`; `'Statistics'` → `stat`; `'B-Roll'` → `broll`; `'blank'` → `blank`; else → `anim`.

`rowGrouping(row)` returns `'variant'` if `group_id && variant_index > 0`, `'base'` if `group_id && variant_index === 0 && groupSize > 1`, else `null` (no chip applies).

## Persistence

- `localStorage` key: `editor:shot-filter:{projectId}`.
- Value: JSON of `{ kinds, grouping }` with arrays (not Sets).
- Read on mount, gated by `typeof window !== 'undefined'`.
- Write on every change (debounced 250 ms via a `useEffect` + timer).
- Schema-bump strategy: on parse failure, fall back to empty filter and overwrite. No migration needed for v1.

## Selection behavior under filter

- Filtered list maps row index → original index. Clicking shot N in the visible list selects the original row.
- If the selected shot becomes hidden by the filter, **selection stays put**. The user can still see what's selected in the timeline / preview; they just don't see the row in the rail. Less surprising than auto-jumping.

## Settings audit (rule 15)

The filter itself is the setting. It's per-project ephemeral state, not a global preference, so no entry in the global settings panel. If we later want a "default filter" global preference, it would slot in as a Settings → Editor → "Open SHOTS panel with filter" toggle — out of scope for v1.

## Observability (rule 14)

- `[editor shot-filter] applied { kinds, grouping, visible_count, total_count }` — on every filter mutation.
- `[editor shot-filter] restored { project_id, kinds, grouping }` — once on mount when localStorage had a saved filter.
- `[editor shot-filter] cleared { project_id }` — when the user hits Clear.
- `[editor shot-filter] parse-failed { project_id, raw_length }` — when localStorage value is corrupt; we fall back to empty filter.

## Security (rule 13)

- Pure client state. No PII. No secrets. `localStorage` value is bounded (< 200 bytes for any conceivable filter).
- `JSON.parse` is wrapped in `try/catch` with a defensive fallback — no exception escapes to the UI.
- Project ID is treated as opaque; not sanitized into the key (it's a UUID, key collisions are not a concern).

## Testing (rule 18)

Unit tests in `tests/shot-filter.test.ts`:

- `rowKind` for each of the 7 visual_type / shot_kind discriminants (including ambiguous cases, e.g., a `motion_collage` with `visual_type='Title Card'` resolves to `collage` because shot_kind wins).
- `rowGrouping` for: ungrouped row, base of 1-shot group (returns null — groupSize > 1 required), base of multi-variant group, variant > 0.
- `passes` predicate: empty filter passes everything; kind-only filter; grouping-only filter; both-axis filter; both-axis with no match.
- `serializeFilter` / `parseFilter` round-trip preserves equality (sorted-array invariant).
- `parseFilter` on garbage input returns empty filter without throwing.

UI test for the chip-rendering component is deferred — the visual change is small and the logic tests cover the discriminant + predicate risk.

## Alternatives rejected

- **Funnel icon → popover.** Saves space but hides the filter behind a click. Fails the lazy-user bar (rule 10).
- **Single-axis chips.** Simpler but the user explicitly asked for both kind and grouping. Rejected.
- **Server-side persistence in the project record.** Adds a DB write on every chip click. localStorage is right.
- **Auto-jump to first visible row when selected row is hidden.** Surprising; loses the user's place. Rejected.

## Files touched

- **New:** `src/lib/shot-filter.ts` — pure helpers (`rowKind`, `rowGrouping`, `passes`, `serializeFilter`, `parseFilter`, type exports).
- **New:** `tests/shot-filter.test.ts`.
- **Edit:** `src/components/editor/ShotKindBadge.tsx` — re-export `rowKind` discriminant so badge + filter share resolver.
- **Edit:** `src/components/editor/leftrail/ShotsTab.tsx` — chip strip at top, props for `filter` + `onFilterChange` + `counts`.
- **Edit:** owner of `ShotsTab` (probably `EditorLeftRail.tsx` or `EditorClient.tsx`) — own filter state, compute counts and visible rows, persist to localStorage.

## Open questions resolved

- Chip click is toggle (off if already on). Confirmed.
- Hide chips with count 0. Confirmed.
