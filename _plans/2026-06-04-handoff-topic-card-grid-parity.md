---
date: 2026-06-04
status: handoff
follows_up_on: _plans/2026-06-04-topic-card-grid-circle-parity.md
branch: claude/video-creation-ui-pqXzS
---

# Handoff — Topic Card Grid Circle Parity (continuation)

## What's already shipped (this session)

All on `claude/video-creation-ui-pqXzS`, pushed to origin.

| Commit | Scope |
| --- | --- |
| `8ff30e8` | **Phase 1 — bug fix**: flat-bottom circles fixed in **both** browser preview (clipPath) and server export (`circularBorderSvg` + masked composite). Black border forced on all circles. 3 regression tests pinning the fix. |
| `d9fe452` | **Phase 2a — data model**: optional `borderWeight` / `labelPosition` / `labelCase` / `fillStyle` / `overlapLabelStroke` on `GridLayout`; `sourceImageUrl` / `cutoutImageUrl` on `TopicCard`. Six named presets via `cardStylePresetAxes()` + `CARD_STYLE_PRESETS`. |
| `acbe4bd` | **Phase 2b — browser renderer**: `FreeFormCellGroup` honors all 5 axes. Precedence collapsed into `useCutout` / `useIcon` / `useImage` / `useEmoji` flags. Cutout / image / icon / emoji branches gated by the precomputed flag. Label rendering branches on `labelPosition`, `labelCase`, and `overlapLabelStroke`. |
| `d6a29cc` | **Phase 2c — bg-removal**: new `src/lib/grid-bg-removal.ts` (sibling to `overlay-rmbg.ts`, but hits `851-labs/background-remover` at ~$0.00044/image) + new `POST /api/thumbnails/grid-rmbg` route with auth, rate-limit, audit, R2 mirror. |
| `b4f3e11` | **QA pass**: scoped `fillStyle` to circles only, clipped the cutout image to the disc defensively, fixed a docstring drift, added 7 axis-coverage tests. |

**Total test surface**: 181 tests across 6 files green. Type-check clean.

The user's original complaint (flat-bottom circles) is **completely fixed end-to-end** — preview AND export. They can ship today; the rest is parity polish.

## What's still to do

Three logical phases left. Land them in this order so each one stays independently reviewable.

### Phase 2d — UI controls + 6-preset row in `TopicCardGridPanel`

**File**: `src/components/thumbnails/TopicCardGridPanel.tsx` (2,400+ lines; ~5 distinct insertion points).

**The shape of the work**:

1. Add five state hooks next to the existing `cardShape` hook (around line 1237), each mirroring its pattern (localStorage prefkey + initialiser + `useEffect` writer). One `useState` per axis OR one JSON-serialised `useState` for all five — both work. Pref keys go alongside the existing `CARD_SHAPE_PREF_KEY` at lines 398–413.

   Axes to wire: `borderWeight`, `labelPosition`, `labelCase`, `fillStyle`, `overlapLabelStroke`.

2. Add a new "Card Style" section in the JSX directly below the existing "Card shape" section at lines 2236–2272. Two visual rows:
   - **Preset row** (6 buttons): `import { CARD_STYLE_PRESETS, cardStylePresetAxes } from '@/lib/thumbnail-formats/topic-card-grid'`. Click handler dispatches `cardStylePresetAxes(preset.id)` and writes all six axes at once.
   - **Per-axis controls** (5 segmented-button rows): mirror the existing Card shape toggle style at lines 2244–2266. The Overlap stroke row is conditional on `labelPosition === 'overlap'`.

3. Thread the new axis values into the `FreeFormCell[]` the panel builds for `<ThumbnailRenderer>`. The `FreeFormCell` type already has all five axis fields (shipped in `acbe4bd`). Find where the panel builds cells for the renderer (`FreeFormPreviewPanel` at line ~4169, and look for where `freeFormCells` maps to renderer input). Make sure every built cell gets the panel-level axis values.

