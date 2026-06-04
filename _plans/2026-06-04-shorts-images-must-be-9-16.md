# Shorts image assets must be 9:16 (or the closest the model supports)

Date captured: 2026-06-04
Date shipped:  2026-06-04
Status: SHIPPED. See "Outcome" at the bottom for what landed vs the original plan.

## Problem

The Shorts renderer composes a 1080×1920 frame and overlays caption text in
the middle 60% safe zone. The asset pipeline currently asks each T2I model
for whatever its default aspect ratio is — Atlas GPT Image 2 ships
1024×1536 (2:3), Kie's family takes an explicit `aspect_ratio` param. The
prompt builder bakes in the instruction "Vertical 9:16 composition.
Subject placed in the middle 60% of the frame" but that's a guideline the
model can ignore, not a dimension constraint.

Result: when the renderer drops a 2:3 frame into the 9:16 viewport with
`object-fit: cover`, ~12% gets cropped off — usually the top and bottom of
the composition, where the model places contextual elements. On a real
Short / Reel / TikTok player, the result reads as awkwardly cropped, off-
center, or with subjects whose feet/heads get clipped.

## Goal

Every generated asset (base + variants + collage panels) should be
**9:16 if the model supports it, or the closest available ratio the model
exposes if not**. The renderer keeps `object-fit: cover` but only as a
last-resort guard — the input should already be the right shape.

## Inventory — current per-model aspect support (verify before implementing)

Spec lives in [src/lib/shorts-base-t2i.ts](src/lib/shorts-base-t2i.ts) and
[src/lib/gpt-image-2-edit.ts](src/lib/gpt-image-2-edit.ts). Walk every
configured model and check what ratios its provider exposes:

- **Atlas GPT Image 2** (T2I + Edit) — verify available sizes via Atlas
  API docs. Current default 1024×1536 is 2:3. Does Atlas support 9:16
  (e.g. 1024×1820 / 720×1280)?
- **Kie family** (Imagen, Nano Banana, Qwen, Seedream, etc.) — Kie takes
  an `aspect_ratio` string. `'9:16'` is supported by most modern image
  models on the API. Confirm per-model.
- **Replicate fallback models** if any.

The closest-supported ratio fallback chain should be: `9:16` exact →
`2:3` (current default — only 12% closer to 9:16 than square) → `3:4` →
`1:1`. Reject anything wider than `3:4`; better to skip the model than
ship a square-ish frame.

## Implementation sketch (not a commitment)

1. Add an `aspectRatio: '9:16'` argument to `generateShortsBaseT2I` and
   `generateGptImage2Edit`.
2. Each per-model adapter maps that to its native parameter: Kie sets
   `aspect_ratio: '9:16'`, Atlas picks the closest supported size
   (e.g. 720×1280 if available), etc.
3. The prompt builder keeps the "Vertical 9:16, middle-60% safe zone"
   guidance — it's still useful for composition decisions even when the
   canvas is already the right shape.
4. Per-model "closest supported ratio" lookup is a pure table in code so
   it's unit-testable and one place to update when a provider adds new
   sizes.
5. The renderer in `ShortVideo.tsx` keeps `object-fit: cover` as a safety
   net but should now be a no-op on the common path.
6. Diagnostic log per generation: `[shorts base-t2i] requested 9:16,
   model returned ${actualWidth}x${actualHeight}` so the operator can
   see when a model isn't honoring the request.

## Testing

- Unit-test the "closest-supported-ratio" mapping for each model.
- After implementation, regenerate the asset block on one Short per
  configured model and visually confirm the composed Short isn't
  cropping subjects.

## Why deferred

Bigger investigation than this PR's scope. Touches every image-gen path
+ vendor docs research + per-model parameter mapping. Best done as its
own focused PR with a fresh look at each provider's current size menu
(per CLAUDE.md rule 1 — verify before coding, vendor APIs drift).

## Related

