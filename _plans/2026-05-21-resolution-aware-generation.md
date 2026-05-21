# 2026-05-21 — Resolution-aware image generation for YouTube long-form

**Status:** Approved, in flight. Phase 0 of the local-broll roadmap (precedes Phases 5/7/8.1/6v2/HiDream/8/LTX-2.3 per user decision 2026-05-21).

## Goal

Every still generated for a long-form YouTube production-doc lands at the exact pixel canvas the Remotion composition is going to display. No upscale, no downscale, no wasted content above an opaque title-row stripe.

Three target canvases:

| Scene type | Canvas |
|---|---|
| No section-title stripe | **1920 × 1080** (full frame) |
| `sectionTitleLayout === 'overlay'` (stripe drawn on top of image) | **1920 × 1080** — still full frame, the stripe just covers part of it at render time |
| `sectionTitleLayout === 'letterbox'` (stripe sits beside image, image area shrinks) | **1920 × (1080 − stripePx)** where `stripePx = clampSectionStripeFraction(fraction) × 1080`. Default 13% → **1920 × 940**. Min 6% → **1920 × 1016**. Max 22% → **1920 × 848**. |

After computing the raw target, snap each dimension to the model's required grid (Flux/HiDream/Qwen: multiple of 16; cloud Kie: at the mercy of the provider). Snapped defaults:

| Letterbox state | Flux/Qwen/HiDream snapped | Wan i2v snapped (× 32) |
|---|---|---|
| No stripe | 1920 × 1080 | 1920 × 1088 (over) — but Wan stays at 704 × 416 on 16 GB |
| Default 13% | 1920 × 944 | 1920 × 928 — but Wan stays at 704 × 416 |
| Min 6% | 1920 × 1024 | n/a |
| Max 22% | 1920 × 848 | n/a |

## What changes

### 1. Pure helper — `src/lib/render-canvas.ts` (NEW)

```ts
export interface CanvasInput {
  sectionTitle?: string | null;
  sectionTitleLayout?: 'overlay' | 'letterbox';
  stripeFraction?: number; // optional override; defaults to SectionTitleStripe's 0.13
  /** Grid the generator must snap to. Flux/Qwen/HiDream=16; Wan=32; default=8. */
  grid: 8 | 16 | 32;
}
export function computeImageCanvas(input: CanvasInput): { width: number; height: number };
```

Reuses `clampSectionStripeFraction()` from [src/remotion/components/SectionTitleStripe.tsx](src/remotion/components/SectionTitleStripe.tsx) — single source of truth for clamping. Snapping rounds **down** to the nearest multiple of `grid` so the canvas never exceeds the visible area.

### 2. Production-doc image route — `src/app/api/generate/production-doc/image/route.ts`

- Accept `sectionTitleLayout?: 'overlay' | 'letterbox'` in the POST body. `sectionTitle` already lands.
- Compute canvas with `computeImageCanvas` using `grid: 16` for the local ComfyUI path.
- Replace the hardcoded `width: 1280, height: 720` (lines 117-118) with the computed values.
- Cloud Kie path stays on its current model-specific aspect/resolution flags — Kie doesn't accept arbitrary pixel dimensions, only enum aspect ratios; we can't enforce the exact letterbox canvas there.
- Tighten the safe-top prompt directive: only inject it when `sectionTitleLayout === 'overlay'`. Letterbox now has pixel-accurate canvas, so the prompt-bias hack is no longer needed for that case and only crowds the prompt.

### 3. Production-doc page — `src/app/(app)/production-doc/page.tsx`

Two call sites send to the image route:
- `runGenerateAllStillsLocal` (line 2692) — batch local stills.
- The single-row `generateImage` flow (line 4140).

Both already pass `sectionTitle`. Add `sectionTitleLayout: row.section_title_layout ?? doc.section_title_layout_default ?? 'letterbox'` to the body.

### 4. Local Studio standalone picker — `src/app/local-studio/page.tsx`

Replace the four generic presets (line 137-141) with YouTube-focused ones:

```ts
const PRESET_SIZES = [
  { label: 'YouTube 1920×1080 (no title row)', width: 1920, height: 1080 },
  { label: 'YouTube with title row 1920×944 (default 13%)', width: 1920, height: 944 },
  { label: 'YouTube with max title row 1920×848 (22%)', width: 1920, height: 848 },
  { label: 'YouTube with min title row 1920×1024 (6%)', width: 1920, height: 1024 },
  { label: 'Thumbnail 1920×1080', width: 1920, height: 1080 },
  { label: 'Shorts 1080×1920', width: 1080, height: 1920 },
  { label: 'Square 1080×1080', width: 1080, height: 1080 },
];
```

Default to "YouTube 1920×1080 (no title row)" (sizeIdx=0). The old 1280×720 preset is removed — it was always wrong for 1080p output.

### 5. Wan i2v local clip resolution — `src/lib/local-broll.ts`

**Stays at 704 × 416** in this phase. Hardware-bound: Wan 2.2 I2V on 16 GB VRAM cannot animate at 1920×1080 — VRAM blows on the latent shape. Remotion's render upscales the clip to fit the letterbox area, which loses some sharpness but keeps the local path working.

Documented as a known compromise in this plan and in [_plans/2026-05-20-comfyui-local-broll.md](_plans/2026-05-20-comfyui-local-broll.md). Resolution upgrade for Wan is a separate problem (waiting on lower-VRAM quants or 24 GB hardware).

## What we explicitly do NOT do here

- **Migrate off Remotion.** The native FFmpeg renderer is at Phase 1/8 — no video clips, no audio, no title rows, no captions, no transitions. Migration now would be a multi-week regression to fix a resolution problem solvable in two hours. The native plan ([_plans/2026-05-20-ffmpeg-native-renderer.md](_plans/2026-05-20-ffmpeg-native-renderer.md)) keeps its own track; once its Phase 7 lands route integration, both renderers consume the same correctly-sized stills.
- **Per-row stripe fraction setting.** There's currently a fixed 0.13 default everywhere; no per-row override exists. Adding one is a separate UI/persistence task and doesn't gate this phase.
- **Kie cloud exact-pixel canvases.** Kie's API takes enum aspect ratios, not pixel dimensions. Cloud images stay at the provider's 16:9 default and get fitted by Remotion at render. The letterbox area will see the same aspect, just slightly scaled. Acceptable.

## Security + safety

No new attack surface. The route still validates inputs:
- `sectionTitleLayout` is parsed against the `'overlay' | 'letterbox'` literal union; any other value falls back to `'letterbox'`.
- Computed width/height are clamped to `[256, 2048]` inside the local generator (existing behaviour at [src/lib/visual-generator/comfyui-local.ts:113](src/lib/visual-generator/comfyui-local.ts#L113)) — pathological canvas requests can't blow VRAM.
- No new file I/O, no new external calls, no new env vars.

## Observability

Every step logs:
- `[render-canvas] computed` with `{ sectionTitle, layout, stripeFraction, raw, snapped }`.
- `[local-studio submit]` already logs `width`/`height` — picks up the new values automatically.
- `[prodoc image-gen]` server-side log already in place.

## Settings audit (rule 15)

What we expose:
- Local Studio picker: 7 named presets (above). One obvious knob: pick the canvas that matches the scene's title-row state.

What we intentionally do NOT expose yet:
- Custom width/height (advanced) — out of scope.
- Per-row stripe fraction override — needs UI design first.

## Test plan

- `computeImageCanvas` unit tests: no-stripe → 1920×1080; letterbox default → 1920×944 (snapped from 940 to 944 for grid 16); letterbox max → 1920×848; letterbox min → 1920×1024 (snapped); overlay → 1920×1080.
- Manual smoke: open production-doc, mark a row with `section_title`, generate the still locally → verify the saved image is 1920×944 (or the configured snapped value).
- Manual smoke: Local Studio picker → each preset → generate → verify dimensions in the result panel match.
- Render check: existing letterbox renders should look pixel-clean (no scaling artifacts) on the new stills.

## Out-of-scope follow-ups

- Per-row stripe-fraction setting + UI.
- Wan i2v 1080p (waiting on hardware / better quants).
- Kie cloud exact-pixel canvas (waiting on Kie API).
- Native FFmpeg renderer parity (own plan).