4. Plumb the axes into the persistence path. The panel serialises its state for saved-presets / re-load (search for `cardShape` to find all the spots — e.g. lines 1614, 1641, 1673, 1695, 1709). Each occurrence is where the 5 axes also need to round-trip.

5. **Cutout on upload** — when a user uploads an image to a card AND the active `fillStyle === 'cutout'`, fire a `fetch('/api/thumbnails/grid-rmbg', { ... })` call with the uploaded R2 URL. Store the returned `cutoutUrl` on the card. The route is rate-limited at 20/min/IP and audited; the wire is already in place. Skip the call if the upload already has alpha (sniff PNG `tRNS` or 4-channel data before calling).

   Suggested log namespace: `[topic-card-grid panel cutout]` with `{ cardIndex, source: 'auto' | 'user-alpha', durationMs, ok }`.

6. **Row spacing slider** — `GridLayout.rowGutter?: number` was added in commit `<row-gutter commit>`. Default behaviour: circle layouts get `gutter * 1.8` automatically; square layouts stay at `gutter`. Add a slider in the editor labelled "Row spacing" with range ~`gutter` (tight) to ~`gutter * 3` (airy), default at the computed value. Persist alongside the other axes via localStorage. The geometry already flows the value through `computeRegions`, `computeCircleRegions`, and `cellRect` — UI just needs to write it.

7. **Settings audit** per rule 15: all five axes plus rowGutter persist per-thumbnail via localStorage. No global app-settings entry yet — propose adding one only if the user asks.

### Phase 3 — Server Sharp composite parity

**File**: `src/lib/thumbnail-formats/topic-card-grid-composite.ts`. Specifically `buildCircleCellOverlay` at line ~1520 plus its caller `applyCellUploads` around line 1224.

**The work**:

1. Extend `ApplyCellUploadsInput` (line ~112) with the five new style fields (mirror `cardShape` exactly).

2. Pass the five fields from `applyCellUploads` into `buildCircleCellOverlay`. Update the signature.

