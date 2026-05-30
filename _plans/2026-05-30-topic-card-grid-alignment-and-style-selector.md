# Topic Card Grid — alignment fixes + Style selector

**Date:** 2026-05-30
**Status:** approved (Plan A)
**Related:** `_plans/2026-05-19-thumbnail-format-topic-card-grid.md`, `_plans/2026-05-30-topic-card-grid-quality-fixes.md`

## Goal

Two user-visible problems on the `topic-card-grid` thumbnail format:

1. **Alignment.** Bottom row cells render without a top black border (the cards look "open" at the top). At the illustration→label seam there's a doubled hairline — the AI drew its own divider line, the composite painted another a couple pixels below, so two parallel lines are visible with a sliver of white between.
2. **Style.** Every render comes out cartoon, regardless of subject. The current prompt's Detail=Clean wording ("chunky iconic visuals") plus the bundled cartoon reference image override any per-card subject that could have rendered photoreal (real software screens, product photos, brand wordmarks). There is no UI control for picking style.

## Constraints

- Composite changes must not break the existing pixel-scan logic from r2.1–r2.3 — those handle real AI cell-width drift and have to stay working.
- Default flows (`gridRows = 2`, `gridCols = 3`, no reference upload, all knobs default) must keep producing usable thumbnails without the user touching the new Style control.
- No new bundled assets — bundled default reference image stays as-is; the Style selector overrides its visual influence via prompt wording.
- Unit-testable. The composite module already has `tests/topic-card-grid-composite.test.ts` with synthetic-pixel-buffer patterns; both alignment fixes must land tests there.

## Alternatives considered

### A — Surgical composite fixes + Style selector (CHOSEN)

- Replace `detectAiLabelTop`'s "first mostly-white row" heuristic with a **divider-line scanner** that finds the AI's drawn horizontal black line and returns its y. Our overlay's white area starts at-or-above the line so the AI's hairline is overpainted; our hairline lands at the line's y.
- After detecting each cell's rect, **paint a thin black top border at `aiRect.y`** spanning `aiRect.w`, with thickness `squareBorderPx(aiRect.w)`. Cells that already have an AI-drawn top border get re-painted at the same y (no visible change); cells where the AI omitted the border get the border painted in. Closes row 2's "open top" unconditionally.
- Add **Style selector** to `TopicCardGridPanel` with presets: Cartoon (default), Photoreal, Flat 2D, Sketch, Cinematic, Free-form. Wire into `topicCardGridImagePrompt` as an explicit STYLE block at the head of the prompt that overrides Detail=Clean's "chunky iconic" wording.

### B — Composite all four borders of every cell

Instead of just the missing top, the composite re-paints all 4 sides of every cell after detecting the rect. AI borders become irrelevant. Bigger change, higher risk of overpainting the illustration if detection drifts by a few pixels. Rejected: solves a problem we don't have (left/right/bottom borders look fine in the failing render).

### C — Style picker only, defer alignment

Cheaper but the alignment artifacts stay visible. Rejected: both are user-reported bugs in the same session, deferring one is worse UX than landing both.

## Style presets — exact wording

Each preset emits a different `STYLE` block prepended to the image prompt. The block overrides Detail=Clean's "chunky iconic" wording so the model doesn't default cartoon.

- **cartoon** (default): "STYLE — CARTOON / STICKER: bold flat illustration with thick outlines, saturated palette, sticker-like shapes. Hand-drawn humanist feel. Avoid photoreal textures, photographic depth-of-field, or 3D rendering."
- **photoreal**: "STYLE — PHOTOREAL: render each card as a real-world photograph or authentic visual identity — real software screens, real product photos, real news photos, real brand wordmarks. No illustrated stand-ins. Where a subject has a canonical visual (a famous screen, a logo, a product), use that exact visual. Lighting and depth-of-field as a real camera would capture them."
- **flat-2d**: "STYLE — FLAT 2D ILLUSTRATION: clean vector-style shapes, restrained palette (≤ 5 colors per card), no gradients, no shading, no outlines unless geometric. Modern editorial flat illustration."
- **sketch**: "STYLE — SKETCH / HAND-DRAWN: black ink line art on textured paper, sparse fills, hatching for shading. Hand-drawn feel like a designer's sketchbook. Avoid solid color blocks; let the line work carry the image."
- **cinematic**: "STYLE — CINEMATIC: moody, atmospheric, dramatic key lighting, shallow depth-of-field, film-still feel. Darker palettes are OK. Treat each card like a still from a thriller about the subject."
- **free-form**: the user's typed string is sanitized and inserted as `STYLE — CUSTOM: <user text>`. Cap 300 chars at the boundary via `sanitizeForPrompt`.

