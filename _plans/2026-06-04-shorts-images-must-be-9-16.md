# Shorts image assets must be 9:16 (or the closest the model supports)

Date captured: 2026-06-04
Status: deferred — captured for a future PR. Not implemented in this work.

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
