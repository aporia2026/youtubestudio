# Fit B-roll clip duration to scene duration

**Date**: 2026-05-17
**Branch**: phase-1-foundation
**Status**: approved by user, ready to implement

## Problem

Today every B-roll clip is generated at the **model's fixed tier** (mostly 10s)
regardless of the scene's actual duration. Two failure modes:

1. **Scene shorter than clip** — `<OffthreadVideo>` plays the first N seconds
   and the rest of the paid clip is discarded. 4s scene with a 10s clip =
   $0.21 wasted per row.
2. **Scene longer than clip** — `<OffthreadVideo>` plays to the end of the
   clip and freezes the last frame. The image visibly stops moving while
   narration continues.

## Approach (user picked "Both" + "Round up to 10s")

Two complementary fixes:

### Fix 1 — Auto-pick the cheaper tier when the scene is short

At animate-time (single-row Generate AND Animate-all batch), compute the
row's scene duration. If it's `≤ 5.0s` **and** the user's chosen model
has a 5s variant (Kling 2.5 Turbo, Kling 2.6 — Sora 2 / Veo 3 don't), kick
off the 5s tier instead of the 10s default. Cost ≈ halves on short rows.

Above 5s, use the 10s tier (the "round up" choice — better a small frozen
tail than cut narration). Models with no shorter variant pass through.

### Fix 2 — Adjust playback rate at render time to fit the scene

In `BRollScene`, compute `playbackRate = clipDurationSeconds / sceneDurationSeconds`
and pass it to `<OffthreadVideo playbackRate={...} />`. Clamped to `[0.5, 2.0]`:

- Below 0.5 (scene > 2× clip) → clamp to 0.5, freeze the remainder.
  Falls back to today's behaviour for very long scenes.
- Above 2.0 (scene < clip/2 even at speedup) → clamp to 2.0, cut the tail.
  Falls back to today's behaviour for very short scenes.

Inside the clamp, the clip plays at a fitted speed and never freezes.

## Data flow

The clip's intrinsic duration must reach the renderer. Today
`rowVideoClips` only carries `{ status, videoUrl }`. Two options:

- **Plumb `duration_seconds` through the same map**: extend the entry
  shape to `{ status, videoUrl, durationSeconds? }`. The DB already stores
  this (`broll_clips.duration_seconds`, populated by `startBrollGeneration`).
  Updates to `handleBrollClipChange`, the Phase 2 DB-hydration, and the
  BrollCell `onClipChange` callback. **Chosen — single source of truth.**
- ~~Re-derive from model_id on the renderer~~. Brittle; model ids can change.

`VideoShot` gets a new optional `videoDurationSeconds: number | undefined`.
`productionDocToVideoConfig` maps from `rowVideoClips[i]?.durationSeconds`.

## Files touched

- `src/lib/broll-types.ts` — add `pickModelForScene(modelId, sceneMs): modelId`
  helper + a `shorterVariantId?` field on the model descriptor (optional;
  the helper can also use a small lookup map). Use the lookup map for now
  — descriptor changes ripple wider.
- `src/components/production-doc/BrollCell.tsx` — accept new `sceneDurationMs`
  prop. Inside `startGeneration` (and `kickoffBrollGeneration`), apply
  `pickModelForScene` to the requested model id. Extend `onClipChange`
  callback shape to include `duration_seconds`.
- `src/app/(app)/production-doc/page.tsx` —
  - New helper `computeRowSceneDurationMs(doc, rowIndex)` that reuses
    `calcShotIntervals` (alignment-independent — at animate-time we don't
    care about post-alignment precision, the render-time playback rate
    handles drift).
  - Pass `sceneDurationMs` to every `<BrollCell>` callsite.
  - Animate-all batch: compute scene duration per row, wrap modelId in
    `pickModelForScene` before kickoff.
  - Extend `rowVideoClips` state value type to include `durationSeconds`.
  - Extend `handleBrollClipChange` signature.
  - DB hydration (Phase 2): pull `duration_seconds` from the returned
    clips and include it in the bridged state.
- `src/remotion/types.ts` — `VideoShot.videoDurationSeconds?: number`.
- `src/remotion/utils.ts` — `productionDocToVideoConfig` maps the new
  field. Update the `RowVideoClipState` interface accordingly.
- `src/remotion/scenes/BRollScene.tsx` — compute `playbackRate` and pass
  to `<OffthreadVideo>`. Clamp `[0.5, 2.0]`. Log one-shot on frame 0 for
  diagnosis.

## Observability (rule 14)

- `[broll tier pick]` once per kick-off: `{ rowIndex, sceneSeconds, userModelId, pickedModelId, downgraded }`.
- `[broll playback fit]` once per scene mount in BRollScene: `{ shotIndex, clipSeconds, sceneSeconds, playbackRate, clamped }`.

## Settings (rule 15)

Tier auto-pick: silent for now. Worth a future "Always use 10s clips"
escape hatch if a user has narration that desyncs from speedup, but
default is the auto behaviour.

Playback fit: same — silent default-on. If a creator complains about
"the walk looked too fast", add a toggle later.

## Cost (rule 8)

Saves ~$0.21 per short row when the picked model has a 5s variant. No
new charges. Per-render playback rate is free (Remotion CPU only).

## Security / safety (rule 13)

No new persisted fields beyond `duration_seconds` which already exists
on `broll_clips`. No new attack surface.

## QA (rule 6)

Golden path:
1. Row with a 4s scene → pick Kling 2.5 Turbo (10s) default → click
   Animate. Expect `[broll tier pick]` log with `downgraded: true`,
   `pickedModelId: 'kling-v2-5-turbo-i2v-pro-5s'`. Cost in toast = $0.21.
2. Row with a 7s scene → same default → no downgrade. Click Animate →
   `pickedModelId: 'kling-v2-5-turbo-i2v-pro-10s'`. Cost = $0.42.
3. Render → 7s scene with 10s clip → `[broll playback fit]` shows
   `playbackRate: 0.7`, clip fits exactly. No freeze.

Edge cases:
- Sora 2 i2v / Veo / Sora 2 t2v → no 5s variant. Auto-pick is a no-op.
  Playback rate still applies and fits clip to scene.
- Scene = 0.5s (very short row) → playbackRate would be 20 → clamp to 2,
  clip plays for ~clipSec/2, scene cuts the rest. Same as today.
- Scene = 30s with a 10s clip → playbackRate would be 0.33 → clamp to
  0.5, clip plays 20s, last 10s frozen. Same as today.
- DB-hydrated clips from Phase 2 → make sure `duration_seconds` from the
  GET response lands in `rowVideoClips`.

Regression check:
- Existing clips with `duration_seconds = null` (legacy rows) → fall
  back to 10 in the render-time math, like today.
