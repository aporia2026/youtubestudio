# Flex Icon Grid — Phase 2 + Phase 1 limit fixes

**Date:** 2026-05-28
**Status:** Approved (user said "fix the limits then continue to next phase")
**Parent plan:** [2026-05-28-flex-icon-grid-thumbnail-template.md](2026-05-28-flex-icon-grid-thumbnail-template.md)

---

## 1. Goal

Close the four Phase 1 limitations the user flagged, then push Phase 2 of the new format: more cell shape variety, per-cell gradient/pattern backgrounds, cell-merge for hero-tile layouts, and AI-generated stickers per cell via the collage-mode pattern your existing image flow already uses.

## 2. Limit fixes (Phase 1.5)

### 2.1 Wire history persistence for `flex-icon-grid`
- Page already has `flexIconGridResult` state and the schemas extend `ThumbnailHistoryEntry['format']` + `FlexIconGridHistoryPayload`. The missing piece is a `useEffect` that calls `saveThumbnailEntry` whenever `flexIconGridResult` transitions to a new non-null value — mirrors the existing topic-card-grid / n-levels save effects.
- Restore: extend the `loadFromHistory` switch in the page to handle `entry.format === 'flex-icon-grid'`, populate `flexIconGridResult`, and switch the format dropdown.

### 2.2 Wire draft persistence for `flex-icon-grid`
- Page already has `flexIconGridDraftSnapshot` state and `ThumbnailsDraftState.flexIconGrid` field. Wire a `useEffect` that folds the snapshot into the workflow draft, and a hydration effect that pushes `restoredDraftState` into the panel when the page hydrates from a draft.

### 2.3 Persist brightness/detail on existing panels
- Both `TopicCardGridPanel` and `NLevelsPanel` have new `brightness` + `detailLevel` state. Add `localStorage` round-trip with `_PREF_KEY` constants matching the existing pattern (`IMAGE_MODEL_PREF_KEY`, `CARD_SHAPE_PREF_KEY`).

### 2.4 Bundle Twemoji for server-side emoji rendering
- Composer's emoji rendering currently relies on system fontconfig. On Vercel Linux this produces missing-glyph boxes.
- Solution: ship a `twemoji-svg-resolver` module that maps a codepoint to a bundled SVG file from `@twemoji/svg` (or equivalent). The composer's `buildEmojiOverlay` switches from sharp-text to sharp-image, inlining the SVG.
- Cost: zero (Twemoji is CC-BY-4.0, ~5MB of SVG when all bundled, but the resolver only loads on-demand per cell).
- **Verify before installing:** which Twemoji package is current on npm. Run `npm info twemoji` and `npm info @twemoji/api`; per rule 1, no assumptions about which one is canonical.

## 3. Phase 2 features

### 3.1 New cell shapes (hexagon, pill, capsule)
- Extend `CellShape` union: `'circle' | 'square' | 'rounded-square' | 'hexagon' | 'pill' | 'capsule'`.
- Composer + live preview: add SVG path emitters per shape.
  - Hexagon: regular flat-top hex inscribed in the cell rect.
  - Pill: vertical capsule (rounded top + bottom, straight sides).
  - Capsule: horizontal capsule (rounded left + right, straight top + bottom).
- Shape mask SVG: extend `shapeMaskSvg` in the composer to emit clip-path geometry per shape.
- Editor: extend the `SHAPE_OPTIONS` chip row in the panel.

### 3.2 Per-cell gradient + pattern backgrounds
- Extend per-cell `backgroundColor` (string) to per-cell `background?: CellBackgroundSpec` where:
  ```ts
  type CellBackgroundSpec =
    | { type: 'solid'; color: string }
    | { type: 'gradient'; from: string; to: string; angle: number }
    | { type: 'pattern'; pattern: 'dots' | 'stripes' | 'grid'; fg: string; bg: string }
    | { type: 'image'; url: string };
  ```
- Backwards compat: `cell.backgroundColor` remains valid; resolver treats it as `{ type: 'solid', color }`.
- Composer: emit appropriate SVG (linearGradient, pattern definition, embedded image) per-cell.
- Panel: gradient picker (from + to + angle slider), pattern picker (three preset patterns).

### 3.3 Cell-merge (hero + smaller cells)
- Add a `cellSpan?: { rows: number; cols: number }` field on `FlexIconCell`. A cell with `cellSpan: { rows: 2, cols: 2 }` occupies a 2×2 block instead of one cell.
- Conflict resolution: when a cell spans into another cell's slot, the spanning cell wins and the displaced cell is dropped from rendering (the editor marks it as "consumed by cell N").
- Layout math: extend `computeCellRect` to handle spans, return the merged rect.
- Editor: per-cell side panel adds row-span / col-span pickers, capped at remaining-rows / remaining-cols.

