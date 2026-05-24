# Thumbnail-zoom: spotlight-clip for aspect-mismatched regions

**Date:** 2026-05-25
**Status:** Approved — proceeding

## Goal

Make the thumbnail-region zoom *visually* zoom into the marked region even when
the region's aspect ratio matches the whole image (e.g. full-height columns of a
7-level countdown thumbnail). After the white-space fix landed earlier today
the camera math no longer breaks, but for full-height/full-width regions the
camera still has nothing to do — `regionContainScale == wholeImageContainScale`
— so the animation visibly plays as a static "whole thumbnail" view.

Solution: when the camera physically can't zoom further into the region,
**clip the canvas to the region's projected bounds**, letting the brand
background colour show through as letterbox. The region appears spotlit and
centred; everything around it fades to backgroundColor.

## Constraints

- Must NOT change behaviour for interior regions where the camera CAN zoom
  (Morris-Worm regression case from commit 5a332f7: neighbours stay visible).
- Must keep the white-space invariant from this morning's fix: the rendered
  image always fills the canvas (or background shows ONLY through the clip).
- Must work for all three transition kinds: `hard-cut`, `smooth`, `none`.
- No new settings — auto-activates by detecting the `regionScale ≤
  wholeImageContainScale` condition. (User can revisit later if they want a
  manual override per principle 15.)

## Approach

1. **Detect clip mode** per region: `clipMode = regionScale <= containScaleWholeImage`.
   Exact mathematical condition: "the camera framing can't zoom further than
   the whole-image contain framing."
2. **Target framing in clip mode** uses focus at the *padded region centre*
   without the image-bounds clamp. This shifts the image so the region lands at
   canvas centre; image edges may extend off-canvas (hidden by `overflow:
   hidden` and/or the clip).
3. **Clip rect** lerps from "full canvas" at contain framing to "region's
   projected bbox at the unclamped target framing" at the target. Same `P`
   that drives the camera lerp, so they stay in sync.
4. **Render structure**: outer absolute-positioned div applies the CSS
   `clip-path: inset(...)`. Inner div carries the existing transform. The
   AbsoluteFill background colour shows through the clipped-out region.

## Alternatives rejected

- **COVER for these regions** — would crop top/bottom of each level (losing
  the "LEVEL X" label and bottom content). Explicitly rejected by user.
- **Always clip to region's projected bbox** — would break Morris-Worm
  behaviour (neighbours should stay visible when camera can zoom). Confined
  to the `regionScale ≤ wholeImageContainScale` branch.
- **Manual setting toggle** — adds a knob without a clear need. Auto-detection
  via the mathematical condition handles all known cases. Defer until asked.

## Security / safety

No external input handling, no new attack surface. Pure rendering math
change. Defensive `MIN_DIM` guards already in place.

## Observability

Extend the existing frame-0 `console.info('[thumbnail-zoom] mounted', …)`
log to include:

- `clipMode: boolean`
- `targetClipRect: { left, top, right, bottom }` (when clipMode)
- `targetFramingUnclamped: Framing` (when clipMode)

So when a render looks wrong I can paste the log lines and pinpoint which
branch fired.

## Tests

Extend `tests/thumbnail-zoom-framing.test.ts`:

- 7-level region detects `clipMode === true` and computes the expected
  projected bbox (region centred, 274.5×1080 in a 1920×1080 canvas).
- Morris-Worm region detects `clipMode === false` and uses the existing
  clamped framing (no behavioural change).
- Full-width banner region also goes to clip mode and projects correctly.

## Settings audit

No new user-facing controls. Auto-detected. Revisit if creators ask for an
explicit "show neighbours / spotlight" toggle in the Section Row Controls.