When a non-cartoon style is selected, the existing "CATEGORY vs SPECIFIC RULE" wording is *softened* — categories may still use one bold central subject, but rendered in the chosen style (a photoreal hook-piercing-envelope, not a flat cartoon one).

## Files touched

- `src/lib/thumbnail-formats/topic-card-grid-composite.ts` — replace `detectAiLabelTop`; add top-border overlay per cell in pure-prompt path.
- `src/lib/thumbnail-formats/topic-card-grid.ts` — new `ThumbnailStyle` type + `DEFAULT_STYLE` + style threading into `ImagePromptInput` + `topicCardGridImagePrompt` style block emission.
- `src/components/thumbnails/TopicCardGridPanel.tsx` — `style` state, persisted to `localStorage`; UI control; free-form text input shown when `style === 'free-form'`; threaded into the API call body.
- `src/app/api/thumbnails/format/topic-card-grid/image/route.ts` — accept `style` + `styleFreeForm` in `ReqBody`; validate; thread into `topicCardGridImagePrompt`.
- `tests/topic-card-grid-composite.test.ts` — synthetic pixel tests for the divider-line scanner and the top-border paint.
- `tests/topic-card-grid.test.ts` — assertions that each preset emits its expected STYLE block; that free-form text is sanitized; that omitted/invalid style falls back to cartoon.

## Security

- `styleFreeForm` is user-supplied text that ends up inside the image prompt. Sanitize at the boundary via `sanitizeForPrompt(input, 300)` (already strips control chars + clips length). The 300-char cap keeps the budget bounded and prevents prompt-injection payloads from rewriting the rest of the prompt.
- Server validates `style` against the enum allowlist; unknown values fall back to default. No string interpolation of arbitrary user input into prompt scaffolding.
- No new network surfaces; no new auth surfaces.

## Observability

Each step emits a namespaced log:

- `[topic-card-grid composite top-border]` — once per card; logs the cell index, detected `aiRect.y`, painted border `y` + `w`.
- `[topic-card-grid composite divider-scan]` — once per card; logs `detected_divider_y`, `band_top_used`, `source: 'divider' | 'white-row-fallback' | 'percentage-fallback'`. Catches regressions where the scanner stops finding the line.
- `[topic-card-grid panel style change]` — fires on Style selector change; logs `from`, `to`, `free_form_chars` when the new value is free-form.
- `[thumb-format-grid image]` start log gains a `style` field so server-side logs link the rendered output back to the style preset.

## Testing

Unit tests in vitest. Run via `npm test -- topic-card-grid-composite` and `npm test -- topic-card-grid` after changes.

1. **divider-line scanner**: synthetic pixel buffer with a known horizontal dark line at y=Y inside the cell; assert the scanner returns Y. Edge case: dark line at the very top of the band-search window. Edge case: no dark line (scanner returns `null`, caller falls back).
2. **top-border paint**: build a base image with a missing-top-border cell at a known rect; run `applyCellUploads` in pure-prompt mode; decode result; assert a horizontal dark line is present at `aiRect.y` spanning the cell's width.
3. **doubled-hairline regression**: synthetic base with TWO horizontal dark lines (AI's divider + AI's hairline) inside the cell; assert the composite returns a buffer with the band starting at the higher of the two lines, eliminating the gap between them.
4. **style block emission**: for each preset, `topicCardGridImagePrompt` output contains the matching `STYLE — …` block; for free-form, contains the sanitized user text; for invalid input, contains the Cartoon block.
5. **regression**: existing tests for `computeRegions` / `cellRect` / `circleCellGeometry` keep passing unchanged.

## Settings audit

- Style selector lands in the TopicCardGridPanel alongside the existing Brightness and Detail toggles — same group, same persistence pattern (`localStorage` per-key), same restoration-from-history payload field. Default preserves current behavior (Cartoon).
- No new global settings — Style is per-thumbnail-format, lives with the Topic Card Grid format settings only.

## Lazy-user check

- Default style stays Cartoon so a user who clicks Generate without touching anything gets the same output they got before.
- Photoreal is positioned as the second option so a user who has been frustrated by "always cartoon" finds the obvious one-click escape.
- Free-form is last so it doesn't dominate the chip row, and the text input appears only when selected (no clutter for the 95% who pick a preset).

## Out of scope

- Brightness ↔ Style consistency check (e.g., Cinematic + Brightness=Bright is a contradiction). Defer; the model usually picks the more specific one. If complaints surface, add a guard.
- Per-card style override. Defer.
- Circle-mode composite tweaks. Defer — alignment artifacts here are square-mode only.