### 3.4 AI stickers via collage-mode generation
- New `CellContent` variant: `{ type: 'ai-sticker'; prompt: string; url?: string }`.
- New route: `/api/thumbnails/format/flex-icon-grid/generate-stickers` — takes a list of cell indexes + prompts, generates a SINGLE collage image via the existing image flow (matching the user's existing "Generate 4 shots at once (collage mode), ~75% cheaper" toggle), crops the result into per-cell sticker URLs, returns `{ stickers: Record<cellIndex, url> }`.
- Composer: treats `ai-sticker` cells the same as `upload` cells once the sticker URL is set.
- Editor: per-cell "Generate sticker" button + sticker prompt input. Bulk "Generate all stickers" button collages everything in one call.
- **Cost flag (rule 8):** AI sticker generation costs $0.04–0.10 per image-gen call. Collage mode reduces this ~75% by packing 4–9 stickers per call. Even with collage mode, this is the only Phase-2 feature with non-zero per-render cost — surface the estimated cost in the UI before the user generates.

## 4. Phasing (execution order)

1. **Section 2 — limit fixes** (4 small tasks, low risk, ship together).
2. **Section 3.1 — new cell shapes** (pure visual addition, no schema risk).
3. **Section 3.2 — per-cell backgrounds** (schema extension; backwards-compat path preserves existing thumbnails).
4. **Section 3.3 — cell-merge** (schema extension; layout math change).
5. **Section 3.4 — AI stickers via collage** (new external surface; biggest piece).
6. **Phase 2 tests + QA pass.**

## 5. Security (rule 13)

- AI sticker prompts go through `sanitizeUserText` before being interpolated into the image-gen prompt. No prompt injection surface beyond what the existing format-grid image route already accepts.
- Cell-merge consumed-cell handling must not leak labels of the consumed cells into the rendered output — the panel and composer both filter to non-consumed cells when building the render list.
- Pattern backgrounds use a fixed set of three patterns (no user-supplied SVG fragments), so the pattern picker can't be used as an SVG injection vector.
- Twemoji SVGs come from a bundled static source (verified at install time), not fetched at runtime — same threat model as the Lucide registry.

## 6. Observability (rule 14)

New log channels:
- `[flex-icon-grid stickers]` — sticker generation: cell indexes requested, model used, collage size, per-cell crop times.
- `[flex-icon-grid panel cell-merge]` — span apply / span clear events, consumed-cell list.
- `[flex-icon-grid panel sticker]` — prompt edits, generation start/done per cell.

## 7. Settings (rule 15)

Per-thumbnail (not workspace) in Phase 2:
- New shape options exposed in the existing shape chip row.
- Per-cell background picker (solid / gradient / pattern / image).
- Per-cell span pickers.
- Per-cell AI sticker prompt.

Workspace settings still deferred to Phase 3 (saved palettes, saved layouts, default font).

## 8. Cost (rule 8)

- **Sections 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3:** $0 incremental per render.
- **Section 3.4 (AI stickers):** per-image-gen cost depends on the chosen model. Collage mode bundles 4 stickers per call (≈$0.04–0.10 total) or 9 stickers per call (same cost, better per-cell ratio). **Verify live pricing** before shipping — same rule as the parent plan.

## 9. Open questions

- For cell-merge: do we allow non-rectangular spans (e.g. an L-shape)? Default answer: NO — rectangle only. Easier to reason about, easier to render, matches reference channels' visual language.
- For AI stickers: do we let users supply a reference image for the sticker style, or rely on the prompt alone? Default: prompt-only in 2.4, reference image as Phase 3.
- Twemoji license footprint: confirm Twemoji's CC-BY-4.0 attribution requirement is met by a project-level NOTICE file rather than per-thumbnail watermarking.

## 10. Definition of done (Phase 2)

- All four Phase 1 limits closed.
- All six cell shapes render correctly server-side and in the live preview.
- Per-cell backgrounds render correctly for solid / gradient / pattern / image variants.
- Cell-merge: spans render correctly, consumed cells are dropped from the output, the editor surfaces span pickers and conflicts.
- AI stickers: end-to-end flow works for one cell, for all cells in collage mode, and the cost flag is visible in the UI.
- Tests cover: shape geometry, gradient/pattern SVG emission, cell-merge layout math, sticker collage crop math.
- QA pass per rule 6: golden path + edge cases for every new surface.
