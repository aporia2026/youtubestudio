# 2026-06-08 — Motion-collage panel 0 native 16:9 source

## Symptom

Motion-collage rows generate visibly wrong content at the edges —
labels clipped at the top, characters/feet clipped at the bottom.
The user reported it twice today on a 3×3 doodle motion grid where
the circled scene numbers (①②③) at the top of each panel were cut in
half by the canvas edge.

## Root cause

`src/lib/auto-pipeline/production-doc-image-gen.ts:1834,1842` (panel
0 of a motion-collage row) requested Atlas at `1536×1024` (3:2
aspect). The next step at line 1852 (`cropTo16x9AndUpload`)
center-cropped that source to ~1456×819 (16:9) — **destroying ~7.8%
off the top AND ~7.8% off the bottom** of every panel 0.

Atlas supports four sizes per [atlas-cloud-images.ts:70](src/lib/atlas-cloud-images.ts#L70):
`1024×1024`, `1024×1536`, `1536×1024`, **`2560×1440`**. The last one
is native 16:9 and exactly matches the renderer's 1920×1080 canvas
aspect. Single-shot generation has used `2560×1440` for months; only
the motion-collage panel-0 path was stuck on `1536×1024`.

The augmentation pipeline does inject a `safeEdgeDirective` ("central
70%, 15% padding top/bottom") into every cell prompt at
[prompt-augmentation.ts:165](src/lib/prompt-augmentation.ts#L165),
but the model doesn't always honour it — especially when it places
ordinal labels like "①" at obviously-edge positions. The post-crop
made even good-faith compositions lose content.

## Fix

Change the panel-0 Atlas size from `1536×1024` to `2560×1440` in
both branches (refs-aware i2i + plain t2i) at
[production-doc-image-gen.ts:1830-1846](src/lib/auto-pipeline/production-doc-image-gen.ts#L1830-L1846)
and drop the `cropTo16x9AndUpload` call that follows.

The cropped URL variable is preserved (renamed in spirit but still
called `croppedUrl` so callers / log scrapers don't notice) and now
equals `atlasUrl` directly — a no-op pass-through. The downstream
`upscaleViaRecraft` already has a "skip if long edge > 2000px"
guard at [upscale.ts:39,92](src/lib/upscale.ts#L39), so the
2560×1440 source passes through unchanged (no extra cost), and the
final panel image is 2560×1440 — comfortably above the 1920×1080
renderer target.

### Why not touch the 2×2 bundled collage too

`generateCollageGroup` at line 1108 also uses `1536×1024`, but THAT
function generates ONE image with 4 cells in a 2×2 grid and then
SLICES it via `sliceCollage`. The slicer math is calibrated against
the 1536×1024 source dimensions. Switching it to 2560×1440 would
need the slicer + the per-quadrant Recraft 4× upscale logic to
follow, plus the per-shot resolution-target arithmetic in the route
comment at `/collage/route.ts:240-247`. Separate, larger change.
The user's specific complaint is on the motion-collage path; that's
what this PR fixes.

### Continuation panels (1..N)

Panels 1 through N-1 inherit their dimensions from panel 0 via
`generateGptImage2Edit` (Atlas Edit preserves input dimensions).
Once panel 0 is 16:9-native, the whole chain becomes 16:9-native
automatically. No additional changes needed.

### Existing cached panels

`panel0FromCache` reads `panel0SourceUrl` (a cached anchor from a
prior run that was 1536×1024 → ~1456×819). Atlas Edit on that input
produces a 1456×819 output (still 16:9, just narrower than 2560×1440).
The renderer's `objectFit: 'cover'` handles both correctly. Mixed
caches across rows of the same doc are visually consistent because
both shapes are 16:9.

## Cost impact

Atlas GPT Image 2 at `quality: 'low'` is priced per call, not per
pixel. The recorded `panelCostUsd = 0.0135` was already approximate;
the actual Atlas bill is whatever Atlas invoices. If 2560×1440 low
quality is materially more expensive, we can revisit (telemetry
already records the per-panel cost via `markDelivered`).

## Out of scope

- Re-rendering existing motion-collage rows. Users need to click
  "Regenerate motion collage" on affected rows for the fix to take
  effect on their current docs.
- The gradient fade visible at the bottom of the user's screenshot
  panels 7-9. That looks like a renderer-side stripe/fade overlay
  rather than image-source crop; will diagnose separately if it
  persists after this fix.
- The 2×2 bundled collage size. Separate refactor — see above.
