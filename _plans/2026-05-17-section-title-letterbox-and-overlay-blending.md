# Section-title letterbox + overlay blending

**Date:** 2026-05-17
**Status:** Approved, in-progress
**Related code:** [YouTubeVideo.tsx](../src/remotion/compositions/YouTubeVideo.tsx), [SectionTitleStripe.tsx](../src/remotion/components/SectionTitleStripe.tsx), [RealImageOverlay.tsx](../src/remotion/components/RealImageOverlay.tsx), [utils.ts](../src/remotion/utils.ts), [overlay/fetch/route.ts](../src/app/api/overlay/fetch/route.ts), [image/route.ts](../src/app/api/generate/production-doc/image/route.ts), [SectionRowControls.tsx](../src/components/production-doc/SectionRowControls.tsx)

## Goal

Fix two visible problems on the production-doc video preview:

1. The **section title stripe** at the top of the frame covers the top ~13% of the row's image (the Morris Worm example: legend / NASA wordmark / top sketch content disappear behind the stripe).
2. The **real-image overlay** (e.g., NASA logo) is placed by an LLM with zero awareness of the image's actual content or the stripe, so it lands on focal content and reads as a sticker rather than something belonging in the scene.

## Requirements

- **Image must never be silently cut.** No content lost behind the stripe.
- Behavior must be **configurable per row**, not mandatory.
- Must work with **GPT Image 2** (favorite model). GPT-2 maxes at 3:2 aspect ratio — can't natively fill the wider area below the stripe. **Pillarbox accepted** as the tradeoff for full image visibility.
- **Pillarbox bar color**: white by default, per-row RGB override.
- Overlay must be **stripe-aware** (never overlap the stripe zone), **image-content-aware** (don't land on focal content), and **visually blended** (no harsh rectangular sticker look).
- Existing rows without a section title behave **identically** to today.

## Approach

### Part A — Pillarbox letterbox

When a row has a section title and layout is `letterbox` (new default), the renderer:

1. Reserves the top `stripeHeight` of the 1920×1080 frame for the title stripe (unchanged).
2. Renders the scene inside an offset container at `top: stripeHeight, height: 1080 - stripeHeight, width: 1920`.
3. Fills that container's background with the row's `pillarbox_color` (default white).
4. Renders the image with `object-fit: contain` inside the container, so the image is fully visible. Any unfilled area (side bars for 3:2 / 16:9 images, top-bottom bars for 21:9 images) shows the pillarbox color.

When layout is `overlay`, behavior is unchanged from today (stripe sits on top of full-frame scene).

### Part B — Overlay blending (Layers 1, 2, 3)

**Layer 1 — Saliency-aware placement:**

- After an image is generated and uploaded to R2, run a server-side saliency analysis using `sharp`. Output is a 4×3 grid where each cell carries a `busyness` score (0..1, derived from edge density + brightness variance) and a `dominantColor` (sampled average RGB).
- A new placement resolver takes the LLM's preferred `overlay_zone`, the saliency grid, and whether the row has a section title, and returns a **resolved zone + size**:
  - If section title is set, top zones (`top-left`, `top-right`, `center-top`) are forbidden.
  - The resolver scores each allowed cell by `1 - busyness` and picks the highest-scoring cell that maps to a zone near the LLM's preference.
  - If the chosen cell is too busy at the nominal size, the size shrinks one tier (`large → medium → small`).
- The resolved placement is stored on the row so the render and the UI agree on a single source of truth.

**Layer 2 — Visual blending:**

- Soft circular mask with a radial alpha fade on the overlay element. Edges feather over 8% of the overlay diameter — no more hard rectangle.
- Halo: a soft, color-matched glow behind the overlay, using the dominant color from the saliency cell the overlay lands in. The overlay reads as part of the local color environment instead of "punching" against it.
- Background-removal: the existing pipeline (Replicate `bria/remove-background`) already strips backgrounds at fetch time. No change here — confirm it's covering all overlay sources.

**Layer 3 — Image-informed placement:**

This is the integration of Layers 1 & 2: image generates → saliency analysis → placement resolver → render uses resolved zone and halo color. The LLM's `overlay_zone` becomes a **preference**, not a binding pick.

### Alternatives rejected

- **Letterbox alone, no pillarbox color**: would force every image to be regenerated at the right aspect ratio (only Nano Banana 2 supports it natively). Pillarbox lets the user keep GPT Image 2 as their default model.
- **Bake the safe-top band into AI-generated images**: only works for AI imagery, fails for uploaded / b-roll / clip sources, and depends on flaky model compliance.
- **Vision-model saliency**: more accurate than pixel analysis but adds a per-image API cost. Pixel analysis with `sharp` is free, runs in <50ms, and is good enough for "is this cell visually busy."
- **Animated arrows / annotations** (Layer 2 #5 from earlier discussion): bigger effort, revisit after Layers 1–3 ship.

## Schema changes

`src/remotion/types.ts` & `src/remotion/utils.ts` — `ProductionRow`:

```ts
/** When this row has a section_title, controls how the stripe relates to the image:
 *  - 'overlay': stripe sits on top of full-frame scene (legacy behavior).
 *  - 'letterbox': scene shrinks to fit below the stripe; pillarbox color fills any empty area.
 *  When unset and section_title is present, defaults to 'letterbox'. */
section_title_layout?: 'overlay' | 'letterbox';

/** Fill color for the area below the stripe that the image doesn't cover.
 *  RGB hex. Defaults to '#FFFFFF' when unset. Only meaningful when
 *  section_title_layout === 'letterbox'. */
pillarbox_color?: string;

/** Pixel-saliency map of the row's generated image, computed once at
 *  image-generation time. Drives overlay placement so the overlay lands
 *  in empty space rather than on top of focal content. */
image_saliency?: {
  /** Grid resolution (default 4×3). */
  cols: number;
  rows: number;
  /** Busyness score per cell, 0..1. Row-major flat array. */
  busyness: number[];
  /** Dominant RGB color per cell, hex. Row-major flat array. */
  dominantColors: string[];
};

/** Final resolved overlay placement after saliency analysis. Overrides
 *  overlay_zone / overlay_size from the LLM when set. */
overlay_zone_resolved?: ProductionRow['overlay_zone'];
overlay_size_resolved?: ProductionRow['overlay_size'];
```

`ProductionDoc`:

```ts
/** Doc-level default for pillarbox color when a row doesn't set its own.
 *  Defaults to '#FFFFFF'. */
pillarbox_color_default?: string;
```

`VideoShot` (renderer-facing): pass `sectionTitleLayout`, `pillarboxColor`, and `overlay.haloColor` through.

No database migration needed — the production doc is JSON-stored, so new optional fields are added in-place.

## Implementation steps

1. **Types & utils** ([types.ts](../src/remotion/types.ts), [utils.ts](../src/remotion/utils.ts)): add the schema fields above. `productionDocToVideoConfig` wires resolved overlay placement + pillarbox color through to `VideoShot`.
2. **Saliency lib** (`src/lib/image-saliency.ts`, new): pure `sharp`-based grid analyzer. Input: image buffer. Output: `{ cols, rows, busyness[], dominantColors[] }`.
3. **Image generation route** ([image/route.ts](../src/app/api/generate/production-doc/image/route.ts)): after R2 upload, run saliency on the buffer, persist the result on the row. Adds <100ms to the route.
4. **Overlay placement resolver** (`src/lib/overlay-placement.ts`, new): pure function. Input: `(overlay_zone, overlay_size, saliency, hasSectionTitle)`. Output: `{ zone, size, haloColor }`. Unit-testable.
5. **Renderer — letterbox** ([YouTubeVideo.tsx](../src/remotion/compositions/YouTubeVideo.tsx)): when a shot has `sectionTitle` and `sectionTitleLayout === 'letterbox'`, wrap `SceneRouter` in an absolutely-positioned container offset by stripe height with `background: pillarboxColor`. Existing scene components render as-is inside.
6. **Renderer — overlay blending** ([RealImageOverlay.tsx](../src/remotion/components/RealImageOverlay.tsx)):
   - Read resolved zone/size from the shot.
   - Soft circular mask via `mask-image: radial-gradient`.
   - Halo: an extra absolutely-positioned `div` behind the overlay with the sampled color, 1.4× the overlay's box, blurred 32px, opacity 0.5.
   - Forbid top zones when `sectionTitle` is set + `sectionTitleLayout === 'overlay'` (in letterbox mode the stripe doesn't intrude on the scene area so this guard isn't needed).
7. **UI — per-row controls** ([SectionRowControls.tsx](../src/components/production-doc/SectionRowControls.tsx)): when section title is set on the row, show a small segmented control (`Overlay / Letterbox`) and, when letterbox is active, a compact RGB color picker.
8. **UI — doc-level default**: small color picker in the same place where section-title defaults live (find the existing settings cluster in the production-doc page).
9. **QA**: golden path (row with title + letterbox + image), edge cases (no image yet, no overlay, overlay but no title, overlay + letterbox + title, 21:9 image with vertical bars, 3:2 image with horizontal bars), regression check (rows without titles look identical), interactivity (toggle layout, change color, watch render update).

## Security

- **Pillarbox color input**: validated as a hex string (`#RRGGBB` or `#RGB`); reject anything else server-side and client-side. Defends against accidental injection into inline `style` attributes — though React already escapes them, the validator is belt-and-suspenders.
- **Saliency module**: runs on already-validated R2 image buffers, never on user-supplied input directly. `sharp` handles malformed buffers safely (errors caught and logged, row falls back to the LLM's overlay zone).
- **No new secrets** introduced. Background removal already uses the existing `REPLICATE_API_TOKEN`.
- **No new external network calls** beyond what the image-gen route already does.

## Observability

Following rule 14 — every meaningful step gets a namespaced log with actual values:

- `[saliency compute] start { rowTimecode, imageUrl }` → `[saliency compute] done { rowTimecode, busyness, dominantColors, ms }`
- `[overlay placement] resolved { rowTimecode, llmZone, finalZone, llmSize, finalSize, reason }` — reason is one of `'no-saliency'`, `'llm-zone-empty'`, `'llm-zone-busy-fallback'`, `'stripe-forbidden'`, etc.
- `[render letterbox] render { rowTimecode, stripeHeight, pillarboxColor, imageAspect }`
- `[ui row-layout] toggled { rowTimecode, from, to }`
- `[ui pillarbox-color] changed { rowTimecode, from, to }`

Frontend logs at `console.info`; server logs via the existing `logger` shim. All payloads carry the row's timecode so a single grep correlates events for one row across the stack.

## Settings audit (rule 15)

- **Per-row**: layout (overlay / letterbox), pillarbox color (RGB picker).
- **Doc-level default**: pillarbox color default (RGB picker) in the production-doc settings area.
- **Intentionally not exposed yet** (revisit later if needed): saliency grid resolution (locked at 4×3), halo opacity / blur (locked at sensible defaults), overlay circular mask feather percentage (locked at 8%). Each of these could become a setting if a user wants more control, but the defaults should look great out of the box and adding three more knobs upfront violates "one obvious knob over three clever ones."

## Open questions

None blocking. Cost flag (rule 8): no incremental cost — saliency uses local `sharp`, the existing Replicate bg-removal pipeline is unchanged, no new model calls.