3. Inside `buildCircleCellOverlay`:
   - **borderWeight**: replace the hardcoded `0.006` (line 1546) with `borderWeight === 'thick' ? 0.016 : 0.006`. **Known interim issue today** — server always paints 'thin'.
   - **labelCase 'upper'**: uppercase the label string before passing to `renderLabelPng`.
   - **labelPosition 'overlap'**: change the `labelTop` calculation (line 1569) so the label PNG composites at `discTop + discD + 1 - labelTextH * 0.5` instead of below the disc. The label fontPt also needs to be larger in overlap mode (the existing band-derived size is sized for the 20% band, not the overlap visual; pick a disc-relative size like `discD * 0.13`).
   - **overlapLabelStroke**: extend `renderLabelPng` to accept a `{ fillColor, strokeColor, strokeWidth }` shape and pass it into Pango's text rendering. Pango supports stroked text via `markup` syntax (`<span foreground='white' background='black'>...</span>` won't work for stroke; need to use cairo's stroked-text path). This is the heaviest sub-task — may need a Context7 lookup on Pango/Cairo for the exact API.
   - **fillStyle 'cutout'**: skip the masked-photo step entirely. Paint a coloured disc (using `card.accent_color` or the layout's default), then composite the cutout PNG at ~80% disc size centred, then composite the border.
   - **fillStyle 'icon'**: same as cutout but composite an SVG icon (existing `iconSlug` infrastructure) instead of the cutout PNG.

4. Update `circleCellGeometry` if the overlap label position changes the label-area height calculations. Probably not — the geom helper returns positions, the actual painting decides what sits where.

5. Tests: extend `tests/topic-card-grid-composite.test.ts` (46 tests today) with a few snapshot-style checks asserting the output PNG has a black border, the label is uppercased in 'upper' mode, etc.

### Phase 4 — Snapshot test fixtures

**New file**: `tests/topic-card-grid-snapshot.test.ts`.

Render 6 thumbnails (one per `fillStyle × labelPosition` combo: photo+below, photo+overlap, cutout+below, cutout+overlap, icon+below, icon+overlap) to a fixtures folder. Compare via Sharp pixel diff with 1% tolerance.

The fixtures live at `tests/fixtures/topic-card-grid-snapshot/`. First run records; subsequent runs compare. Snapshot tests are heavier — they're the cross-axis smoke test.

Also add `tests/grid-bg-removal.test.ts` with mocked `fetch`: assert (a) skips call when input has alpha, (b) caches result on the card, (c) error path returns clear error and doesn't block render.

### Phase 5 — Final QA + ship

After Phase 4: run the full suite (`npm test`), spin up the dev server, manually verify each preset in the editor (Photo Tile, Cutout Pop, Icon Grid, Caps Overlay, Mystery Doc, Cartoon Bold) and confirm the export PNG matches the preview. Update the plan doc's status to `shipped`.

## Files that already have the foundations

Don't waste time re-reading these unless your phase touches them:

- `src/components/thumbnails/ThumbnailRenderer.tsx` — browser renderer with all 5 axes, clipPath, forced-black border. `FreeFormCell` type has every field you need.
- `src/lib/thumbnail-formats/topic-card-grid.ts` — data model, presets, `cardStylePresetAxes()`, `CARD_STYLE_PRESETS`.
- `src/lib/thumbnail-formats/topic-card-grid-composite.ts` — server composite with the bug-fix `circularBorderSvg` already in place. Server still paints 'thin' border and ignores the other 4 axes.
- `src/lib/grid-bg-removal.ts` — Replicate client. Just call it from the panel.
- `src/app/api/thumbnails/grid-rmbg/route.ts` — POST endpoint. Body shape: `{ sourceImageUrl: string, cardIndex?: number }`. Returns `{ cutoutUrl: string }`.
- `tests/thumbnail-renderer.test.tsx` — pattern to copy for any browser-side regression tests.

## Known interim states (acceptable but flag-worthy)

1. **Server composite ignores the 5 axes**: today's export will still look like the legacy circle style (thin border, label below, no stroke, no cutout) even after the user picks a non-default style in the editor. The black-border invariant is the only axis the server respects. Closing this gap is Phase 3.

2. **`mystery-doc` and `caps-overlay` presets emit identical axis values**: the difference is in the description ("pair with a B&W filter") — left intentionally as a UX hint. If the user complains, drop one or differentiate by a sixth axis.

3. **`useImage` precedence on non-circle cells**: I scoped `fillStyle` to circles only (commit `b4f3e11`), so non-circle behaviour is unchanged from before all of this work. Verified by `fillStyle on non-circle shapes is ignored` test.

4. **Bg-removal cost audit**: hardcoded `$0.00044` in the route. If Replicate changes pricing, the audit row drifts from reality. Acceptable until the next pricing change — low blast radius, easy to update.

## Things NOT to do in the fresh session

- Don't refactor `FreeFormCell` — the type is shared with other thumbnail formats, and the additive fields are correctly optional.
- Don't change the bug-fix commits (`8ff30e8`) — they're shipped, tested, and not safe to amend after push.
- Don't break the legacy precedence on non-circle cells. The QA pass specifically pinned this with a test.
- Don't pick a different bg-removal provider without asking the user — they chose `851-labs/background-remover` after a pricing comparison.
- Don't add a global app-settings entry for the 5 axes — the user picked per-thumbnail localStorage persistence only.

## How to resume

```bash
git checkout claude/video-creation-ui-pqXzS
git pull
npm install   # if dependencies have moved
npm run dev   # verify the bug fix is visible: open any existing topic-card grid in the editor
```

Open this file. Pick the next phase. The plan doc (`_plans/2026-06-04-topic-card-grid-circle-parity.md`) has the original architecture in case you need the full context.
