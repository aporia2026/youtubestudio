# Outlier filter: precise range sliders

**Date:** 2026-05-13
**Status:** approved, ready to build
**Affects:** niche-finder mode D (outlier finder)

## Goal

The outlier filter bar currently exposes presets as chip rows. Users
want precise numeric control alongside the presets ("between 50K and
500K subs", "videos 30 to 90 days old", "outlier score 2× to 10×").
Add a "Custom ranges" panel below the existing chips with one slider
per numeric dimension. Presets stay as-is; sliders override them only
when actively set.

## Constraints

- No new dependencies. The codebase has no existing slider component;
  build a small in-house dual-handle `RangeSlider` using two stacked
  `<input type="range">` elements with custom styling. Pattern is
  well-trodden, no library needed.
- Match existing styling (12px labels, `#64748b` label colour,
  `#22c55e` green accent, `rgba(255,255,255,0.015)` panel backgrounds).
- Saved presets and built-in presets continue to work without
  migration. Range fields are additive.
- Filter math stays pure and unit-testable.

## Design (approved)

### Layout

Single expandable "Custom ranges" panel rendered below the existing
chip rows inside `OutlierFilterBar`. Chip rows are untouched. The
panel is collapsed by default; expanding it reveals six sliders in a
labelled grid plus a "Clear all" link.

### Per-slider shape

```
Duration       [ 0:30 ]  ──●──────────●── [ 8:00 ]   ⓧ
```

- Left + right number badges show the current min/max values in the
  dimension's natural unit (`0:30`, `5K`, `90d`, `2.5×`).
- Dual-handle slider in the middle with green track between the
  handles, grey track outside.
- Trailing ⓧ clears the range (deletes the field, falls back to chips).
- For published age, both handles still render but min is effectively
  always 0 unless the user drags it. Same semantics, range [a,b]
  reads as "published between `a` and `b` days ago".

### Scale

Log scale on dimensions that span multiple orders of magnitude
(duration, subscribers, views, outlier score). Linear on the rest
(published age, title length). Log is essential for views/subs — a
linear slider crams the 1K–100K range into the leftmost 0.1% of
travel, which is unusable.

Log mapping: slider position `t ∈ [0,1]` → value
`exp(ln(1) + t·ln(max/1)) = max^t`. Handle the `0` minimum by
snapping the value to 0 when `t === 0`.

### Field precedence

For each numeric dimension, the range field — when set — supersedes
the chip-based field. Specifically:

| Range field                 | Supersedes chip field      |
|----------------------------|----------------------------|
| `durationRangeSec`         | `formats`                  |
| `subsRange`                | `channelSizes`             |
| `viewsRange`               | `minViews`                 |
| `publishedAgeRangeDays`    | `publishedWithinDays`      |
| `outlierScoreRange`        | `minOutlierScore`          |
| `titleLengthRange`         | `titleLengths`             |

Dragging a slider clears the corresponding chip field. Clicking a
chip clears the corresponding range field. This keeps one source of
truth per dimension and avoids contradictory filter state.

## Schema

`OutlierFilters` gains six optional readonly-tuple fields. Tuples are
`[min, max]` in the dimension's natural unit. Ranges that equal the
"full range" (covering the whole slider) are treated as "no filter"
and removed from the filter object.

```ts
durationRangeSec?: readonly [number, number];      // 0..14400 (4h)
subsRange?: readonly [number, number];             // 0..50_000_000
viewsRange?: readonly [number, number];            // 0..500_000_000
publishedAgeRangeDays?: readonly [number, number]; // 0..1825 (5y)
outlierScoreRange?: readonly [number, number];     // 0..100
titleLengthRange?: readonly [number, number];      // 0..200
```

## Implementation order

1. **Schema + filter logic.** Add the six new fields to
   `OutlierFilters`. Extend `filterAndSortOutliers` to honour them
   with precedence over the chip-based fields. Pure, unit-testable
   first.
2. **Tests for filter logic.** Cover each dimension: range set,
   range unset (chip fallback), range at full default (no filter).
3. **RangeSlider component.** In-house dual-handle slider with
   pluggable scale (log or linear) and pluggable value formatter.
   Lives at `src/components/niche-finder/RangeSlider.tsx`.
4. **Wire sliders into `OutlierFilterBar`.** Add the "Custom ranges"
   collapsible panel below the existing chip rows. Six sliders in a
   labelled grid. Slider change clears the corresponding chip field;
   chip click clears the corresponding range field.
5. **QA.** Manual sweep of golden + edge paths (range at default,
   range at one extreme, range with min = max, chip + slider
   interaction). Typecheck + full niche-finder test suite.

## Alternatives considered

- **Per-row inline expander.** Each chip row gets a "tune" button
  that expands a slider inline below it. Rejected: more visual
  chrome per row, makes the filter bar feel busy. Single advanced
  panel is calmer.
- **Both modes always visible (no expander).** Sliders below every
  chip row at all times. Rejected: doubles the filter bar height,
  hurts the casual user who only wants quick presets.
- **Replace chip fields entirely with range fields.** Cleaner data
  model (one source of truth per dimension, chips just write
  pre-baked ranges), but requires a saved-preset migration and
  rewrites every chip handler. Defer; v1 stays additive.

## Open questions

None blocking. If users find the log scale jumpy, we can add a
mode-switch in v2 (linear toggle per slider).

## Security / safety

No new attack surface. Filters are client-side over an already-
fetched in-memory array; no new network paths, no new persistence
beyond what saved presets already store.