- Plan: `_plans/2026-05-28-paint-explainer-v1-architecture.md` (talks
  about middle-60% safe zone as a prompt instruction, not a dimension
  constraint).
- Memory: "Collage upscale order" — collage composition is upscaled
  AFTER cropping; the underlying panel ratios are the source of any
  cropping problems.

## Outcome (2026-06-04)

The investigation found the variant pipeline was the worse offender:
it was inheriting the long-form Edit dispatcher's `1536×1024` (3:2)
→ crop to 16:9 (`1536×864`) flow, and dropping those landscape frames
into the 9:16 viewport — `object-fit: cover` then chopped ~63% of the
composition. The base-T2I 2:3 was the smaller crop (~11%).

What shipped:

1. **`cropTo16x9AndUpload` → `cropToAspectAndUpload(srcUrl, prefix,
   aspectW, aspectH)`** in `src/lib/image-gen-dispatch.ts`. Old name
   kept as a thin back-compat wrapper so the long-form pipeline is
   unchanged.
2. **`generateGptImage2Edit` gained `aspectRatio?: '16:9' | '9:16'`**
   in `src/lib/gpt-image-2-edit.ts`. Default `'16:9'` keeps the
   long-form pipeline byte-identical. Atlas branch for `'9:16'` asks
   for `1024×1536` (portrait, ~16% crop loss) instead of `1536×1024`
   (landscape, ~63% crop loss). Kie branch sets
   `aspect_ratio: '9:16'` natively.
3. **`generateShortsBaseT2I` Atlas branch now crops to 9:16** by
   default (Atlas can't deliver native 9:16; closest is 2:3 →
   center-crop to 864×1536). All four Kie base-T2I models already
   request native 9:16 — unchanged.
4. **Every Shorts caller of `generateGptImage2Edit` passes
   `aspectRatio: '9:16'`:**
   `shorts-doodle-asset-pipeline.ts`, `shorts-paint-asset-pipeline.ts`,
   `shorts-frame-ops.ts` (regenerate + append variant).
5. **Collage panels resized**: 512×768 (2:3 each) → 432×768 (9:16
   each). Composed image went from 1024×1536 (2:3) → 864×1536 (9:16).
   Composed aspect is now exactly 9:16, so the renderer's
   `object-fit: cover` is a no-op.

Tests:

- New `tests/image-gen-dispatch-9x16-crop.test.ts` — 9 cases covering
  the new aspect-target geometry (2:3 input, square input, 3:2 input,
  already-9:16 input, input validation).
- `tests/gpt-image-2-edit-dispatch.test.ts` extended with an
  `aspectRatio` describe block (4 cases): default 16:9 path,
  Atlas-`'9:16'` switches to portrait + crops to 9:16, Kie-`'9:16'`
  passes the right `aspect_ratio` param, Kie default still 16:9.
- `tests/shorts-base-t2i.test.ts` Atlas-branch test asserts the new
  crop step is fired with (9, 16).
- `tests/shorts-frame-collage.test.ts` composed-dimension assertion
  updated to 864×1536 + an aspect sanity check.
- `tests/shorts-frame-ops.test.ts` + `tests/shorts-doodle-pipeline-progress.test.ts`
  fixtures updated to mock the new crop step.
- All 77 image-gen / Shorts-affected tests pass. 3896 / 3903 total —
  the 7 unrelated failures are pre-existing (atlas-images.test.ts,
  scoped-tables-coverage.test.ts, voiceover-alignment-integration.test.ts).

Cost impact: zero. Same vendor calls, same per-call price; only the
post-vendor crop changed aspect.

Outstanding (not in this PR):

- Renderer in `src/remotion/compositions/ShortVideo.tsx` keeps
  `object-fit: cover` as a defensive guard. Now that source images
  are 9:16 it's effectively a no-op; can stay for safety against any
  future vendor drift that produces a different shape.
- No diagnostic log per generation tying actual vendor-returned
  width/height back to the request. If a future Atlas update changes
  what `1024x1536` actually means, we'd want to spot it; deferred.
