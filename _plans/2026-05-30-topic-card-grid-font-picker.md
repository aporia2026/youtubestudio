# Topic Card Grid — font picker (22 curated Google Fonts, server allowlist, live preview)

**Date:** 2026-05-30
**Status:** approved
**Related:** `_plans/2026-05-30-topic-card-grid-label-size-control.md`

## Goal

Today the topic-card-grid label is locked to Patrick Hand. The user
wants a font picker with a wide range, including Google Fonts, with a
live preview of each option in its own typography. Patrick Hand stays
the default so existing flows render identically on first generation.

## Approved scope

- **22 curated Google Fonts**, bundled as static TTF files in
  `public/fonts/thumbnail-grid/`:
  - Hand-drawn (5): Patrick Hand (default), Caveat, Permanent Marker,
    Architects Daughter, Kalam
  - Bold display (6): Bebas Neue, Anton, Bowlby One, Bungee,
    Black Ops One, Bangers
  - Editorial serif (3): Playfair Display, DM Serif Display, Merriweather
  - Modern sans (4): Inter, Poppins, Montserrat, Roboto
  - Retro / Stylized (4): Pacifico, Press Start 2P, Monoton, Russo One
- **Picker UI:** categorized dropdown with section headers, each
  option's label rendered in its own font (Figma-style).
- Existing label-size preview band picks up the selected font so the
  user sees the actual font + size combo before generating.
- Server-side allowlist validation: unknown `fontFamily` values fall
  back to Patrick Hand. Names match the SIL family name exactly so
  Pango's fontconfig resolves them.

## Approach

### Font assets

- `scripts/download-thumbnail-fonts.ts` — one-time bootstrap script
  that downloads TTF files from the Google Fonts GitHub repo
  (`github.com/google/fonts`) and writes them to
  `public/fonts/thumbnail-grid/`. Each font is mapped to its known
  path so the script doesn't have to guess.
- All 22 fonts are SIL Open Font License (OFL) or Apache 2.0
  (Roboto) — both permit redistribution.
- Files are committed so the deploy bundle contains them; no runtime
  CDN fetches, no build-time downloads.

### Font registry

- New `src/lib/thumbnail-formats/topic-card-grid-fonts.ts` — a single
  registry exporting:
  - `THUMBNAIL_FONTS: readonly { id; name; family; category; file }[]`
    — every supported font, with its SIL family name (used by
    Pango), its TTF filename (under `public/fonts/thumbnail-grid/`),
    and its category for the dropdown.
  - `DEFAULT_FONT_ID: 'patrick-hand'`.
  - `findFontById(id)` — server-side allowlist lookup; returns null
    for unknown ids.
  - `LABEL_FONT_DIR` — absolute path to the bundled font directory,
    derived from `process.cwd()` so server-side composite calls can
    resolve the file.

### Composite (`topic-card-grid-composite.ts`)

- `renderLabelPng`, `buildSquareLabelBandOverlay`, `buildSquareCellOverlay`,
  `buildCircleCellOverlay` accept an optional
  `font?: { family: string; filePath: string }` parameter. When
  omitted, fall back to the bundled Patrick Hand path (current
  behaviour).
- `applyCellUploads` accepts `fontId?: string` and resolves it to a
  `font` once per call via `findFontById`. Threaded to every overlay
  builder so every cell renders the label in the same font.
- The existing `LABEL_FONT_PATH` and `LABEL_FONT_FAMILY` constants
  become the Patrick Hand fallback. Existing tests that don't supply
  `fontId` continue to render Patrick Hand.

### Types + API

- `src/lib/thumbnail-formats/topic-card-grid.ts` — re-export
  `THUMBNAIL_FONTS` and `DEFAULT_FONT_ID` from the new fonts module so
  the public surface lives in one place.
- `src/app/api/thumbnails/format/topic-card-grid/image/route.ts`:
  accept `body.fontId: string`. Resolve via `findFontById`; unknown
  → fall back to `DEFAULT_FONT_ID` silently. Thread into
  `applyCellUploads` as `fontId`. Log the resolved id in
  `[thumb-format-grid image] start`.

### Panel

- Categorized dropdown (`<select>`) with `<optgroup>` per category,
  each option's `style.fontFamily` set to the font's family name (so
  the option text renders in the font itself in browsers that honour
  CSS on `<option>` — most do, with Safari being the main holdout).
- `@font-face` declarations for all 22 fonts injected via a single
  `<style>` block, pointing at `/fonts/thumbnail-grid/<file>.ttf`.
- The existing label-size preview band's `fontFamily` resolves to
  the selected font.
- Persisted to `localStorage` as `topic_card_grid_default_font_id`.
- Default = `patrick-hand`.

### Tests

- `tests/topic-card-grid-fonts.test.ts` — new file:
  - `THUMBNAIL_FONTS` contains exactly 22 entries.
  - `DEFAULT_FONT_ID` is `'patrick-hand'` and is in the registry.
  - Every entry has a unique `id`, an SIL `family` name, and an
    extant `file` (we sanity-check by string only — the file's
    presence on disk is checked by an integration test once
    `applyCellUploads` runs against the font).
  - `findFontById('unknown')` returns null.
  - `findFontById('patrick-hand')` returns the Patrick Hand entry.
- `tests/topic-card-grid-composite.test.ts` — extend:
  - `applyCellUploads` with a non-default `fontId` (e.g.
    `'bebas-neue'`) produces output where the rendered label has
    different glyph metrics than the default. We don't try to
    OCR-detect the font — just assert the rendered label PNG's
    pixel-row count differs from the default font's count by at
    least a small threshold.
  - `applyCellUploads` with an UNKNOWN fontId falls back to Patrick
    Hand silently (no throw, output renders).

## Security

- `body.fontId` is validated against the allowlist (`findFontById`).
  Unknown values silently fall back to default — no path traversal
  surface, no string interpolation of arbitrary input into the
  Pango fontfile parameter. Only paths registered in
  `THUMBNAIL_FONTS` flow through to sharp.
- Bundled font files live under `public/fonts/thumbnail-grid/`,
  served as plain static assets. Same CSP scope as the existing
  Patrick Hand file.

## Observability

- `[topic-card-grid composite font]` — once per `applyCellUploads`
  call. Logs `font_id_requested`, `font_id_used` (may differ when
  unknown id was requested), `family`, `file_path`.
- `[topic-card-grid panel font change]` — fires on dropdown change.
  Logs `from`, `to`.
- `[thumb-format-grid image] start` gains a `font_id` field.

## Settings audit

- Font picker lands beside the existing Style + Brightness + Detail +
  Label size knobs in the panel. Per-thumbnail-format only.
- Persisted to `localStorage` so a repeat user lands back on their
  pick.
- Default = `patrick-hand`, identical to current behaviour. Users who
  don't touch the picker see no change.

## Lazy-user check

- Categorized dropdown with each option rendered IN its own font lets
  the user scan visually and pick without trial-and-error.
- Reset-to-default is implicit (the existing slider's reset link will
  be paired with one for the font picker too — "Reset to defaults").
- Preview band shows the chosen font at the chosen size in real time —
  zero round-trip cost to evaluate combinations.

## Out of scope

- Per-card font override. Defer.
- Italic / bold weights — the bundled fonts are all single-weight
  Regular for simplicity. If a user needs a heavier weight, they
  pick a heavier display font from the list (Anton, Bebas Neue).
- Custom font upload. Defer; adds significant scope (validation,
  font-format conversion, security review of uploaded font files).
