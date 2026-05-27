# Thumbnail-zoom feel: snappier curve + shorter defaults

**Date:** 2026-05-27
**Owner:** Yoav

## Problem

In production-doc, when a row uses `thumbnail-zoom` with a chosen region, the
in-video zoom feels slow, bulky, and "stuck" at the end of the motion. Not
smooth.

## Root cause

Two stacking issues in `src/remotion/scenes/ThumbnailZoomScene.tsx`:

1. **Spring is the Ken-Burns preset.** `SPRING_SMOOTH` (damping 20 / stiffness
   120 / mass 1) has a damping ratio of ~0.91 — almost critically damped. The
   self-described use case in `spring-presets.ts` is "background slides, Ken
   Burns." For a section-divider zoom we need a curve that lands confidently,
   not one that creeps to the target.
2. **Durations are too long.** Defaults are `holdAtFullMs: 500`,
   `zoomDurationMs: 1000`, `holdAtTargetMs: 600` → ~2.1 s of motion + dead
   air per section transition.

The "feels stuck" complaint comes from #1; the "bulky / slow" from #2.

## Decision

Option 1 (snappier curve + shorter defaults). Both new and existing saved
rows benefit. Existing rows can't have their bracket-style numbers retro-
fixed without re-saving, but they all benefit from the spring-shape change.

## Constraints

- `SPRING_SMOOTH` is **also used** by `ScreenMockupScene.tsx` for its
  slide-in. Do not retune the preset itself — instead introduce a new
  `SPRING_ZOOM` preset and remap `'spring-smooth'` → `SPRING_ZOOM` inside
  `ThumbnailZoomScene` only.
- The `'spring-snappy' / 'spring-smooth' / 'spring-gentle'` tier labels in
  the UI are a contract with the user. We're not adding a new label — we're
  making the existing "smooth (balanced)" label actually feel balanced.
- Dialog's `speedFromConfig` reverse-engineers a multiplier from saved
  durations against `BASE`. After lowering `BASE`, existing saved rows will
  display as `0.65×` in the slider (old 1000ms ÷ new 650ms). Acceptable:
  speed is relative to defaults, and the defaults changed. Saving without
  moving the slider preserves old values bit-identically.

## Changes

1. `src/remotion/animations/spring-presets.ts`
   - Add `SPRING_ZOOM`: damping 17, stiffness 200, mass 0.9,
     `overshootClamping: true`. Damping ratio ~0.63 — underdamped, clamps
     at 1, lands fast and stays. No tail crawl.

2. `src/remotion/scenes/ThumbnailZoomScene.tsx`
   - Import `SPRING_ZOOM`.
   - In `easingToSpringConfig`, map `'spring-smooth'` (and default) →
     `SPRING_ZOOM`. Keep `SPRING_SNAPPY` and `SPRING_GENTLE` mappings.
   - `DEFAULTS`: `holdAtFullMs: 250`, `zoomDurationMs: 650`,
     `holdAtTargetMs: 350`.

3. `src/components/production-doc/TransitionDialog.tsx`
   - `BASE`: `holdAtFullMs: 250`, `zoomDurationMs: 650`,
     `holdAtTargetMs: 350`. Keeps the dialog's "1.0×" in sync with the
     renderer's new defaults.

## Observability

Existing `console.info('[thumbnail-zoom] mounted', …)` log already prints
`easing`, `holdAtFullMs`, `zoomDurationMs`, and the two framings. That's
enough to debug a slow zoom after the change. Nothing new to add.

## Rejected alternatives

- **Retune `SPRING_SMOOTH` in place.** Rejected — would change
  `ScreenMockupScene`'s slide-in feel as a side effect.
- **Change default easing token from `'spring-smooth'` →
  `'spring-snappy'`.** Rejected — `SPRING_SNAPPY` is not overshoot-clamped,
  so the camera would visibly overshoot the region and pop back. Wrong
  feel for a "balanced" default.
- **Migrate existing saved configs.** Rejected — too invasive for a feel
  tweak. The spring-shape change is enough to make existing rows feel
  better without any data migration.

## Deploy

`src/remotion/**` changes don't reach the Lambda renderer via Vercel push.
After verifying locally, run `npm run deploy:remotion` to ship the new
spring + defaults to the actual renderer.
