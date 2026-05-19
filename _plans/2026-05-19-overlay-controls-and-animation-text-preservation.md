# Production-doc overlay controls + animation text preservation

**Date:** 2026-05-19
**Pages touched:** `/production-doc`, plus `src/lib/broll.ts` (shared by every i2v/t2v call)

## Two related problems

### Problem A — overlay images are second-class

1. The user didn't realize overlays could already be removed (right-click → "✕ Remove overlay" exists, in [src/app/(app)/production-doc/page.tsx:7786](src/app/%28app%29/production-doc/page.tsx#L7786)). Discoverability gap.
2. No way to tell the doc "don't generate overlays for me" — generation auto-fires whenever a row has `overlay_stock_terms`. The user's workflow doesn't want overlays as a separate composited layer at all.
3. The user's preferred workflow: when a scene references a brand (Microsoft, Apple, iPhone, etc.), the logo should be **baked into the AI image prompt itself** so the still has the logo natively, rather than scraping a stock PNG and pasting it on top.

### Problem B — i2v animation warps existing text/numbers

The i2v tail at [src/lib/broll.ts:101](src/lib/broll.ts#L101) says "No added text, no logos, no watermarks" — that stops the model from **hallucinating** new text. It does nothing to stop the model from **distorting** text/numbers that already exist in the source still.

Kling's negative prompt (`NO_TEXT_NEGATIVE_PROMPT` at lines 148–149) has the same blind spot: prevents hallucination, not warping.

When the user animates a still that contains a counter, a brand logo, a chart label, or any rendered typography, the i2v model warps it during motion — letters scramble, digits twist, logos break.

## Goals

1. Make removing an overlay obvious without right-clicking.
2. Give the user a global "no overlays" switch + a per-row override.
3. Teach the doc-gen LLM to embed brand mentions into the image prompt automatically, so the brand renders natively in the still.
4. Stop the i2v model from warping existing text/numbers/logos in source stills, robustly, by default, across every model.

## Decisions (already aligned with user)

| Decision | Choice |
|---|---|
| Remove overlay discoverability | Hover-✕ button on the cell, in addition to existing right-click |
| Skip overlay generation scope | Both: doc-level default + per-row override |
| Brand logo mechanism | Doc-gen LLM bakes brand mentions into `ai_image_prompt` automatically |
| Animation prompt scope | Default-on for ALL i2v calls (and applied to t2v too where it helps) |

## Implementation

### Part 1 — Animation prompt: robust text preservation (smallest, ships first)

**Where:** [src/lib/broll.ts:97–101](src/lib/broll.ts#L97-L101) — the `MOTION_TAIL_I2V` and `CINEMATIC_TAIL_T2V` constants.

**New i2v tail (replace):**

> Animate the described action with smooth, natural motion. Preserve the existing style and composition. CRITICAL: every piece of text, every digit, every letter, every logo, every wordmark, and every number that appears in the source image MUST stay pixel-stable across the full clip. Do NOT redraw, re-render, re-letter, morph, warp, animate, or stylise any glyph. Counters and timers stay frozen unless the source image makes them move. If you cannot animate the rest of the scene without disturbing a glyph, animate AROUND the glyph instead. No scene changes, no added text, no added logos, no watermarks.

**New t2v tail (replace):**

> Subtle natural camera movement (slow push-in or parallax). Photoreal. No on-screen text, no logos, no captions, no watermarks. If any glyphs DO appear in the rendered frame (signage, license plates, screens), they must stay pixel-stable across the clip — never morph, warp, or re-render letters mid-motion.

**Why this language works:** image-to-video models follow imperative, specific, repeated language. "Pixel-stable" is concrete. Listing the glyph types (text, digit, letter, logo, wordmark, number) covers every shape the model might silently mis-categorize. "Animate AROUND the glyph" gives the model an escape hatch other than warping.

**Model-specific reinforcement:** Kling has a `negative_prompt` already (`NO_TEXT_NEGATIVE_PROMPT` at [src/lib/broll.ts:148](src/lib/broll.ts#L148)). For i2v calls we keep the negative prompt — it still helps suppress new text — but the positive prompt does the heavy lifting for preservation.

**Tests:** add cases to `tests/broll.test.ts` asserting both new tails appear verbatim in the right modes, and that the truncation path still preserves the tail.

### Part 2 — Hover-✕ on overlay cell

**Where:** [src/components/production-doc/OverlayCell.tsx:81–280](src/components/production-doc/OverlayCell.tsx#L81-L280).

When the cell has an overlay (has `url`), render a small `✕` button in the top-right that appears on hover. Click → confirm → calls the same removal handler the right-click menu uses.

Pattern: `opacity-0 group-hover:opacity-100 transition-opacity`. Wrap the cell in `group` to scope the hover. Reuse the existing removal handler from [page.tsx:7786–7816](src/app/%28app%29/production-doc/page.tsx#L7786-L7816) — pass it as a prop.

### Part 3 — Doc-level "auto-generate overlays" toggle

**Schema:** add `overlays_disabled?: boolean` (default `false`) to the production-doc top-level shape. Single boolean. Persisted with the doc.

**UI:** in the production-doc header, near the existing controls, a checkbox: **"Auto-generate overlays"** (checked = on, unchecked = "I'll handle logos via the image prompt"). Tooltip explains the trade-off.

**Behavior gate:** the `fetchOverlayForRow` call at [page.tsx:4282](src/app/%28app%29/production-doc/page.tsx#L4282) wraps in:
```ts
if (doc.overlays_disabled || row.skip_overlay) return;
```

### Part 4 — Per-row "skip overlay" override

**Schema:** add `skip_overlay?: boolean` (default `false`) to the row shape.

**UI:** add to the right-click context menu (it's already where overlay actions live). Item: **"Skip overlay for this row"** (or "Allow overlay for this row" when already skipped). Clear visual when set: the overlay cell renders a small "skipped" pill instead of the empty/fetching state.

This is the manual escape hatch: when the doc-level toggle is OFF (auto-gen is on by default), you can still flag specific rows to skip. When the doc-level toggle is ON (skip-by-default), you don't need per-row overrides for the majority.

### Part 5 — Doc-gen LLM bakes brand mentions into `ai_image_prompt`

**Where:** [src/lib/prompts.ts](src/lib/prompts.ts) — `productionDocPrompt` around line 2049 (the "MANDATORY IMAGE STYLE" block) is the obvious anchor. Add a new section right after it.

**New prompt section (rough):**

> ## BRAND / LOGO HANDLING — BAKE INTO ai_image_prompt
>
> When the scene script mentions a real brand, product, app, or piece of named software (e.g. "Microsoft", "Windows 11", "iPhone", "Photoshop", "Cursor", "Tesla", "Google Search"), the brand's visual identity MUST be embedded directly into the `ai_image_prompt` for that row — never relegated to overlay_stock_terms.
>
> Concretely: add phrasing like "with the [brand] logo prominently visible on [surface]" or "showing the [brand] wordmark in [position]" or "the [product]'s recognisable [feature]". Pick whichever fits the scene composition you're describing. The goal is for the still image to render the brand natively, so when the row is animated the brand is part of the picture rather than a glued-on overlay.
>
> When `overlays_disabled: true` is set on this doc (passed in via input), be extra strict — set `overlay_stock_terms` to "" for every row, and rely entirely on baking brand/logo content into `ai_image_prompt`.
>
> Examples:
> - Script says "let's open Cursor" → `ai_image_prompt` includes "a laptop screen showing the Cursor IDE with its dark theme and recognisable logo in the top-left corner"
> - Script says "use Google Search" → `ai_image_prompt` includes "a browser tab open to google.com with the multicolour Google wordmark centered above the search box"
> - Script says "Windows is collapsing" → `ai_image_prompt` includes "the Windows logo cracked and crumbling, the four-colour panes shattering apart"

**Wiring:** the route at [src/app/api/generate/production-doc/route.ts](src/app/api/generate/production-doc/route.ts) passes the doc options into `productionDocPrompt`. Add `overlaysDisabled?: boolean` to the args so the prompt can branch on the user's preference.

### Settings audit (rule 15)

- `overlays_disabled` is a per-doc setting. Not global — different docs have different needs. Lives on the production-doc, not in user settings.
- `skip_overlay` is a per-row override. Lives on the row, no settings UI.
- The animation prompt change is hard-coded global behaviour. A future "soft mode" setting could let users dial it back for stills where there's no text, but that's premature; the new tail is robust enough to ship default-on.

### Security & safety (rule 13)

- Schema additions are booleans — no new attack surface.
- The brand bake-in prompt language is purely instructional to the LLM. No execution path; the LLM still produces text we render through the same sanitisers.
- No new endpoints.

### Observability (rule 14)

- `[overlay-skip] cell removed via hover` — log when the user clicks the new ✕.
- `[overlay-skip] doc-level toggle` — log when the doc-level checkbox flips, with new value.
- `[overlay-skip] row-level toggle` — log when the per-row skip flips.
- `[broll prompt] glyph-preservation tail` — log a one-time confirmation per call that the new tail was applied (helpful when triaging "the model warped my numbers again" reports).

## Implementation order

1. broll.ts tails + tests (small, isolated, high value, ships first)
2. OverlayCell hover-✕ (small, isolated, immediate UX win)
3. Doc-level + per-row skip flags (schema + UI + gate)
4. Doc-gen prompt: brand bake-in language
5. Typecheck, commit, push

## QA plan

- **Animation:** generate a still with a "07" counter or a brand logo, animate via Kling i2v, confirm the digit / logo does not warp across the clip. Repeat on Runway i2v and Sora 2 i2v.
- **Overlay remove (hover):** hover an overlay cell → see ✕ → click → confirm → overlay clears.
- **Doc-level skip:** toggle "Auto-generate overlays" off → add a new row with `overlay_stock_terms` → no fetch happens.
- **Per-row override:** doc-level skip ON → right-click a row → "Allow overlay" → overlay fetches for that one.
- **Brand bake-in:** generate a production-doc for a script mentioning Microsoft and Tesla → confirm the `ai_image_prompt` for those rows includes the brand's visual identity verbatim, not relegated to `overlay_stock_terms`.
- **Old docs:** open a pre-existing doc → `overlays_disabled` defaults to undefined → behavior unchanged (overlays auto-generate as before). No surprise regression.

## Out of scope

- Replacing the overlay fetch pipeline (Brave Search → RMBG → placement) — still used when overlays are explicitly wanted.
- A "soft mode" for the animation preservation prompt.
- Auto-detecting which rows have brand mentions in the script and showing a hint in the editor.
- Migration of existing docs to the new defaults — they keep their current behaviour until the user flips the toggle.
