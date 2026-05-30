# Topic Card Grid — uniform label sizing + size-multiplier slider with live preview

**Date:** 2026-05-30
**Status:** approved
**Related:** `_plans/2026-05-30-topic-card-grid-alignment-and-style-selector.md`

## Goal

After the r2.4.1 photoreal divider fix the label sizes are *close* but
still not perfectly uniform across the grid — a cell whose detected
divider lands at 78% gets a slightly smaller font than a cell whose
divider lands at 82%, because each band's `fontPt` is computed from its
own measured height. The user wants:

1. **Uniform sizing.** Same font size across every cell, deterministic
   regardless of detection drift.
2. **A size multiplier control.** Slider 50%–150% with default 100%, so
   the user can dial labels tighter or bigger depending on the niche.
3. **A live preview.** A small band-shaped strip showing "Sample Label"
   in Patrick Hand at the chosen size, updating as the slider moves —
   no API round-trip needed to see the effect.

## Constraints

- Default flows (slider at 100%) must produce label sizes that visually
  match the post-r2.4.1 output for cells whose detection landed cleanly.
  No surprise regressions.
- The composite still has to render the label inside the actual band
  rectangle even when uniform sizing produces a font slightly larger
  than the band — fall back to resize-inside in that case so the label
  never overflows. The uniformity goal is "computed identically," not
  "rendered identically regardless of band geometry."
- The preview must load Patrick Hand from the existing
  `public/fonts/PatrickHand-Regular.ttf` so the typography matches the
  rendered output exactly. No new font assets.

## Approach

### Composite (`src/lib/thumbnail-formats/topic-card-grid-composite.ts`)

- Add an optional `fontPt?: number` parameter to `renderLabelPng`. When
  provided, the Pango `font` string uses it directly; when omitted,
  fall back to the current `Math.round(targetH * 0.55)` heuristic so
  callers that don't care about uniform sizing keep working.
- Add an optional `fontPt?: number` parameter to
  `buildSquareLabelBandOverlay` and `buildSquareCellOverlay`. They
  thread it through to `renderLabelPng`.
- In `applyCellUploads`, compute one canonical `fontPt` once at the top
  of the function from the layout's canonical cell height:
  ```ts
  const canonicalCellH =
    (layout.height - 2 * layout.outerMargin - (layout.rows - 1) * layout.gutter) /
    layout.rows;
  const canonicalBandH = Math.round(canonicalCellH * 0.2);
  const baseFontPt = Math.max(12, Math.round(canonicalBandH * 0.55));
  const fontPt = Math.max(8, Math.round(baseFontPt * labelSizeMultiplier));
  ```
  Pass `fontPt` to every overlay call so every cell renders its label
  at the same size, regardless of detected band height drift.
- Accept `labelSizeMultiplier` as a new optional `ApplyCellUploadsInput`
  field. Defaults to `1.0`.

### Types + API

- `src/lib/thumbnail-formats/topic-card-grid.ts`: export
  `LABEL_SIZE_MIN = 0.5`, `LABEL_SIZE_MAX = 1.5`, `DEFAULT_LABEL_SIZE = 1.0`.
- `src/app/api/thumbnails/format/topic-card-grid/image/route.ts`:
  accept `body.labelSize: number`, clamp to `[LABEL_SIZE_MIN,
  LABEL_SIZE_MAX]`, default to `DEFAULT_LABEL_SIZE`. Thread into
  `applyCellUploads` as `labelSizeMultiplier`. Log under
  `[thumb-format-grid image] start`.

### Panel (`src/components/thumbnails/TopicCardGridPanel.tsx`)

- Add `labelSize: number` state with `localStorage` persistence
  (key: `topic_card_grid_default_label_size`).
- Surface a slider control between the Style selector and the Mode
  chips, labelled "Label size" with the current percentage next to it.
- Live preview directly below the slider — a `<div>` shaped like a
  rendered band (white background, black border, fixed aspect ~5:1)
  with "Sample Label" in Patrick Hand at the chosen size.
- Load Patrick Hand as a CSS web font via `@font-face` (TTF served
  from `/fonts/PatrickHand-Regular.ttf`). Avoid Next.js `next/font`
  to keep the change small — direct `<style>` block in the panel is
  fine because the panel is the only consumer.
- Thread `labelSize` into the fetch body and the draft-state writeback.

### Tests

- `tests/topic-card-grid-composite.test.ts`:
  - `applyCellUploads` produces uniform label sizes across cells when
    cells have slightly different detected band heights (synthetic
    base where cells 1+2 trigger divider detection at different y
    positions). Decode the result, locate each label's bounding box,
    assert the heights are within ±2 px of each other.
  - `labelSizeMultiplier === 1.5` produces visibly larger labels than
    `1.0`; `0.5` produces smaller labels. Verify via the same height
    measurement.
- `tests/topic-card-grid.test.ts`: assert the exported constants
  (`LABEL_SIZE_MIN`, `LABEL_SIZE_MAX`, `DEFAULT_LABEL_SIZE`) have the
  expected values.

## Security

- `labelSize` is a clamped number — no string interpolation, no
  injection surface.
- The preview reads the bundled TTF from `/public/fonts/` via the
  app's static-asset path. Same CSP scope as everything else served
  from `public/`. No new origins.

## Observability

- `[topic-card-grid composite font-size]` — once per
  `applyCellUploads` call. Logs `canonical_band_h`, `base_font_pt`,
  `multiplier`, `font_pt_applied`. Lets us correlate a size complaint
  with the chosen multiplier.
- `[topic-card-grid panel label-size change]` — fires on slider
  change. Logs `from`, `to`.
- Existing `[thumb-format-grid image] start` gains a `label_size`
  field.

## Settings audit

- The slider + preview lives in the Topic Card Grid panel beside the
  existing Style / Brightness / Detail knobs. Per-thumbnail-format —
  not a global setting.
- Persisted to `localStorage` so a repeat user lands back on their
  preferred multiplier.
- Default 100% matches the current output, so users who never touch
  the control see no behaviour change.

## Lazy-user check

- The slider auto-resets to 100% if `localStorage` is empty — first-
  time users get the exact behaviour they had before.
- The percentage label next to the slider always shows the current
  value (`100%`), so the user never has to wonder where the default is.
- The preview makes "is this too big / too small" answerable in one
  glance, without needing to generate.

## Out of scope

- Per-card font-size override. Defer.
- Font family override (e.g., let the user pick a different font).
  Defer — Patrick Hand is the format's signature typography per the
  bundled reference.
- Circle-mode label-size control. Defer; circle mode doesn't currently
  uniformise labels (see `applyCellUploads`).
