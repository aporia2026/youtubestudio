# Plan: Style-aware on-screen text rendering (Phase 2 of Doodle Explainer 2)

**Date:** 2026-05-25
**Status:** Approved, executing now
**Phase:** 2 of 3
- Phase 1: `_plans/2026-05-25-doodle-explainer-2-built-in.md` (shipped, tuning iterations in progress)
- Phase 3: `_plans/2026-05-25-near-static-variants.md` (not yet written)

## Goal

When a production doc is rendered with `style_id === 'doodle_explainer_2'`, the per-row `on_screen_text` field should render as **chunky yellow bubble-font text with a thin black outline**, matching the look from the reference videos (`In May 2017`, `150 countries`, `Wannacrypt`). Every other style continues to render with the existing dark lower-third bar — no regression.

Phase 1 mixing rules already tell the script generator to populate `on_screen_text` for time markers, statistics, and key terms when this style is selected. Phase 2 makes those rows actually render with the right visual treatment.

## Constraints

- **Don't break existing overlays for other styles.** The default lower-third bar (white text on dark box, accent bar slide-in) stays the active treatment for every style that isn't `doodle_explainer_2`.
- **Reuse animation envelope.** Enter/exit timing for the yellow-bubble variant matches the default (spring-snappy entrance, slide-out exit). Only glyph styling diverges.
- **Two render paths share one treatment.** `on_screen_text` flows through two distinct components:
  - `<LowerThird>` rendered from per-shot `shot.onScreenText` (BRollScene, ScreenMockupScene, etc.) — the **primary** path
  - `<TextOverlayLayer>` rendered from doc-level `config.textOverlays[]` — the **secondary** path
  - Both must honor the style. Inconsistent treatment between them would mean some captions render in yellow bubble, others in the default bar, on the same video.
- **Font loaded at boot, not per-render.** Remotion gates first frame on font load via `delayRender`. The bubble font must be registered in `src/remotion/fonts.ts` so Lambda + local Studio + Vercel all use it.
- **Server-safe imports.** `src/remotion/fonts-registry.ts` is the server-importable mirror; the new font goes in both.

## Requirements

- Doc's `style_id` is threaded into the Remotion render via `VideoConfig`.
- `<LowerThird>` accepts a `variant?: 'default' | 'doodle-yellow'` prop. Default keeps current behavior. `'doodle-yellow'` renders the chunky yellow bubble look.
- `<TextOverlayLayer>` reads `styleId` from `useVideoConfig()` and branches its glyph rendering on the same `variant`.
- Scenes that call `<LowerThird>` (BRollScene, ScreenMockupScene) derive `variant` from `useVideoConfig().styleId`.
- A new Google Font is loaded for the bubble look. **Pick: `Lilita One`** — chunky rounded bold, single weight (400), available in `@remotion/google-fonts`. Matches the reference video typography closely.
- Yellow fill: `#FCD34D` (Tailwind `yellow-300`, close to the reference frames' shade). Black outline: 2px via `-webkit-text-stroke` + `text-shadow` fallback.
- No dark box behind the yellow text (the refs have it floating directly over white). Drop the accent bar + dark text-box wrapper for the doodle-yellow variant.

## Chosen approach

Three-file edit:

1. **`src/remotion/fonts-registry.ts` + `src/remotion/fonts.ts`** — register `Lilita One`. Export a `LILITA_ONE_FAMILY` constant. Load via `loadGated('Lilita One', loadLilitaOne(...))`.

2. **`src/remotion/types.ts`** — add `styleId?: string` to `VideoConfig`.

3. **`src/remotion/utils.ts`** (`productionDocToVideoConfig`) — thread the doc's `style_id` into the constructed `VideoConfig`.

4. **`src/remotion/components/LowerThird.tsx`** — accept `variant?: 'default' | 'doodle-yellow'`. For `'doodle-yellow'`:
   - Same `useCurrentFrame` / spring entrance / exit timing
   - Drop the accent bar + dark text-box; render just a centered `<div>` near the bottom-center with the yellow bubble text
   - `fontFamily: LILITA_ONE_FAMILY`, `fontWeight: 400` (single weight)
   - `color: '#FCD34D'`
   - `-webkit-text-stroke: 2px #000`
   - `text-shadow: 0 2px 0 rgba(0,0,0,0.4)` (subtle drop)
   - Larger font size (~52px single-line, ~44px multi-line) to match the refs' visual weight

5. **`src/remotion/components/TextOverlayLayer.tsx`** — same `variant` branching inside `SingleOverlay()`. Read `styleId` from `useVideoConfig()`, map `'doodle_explainer_2'` → `'doodle-yellow'`.

6. **`src/remotion/scenes/BRollScene.tsx` + `ScreenMockupScene.tsx`** — read `styleId` from `useVideoConfig()`, map to variant, pass as prop on `<LowerThird>`.

## Alternatives rejected

1. **Hardcode the style check inside LowerThird.** Rejected: couples a generic UI primitive to a specific style id. A future built-in (`doodle_explainer_3`, `whiteboard_explainer`) wanting a different treatment would mean stacking more `if (styleId === ...)` inside LowerThird. The `variant` prop keeps the primitive style-agnostic and pushes the mapping out to one call site.

2. **Bake the yellow text into the AI image via the Atlas Edit model.** Rejected: image models misspell text routinely. Even with the exact prompt `"render the text 'Within hours' in chunky yellow bubble font"`, the model produces `Withln houfs` half the time. Overlay rendering at composition time is pixel-perfect, instant, and editable post-hoc.

3. **Use `Bagel Fat One` instead of `Lilita One`.** Considered. Bagel Fat One is even chunkier but the corners are TOO rounded and the letterforms look balloon-y. Lilita One is closer to the marker-bold look in the actual reference frames. Easy to swap later if needed.

4. **Per-row override of the variant.** Rejected for v1: adds an `on_screen_text_variant?: string` field to `ProductionRow` so individual rows can opt into different treatments inside the same doc. Reasonable feature but YAGNI right now — the row-level `on_screen_text_mode` already controls bake vs overlay vs none; visual treatment per-style is enough granularity.

## Phase 2 QA checklist

- [ ] `tsc --noEmit` clean on touched files
- [ ] `Lilita One` font loads in Studio preview without console warnings
- [ ] Doc with `style_id !== 'doodle_explainer_2'` renders `on_screen_text` exactly as before (regression check)
- [ ] Doc with `style_id === 'doodle_explainer_2'`:
  - [ ] `on_screen_text` renders in chunky yellow bubble font with thin black outline
  - [ ] No dark text box behind it
  - [ ] Position is bottom-center-ish, visible against white background
  - [ ] Enter/exit animation matches the default timing
  - [ ] Both `<LowerThird>` (per-shot) and `<TextOverlayLayer>` (doc-level) honor the variant
- [ ] Test a multi-line `on_screen_text` to confirm wrapping behavior
- [ ] Visual eyeball against `refs/screenshots/v2-extra/v2_t028.jpg` (`Within hours`) — close enough to call it done

## Open questions

None blocking. Font choice (`Lilita One`) is easy to swap if visual review wants tighter match.
