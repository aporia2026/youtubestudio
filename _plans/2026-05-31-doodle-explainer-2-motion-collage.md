# Doodle Explainer 2 — Motion Collage shots

**Date:** 2026-05-31
**Owner:** info@flexelent.com
**Status:** Drafted, awaiting approval
**Style:** `doodle_explainer_2`
**Tracked under:** part of the user's ongoing motion search for `doodle_explainer_2` — sibling effort to `paint_explainer_v1` (motion via procedural overlays) and the existing `near-static variants` system.

---

## TL;DR

A new shot kind for `doodle_explainer_2` that produces real motion (a running character, a falling object, a typing hand, a logo popping) by asking the image model to draw a single N×M grid storyboard in ONE generation, slicing it into N×M keyframes, and playing them hard-cut over the row's narration window. The brain fills in the motion between keyframes; the visual cohesion is guaranteed because all keyframes come from the SAME generation, so the character / scene / camera stays identical across them.

The work is largely a **composition of existing parts** — the codebase already has a 2×2 collage generator + sharp slicer (used today as a cost optimization for unrelated shots). We generalize the slicer to N×M, hang a new shot kind off it, and wire one new Remotion scene that flips through the panels.

---

## Goal

Give the LLM that writes `doodle_explainer_2` docs a tool for inserting **real motion** when the narration calls for it — without paying for per-frame independent generations that drift visually, and without bolting on the full `paint_explainer_v1` procedural-motion stack.

The trigger is the LLM's call: when a beat describes a character or object IN MOTION (running, falling, transforming, exploding, sliding into frame, gesturing, a logo appearing piece-by-piece), the LLM emits `shot_kind: 'motion_collage'` with an N×M grid of panel prompts. The pipeline generates one image, slices, uploads N×M panels. The renderer plays them as hard-cut keyframes across the row's duration.

## Constraints / decisions (locked with user)

1. **Variable grid size** — not fixed 2×2. The LLM decides per shot. `motion_collage_grid: { cols, rows }` where `cols × rows ≤ MAX_GRID_PANELS` (default 12; clamped to a hard upper bound of 16 to bound spend + render cost).
2. **Model-agnostic** — the user picks the image model when generating. The pipeline plugs into the existing model dispatcher (Atlas T2I, Kie t2i, etc.). The grid + separator instructions are added to the prompt regardless of which model is selected.
3. **LLM decides when** — no doc-level "all shots use motion collage" toggle. The LLM (which is already steering shot composition for `doodle_explainer_2` via mixing_rules) decides per shot whether motion is the right answer. Subject can be character, object, text popping, realistic prop, logo — any visual.
4. **Natural narration flow** — per-frame duration is derived from `shot.durationMs / N` so motion length always matches the narration window. v1 uses equal subdivisions; word-onset snapping is v2.
5. **Cropping** — leverage the existing `src/lib/collage-slicer.ts` infrastructure (sharp + fixed-percent gutter trim + R2 upload), generalize it from hardcoded 2×2 to variable N×M. The existing `OUTER_TRIM_PCT` / `INNER_TRIM_PCT` (1% each) carry over and are tunable post-QA.
6. **Hard cuts between frames** — no fade. Cross-fades between sub-shot frames defeat the keyframe-animation feel (it would read as a slideshow). The frames cycle as hard cuts; the row's outer transition (`scene_fade`) still applies between rows as usual.
7. **No mouth-swap on motion_collage shots** — the character is not lip-syncing across keyframes (their whole body / pose is changing). Narration plays normally over the visual; the dialogue is "spoken through the action," matching real 2D animation conventions.

## Why this shape

### Why a new `shot_kind`, not a new `MotionBeat`

`paint_explainer_v1`'s motion-beats are PROCEDURAL OVERLAYS on top of a single static base — the base doesn't change between beats; only the overlays (mouth, label, prop, wiggle) do. They depend on accurate vision-pass anchors, mouth-removed companions, and frame-accurate alignment data.

`motion_collage` is the OPPOSITE — it's hard-cut keyframes where the WHOLE picture changes between frames. There is no single static base, no overlays, no anchors. Fitting this into the motion-beat system would require gutting the assumption that motion is composited on top of a base.

A new `shot_kind` is the clean cut. The SceneRouter in `src/remotion/compositions/YouTubeVideo.tsx` already branches on `shot.shotKind === 'motion'` vs. default; adding a `=== 'motion_collage'` branch is a 5-line extension.

### Why reuse `collage-slicer.ts` rather than build fresh

The codebase already does almost exactly this: there's a doc-level `collage_mode` toggle that generates 4 shots in one 2×2 image, then crops with `sliceCollage()` and uploads to R2. The mechanism is the same — the SEMANTIC USE is different (cost optimization for unrelated shots there; keyframe sequence for one shot here). Reusing the slicer means we inherit:

- Battle-tested sharp-based crop logic
- R2 upload pattern
- Fixed-percent gutter trim that works in production
- Malformed-detection heuristics (histogram + Sobel) that catch bad generations before they hit the renderer

Generalizing the slicer from 2×2 to N×M is straightforward — the existing logic computes 4 fixed rectangles; the new version computes `cols × rows` rectangles in a loop. Same trim math, same upload pattern.

### Why NOT magenta separators (revisited)

In the conversational scoping I recommended magenta separators + algorithmic line detection. After reading the existing `collage-slicer.ts` I'm walking that recommendation back. The existing approach (thin neutral gutter requested in the prompt + fixed-percent crop) is in production today, works well, and survives malformed generations via the histogram check. Adding a separate magenta pipeline would create two parallel slicers — more surface area, more places to bug. The existing approach handles 2×2 today; the only delta for N×M is the rectangle math.

If post-QA the variable-grid version produces visible gutter remnants, we revisit. Until then, follow precedent.

### Why per-frame derived from `shot.durationMs / N` (and not word-onset)

v1 keeps the timing math simple: `frameDurationFrames = Math.floor(shotDurationFrames / N)`. Last frame absorbs any remainder so the total exactly equals the shot window. This:

- Matches narration cleanly without alignment dependency
- Works on every doc (alignment JSON is sometimes absent or stale)
- Avoids the failure mode where alignment is bad and frames clip mid-word

v2 (deferred) snaps frame transitions to nearest word onset, like `paint_explainer_v1` mouth swap. We'll only do this if v1's equal-subdivision feels off in QA renders. Don't speculate; ship v1, measure, iterate.

---

## Alternatives considered + rejected

### Alt A — Build a separate magenta-separator slicer

What it would have been: prompt the model to add `#FF00FF` separators, write a new algorithmic detector (scan rows/cols for magenta pixel density), split there.

**Rejected because:** the existing slicer already handles the variable-grid case with one rectangle-math change + a malformed quality gate. Two slicers means twice the surface area to maintain, twice the failure modes to debug. Reuse > rebuild.

### Alt B — Independent per-frame generations with consistency anchoring

What it would have been: generate N separate images, anchor each to the previous via Atlas Edit ("same character, same camera, but now running") — like the chained-variant system but explicitly for motion.

**Rejected because:** (a) ~4× cost vs. one collage call. (b) Drift compounds — even with the chained variant system's identity anchor, V3 drifts ~14% from V0. For motion that needs 6-9 frames, the last frame would barely resemble the first. The single-image collage approach guarantees pixel-level consistency because every panel is drawn in the same generation.

### Alt C — Extend `motion_beats[]` with a `keyframe_sequence` kind

What it would have been: add `{ kind: 'keyframe_sequence', panels: [...] }` to the existing motion-beat enum, treating it as a procedural overlay over a static base.

**Rejected because:** there IS no static base for motion collage shots. Trying to force the motion-beat shape would require either inventing a phantom base or making the base optional in `MotionScene`, both of which pollute the cleaner separation of concerns. A new `shot_kind` is the smaller change and the cleaner mental model.

### Alt D — Defer entirely and just use the existing chained-variant system harder

What it would have been: tell the LLM to lean more on `variant_derives_from_previous: true` and call it good.

**Rejected because:** chained variants are explicitly capped at 4 rows (1 base + 3 variants) and the identity anchor still drifts. They reproduce the LOOK of "near-static animation" — slight pose / expression changes — but they cannot deliver REAL motion arcs (a character physically running across a frame, an object falling, a logo assembling). The user's specific gap is the LACK of real motion in this style; doing more of what doesn't deliver real motion isn't a solution.

---

## Schema additions

### `ProductionRow` (in `src/remotion/utils.ts`)

```ts
// ─── doodle_explainer_2 (2026-05-31): motion collage ──────────────
// New shot_kind value PLUS three new optional fields. All four are
// meaningful ONLY when shot_kind === 'motion_collage'. The renderer
// ignores them when shot_kind is anything else; the pipeline ignores
// rows whose shot_kind is not 'motion_collage'.

shot_kind?: 'static' | 'motion' | 'hard_cut' | 'motion_collage';

/** Grid layout for motion_collage shots. cols × rows = total keyframes
 *  generated in a single collage image, then sliced and played as a
 *  hard-cut sequence over the row's duration. Required when
 *  shot_kind === 'motion_collage'. Bound: cols × rows ≤ MAX_GRID_PANELS
 *  (default 12; hard ceiling 16 enforced server-side). */
motion_collage_grid?: { cols: number; rows: number };

/** Per-panel prompts describing the action progression. Index 0 is
 *  top-left, index 1 is top-right, … left-to-right then top-to-bottom.
 *  Length MUST equal cols × rows; server-side validation enforces this.
 *  Each entry describes ONE keyframe of motion — base composition stays
 *  identical across panels; only the moving element advances. */
motion_collage_panel_prompts?: string[];

/** Pipeline-populated: R2 URL of the raw N×M collage image (post-
 *  upscale). Kept for debugging and re-slice on settings change. Not
 *  read by the renderer. */
motion_collage_image_url?: string;

/** Pipeline-populated: R2 URLs of the sliced per-panel images, in the
 *  same index order as `motion_collage_panel_prompts`. Length equals
 *  cols × rows on success. The renderer reads from here. */
motion_collage_panel_urls?: string[];
```

### `ProductionDoc` (in `src/remotion/utils.ts` AND the page-level inline mirror at `src/app/(app)/production-doc/page.tsx:404`)

```ts
/** doodle_explainer_2 (2026-05-31): per-doc settings for motion-collage
 *  shots. All fields optional; resolver fills defaults. Mirrors the
 *  `paint_explainer_v1_settings` pattern. */
doodle_explainer_2_motion_collage_settings?: DoodleExplainer2MotionCollageSettings;
```

### `DoodleExplainer2MotionCollageSettings` (new type in `src/remotion/types.ts`)

```ts
export interface DoodleExplainer2MotionCollageSettings {
  /** Enable / disable motion-collage shots for this doc. When false,
   *  the LLM is told to skip the new shot kind and the pipeline
   *  refuses to generate any. Lets a user kill the feature globally
   *  without re-prompting if the model misbehaves. Default true. */
  allow_motion_collage?: boolean;
  /** Maximum panels per collage (cols × rows). Caps spend per shot
   *  and renderer load. Bounded [4, 16]. Default 12. */
  max_grid_panels?: number;
  /** Minimum per-frame duration in ms. Frames briefer than this read
   *  as flicker. The pipeline caps `cols × rows` such that
   *  shot.durationMs / N >= min_per_frame_ms; if the LLM asks for too
   *  many panels for the shot duration, N is reduced to the largest
   *  grid that fits. Default 200 (5 fps minimum perceived rate). */
  min_per_frame_ms?: number;
  /** Maximum per-frame duration in ms. Frames longer than this stop
   *  feeling like motion and start feeling like a slideshow. The LLM
   *  is told to use motion_collage only when the shot duration / N
   *  lands below this. Default 800. */
  max_per_frame_ms?: number;
}
```

Defaults / bounds live in `src/remotion/utils.ts` next to `PAINT_EXPLAINER_V1_DEFAULTS`:

```ts
export const DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS: Required<DoodleExplainer2MotionCollageSettings> = {
  allow_motion_collage: true,
  max_grid_panels: 12,
  min_per_frame_ms: 200,
  max_per_frame_ms: 800,
};

export const DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS = {
  max_grid_panels: [4, 16] as const,
  min_per_frame_ms: [100, 500] as const,
  max_per_frame_ms: [300, 1500] as const,
};
```

Plus a `resolveDoodleExplainer2MotionCollageSettings()` resolver mirroring `resolvePaintExplainerV1Settings()` exactly (read → clamp → fallback to defaults). Reuse the existing `clampPaintSetting()` helper — it's already generic.

### `VideoShot` (in `src/remotion/types.ts`)

```ts
/** Renderer routing hint extended for motion_collage. Same enum as
 *  ProductionRow.shot_kind, threaded through productionDocToVideoConfig. */
shotKind?: 'static' | 'motion' | 'hard_cut' | 'motion_collage';

/** Sliced per-panel URLs for motion_collage shots. Indexed in the
 *  same order as ProductionRow.motion_collage_panel_prompts. The
 *  renderer divides the shot's duration evenly among panels (with
 *  remainder absorbed by the last panel). Absent when shotKind is
 *  not 'motion_collage'. */
motionCollagePanelUrls?: string[];
```

`productionDocToVideoConfig` threads the row's `motion_collage_panel_urls` into the shot's `motionCollagePanelUrls`. One line.

---

## Implementation plan

### Phase 1 — Slicer generalization

**File:** `src/lib/collage-slicer.ts` (modify).

Rename `sliceCollage` to `sliceCollage2x2` and keep the existing signature for back-compat with the current `collage_mode` callers (auto-pipeline + tester). Add a new generic helper:

```ts
export interface CollageSliceGridResult {
  panelUrls: string[]; // length = cols × rows
  sourceWidth: number;
  sourceHeight: number;
  panelWidth: number;
  panelHeight: number;
  totalMs: number;
}

export async function sliceCollageGrid(
  upscaledUrl: string,
  grid: { cols: number; rows: number },
  opts?: { r2KeyPrefix?: string },
): Promise<CollageSliceGridResult>;
```

Internally: same fetch + sharp metadata path, then a nested loop computing `cols × rows` rectangles using the existing trim math. Each cell's width = `Math.floor(W / cols) - innerTrimX - outerTrimX` (or symmetric for inner cells), same for height. Parallel `Promise.all` upload, same JPEG quality, same R2 naming with a panel index suffix.

`sliceCollage2x2` becomes a thin wrapper: `sliceCollageGrid(url, {cols:2, rows:2}, opts)` then reshapes the array to the existing `[tl, tr, bl, br]` tuple. Zero behavior change for existing callers.

**Test:** `tests/collage-slicer-grid.test.ts` — new file.
- Synthesize a 1920×1080 PNG with magenta tiles per cell + black gutters → assert `sliceCollageGrid` returns the right number of panels with correct dimensions for 2×2, 3×2, 4×3, 1×4.
- Reject impossible grids (cols×rows > 16; cols < 1 or rows < 1; non-integer).
- Assert the source PNG is small enough that crop rectangles stay positive at every grid.

### Phase 2 — Pipeline generation function

**File:** `src/lib/auto-pipeline/production-doc-image-gen.ts` (modify) — add a new exported function `generateMotionCollage`.

Signature:

```ts
export async function generateMotionCollage(opts: {
  row: PipelineImageRow;
  doc: PipelineImageDoc;
  workspaceId: string;
}): Promise<{
  collageImageUrl?: string;
  panelUrls?: string[];
  costUsd: number;
  durationMs: number;
  error?: string;
}>;
```

Behavior:

1. **Validate the row.** `shot_kind === 'motion_collage'`, grid present, `cols × rows` matches `panel_prompts.length`, `cols × rows ≤ MAX_GRID_PANELS_HARD_CAP` (= 16). Reject with error otherwise (no AI call).
2. **Build the collage prompt.** Reuse the existing prompt template style from the current `generateCollageGroup` but parameterized:

   ```
   A {cols}×{rows} grid storyboard of {N} keyframes showing one continuous motion,
   separated by a thin neutral grey border (10px) between all panels.
   The composition, character, camera angle, background, and lighting are
   IDENTICAL across every panel — only the {moving element} advances frame-by-frame.

   Panel 1 (top-left): <prompt 1>
   Panel 2: <prompt 2>
   ...
   Panel N (bottom-right): <prompt N>
   ```

   Per-row style suffix (the existing `doodle_explainer_2` ai_image_suffix) prepends the whole block, NOT each panel — every panel shares style. The character_descriptions block from `doc.doodle_explainer_2_character_descriptions` also prepends so recurring characters stay consistent.

3. **Dispatch to the chosen model.** Reuse the existing model-dispatch path (`doc.image_model_default` → workspace default → fall through). Generation is at 1K; the existing `pollKieResultThenUpscale` runs Recraft Crisp Upscale post-generation, so the collage lands at ~4K before slicing. Atlas T2I path uses the same upscale wrapper.
4. **Slice.** Call `sliceCollageGrid(upscaledUrl, row.motion_collage_grid!, { r2KeyPrefix: 'prodoc-images-motion-collage' })`.
5. **Validate panel count.** Defensive: `result.panelUrls.length === cols × rows`. Mismatch → error (don't write garbage to the row).
6. **Return.** Cost = generation cost + upscale cost. Caller writes URLs onto the row.

### Phase 3 — Pipeline stage handler integration

**File:** `src/lib/auto-pipeline/stages/generate-production-doc-images.ts` (modify).

Add a per-tick cap:

```ts
const MAX_MOTION_COLLAGE_PER_TICK = 2;
```

Lower than `MAX_MOUTH_REMOVED_PER_TICK = 3` because a motion_collage generation is heavier (more elaborate prompt → more pixels → longer Recraft upscale on a ~4K target). 2 keeps the worst-case tick at: `2 × 90s collage gen + 1 × 60s upscale + other work` well under the 300s Vercel ceiling.

In the per-row plan-building loop, recognize `shot_kind === 'motion_collage'` rows and route them to a new branch BEFORE the regular base/variant generation:

```ts
if (
  item.kind === 'base'
  && doc.rows[item.index].shot_kind === 'motion_collage'
  && motionCollageThisTick < MAX_MOTION_COLLAGE_PER_TICK
) {
  // Settings gate — if the doc-level setting says disabled, skip the
  // generation and leave image_url empty (the LLM shouldn't have
  // emitted these in the first place, but defense in depth).
  const settings = resolveDoodleExplainer2MotionCollageSettings(doc);
  if (!settings.allow_motion_collage) {
    logger.warn('[motion-collage] row has shot_kind motion_collage but doc settings disable it', {
      pipeline_video_id: video.id,
      row_index: item.index,
    });
    failed += 1;
    continue;
  }
  const r = await generateMotionCollage({
    row: doc.rows[item.index],
    doc,
    workspaceId: video.workspace_id,
  });
  motionCollageThisTick += 1;
  tickCostUsd += r.costUsd;
  if (r.collageImageUrl && r.panelUrls) {
    doc.rows[item.index].motion_collage_image_url = r.collageImageUrl;
    doc.rows[item.index].motion_collage_panel_urls = r.panelUrls;
    // Also write image_url to the first panel so any UI surface that
    // reads .image_url (saliency map, hover thumbnails, etc.) doesn't
    // see an empty cell.
    doc.rows[item.index].image_url = r.panelUrls[0];
    succeeded += 1;
    motionCollageSucceeded += 1;
  } else {
    failed += 1;
    motionCollageFailed += 1;
  }
  continue;
}
```

Skip-conditions for the existing `baseIndicesToGen` walk: motion_collage rows are added to that list (they're variant_index 0 / standalone) but the regular `generateBaseImage` path doesn't know about them. The handler routes via the `shot_kind` check above; the regular path is unreached for those rows. Idempotency: a row whose `motion_collage_panel_urls` is already populated is skipped at the partition step (`row.image_url?.trim()` is now non-empty since we wrote the first panel as `image_url`).

Add to the per-tick summary log:

```ts
motion_collage_attempted: motionCollageThisTick,
motion_collage_succeeded: motionCollageSucceeded,
motion_collage_failed: motionCollageFailed,
```

### Phase 4 — Remotion scene

**New file:** `src/remotion/scenes/MotionCollageScene.tsx`.

```tsx
/**
 * MotionCollageScene — renders a doodle_explainer_2 motion_collage shot
 * by playing the row's pre-sliced panel images as hard-cut keyframes
 * across the shot's duration. The panels come from a single AI-generated
 * N×M grid image, sliced server-side by the pipeline; consistency
 * between frames is guaranteed because they were drawn in one pass.
 *
 * No fades between panels (hard cuts only) — fades defeat the keyframe-
 * animation feel and read as slideshow. The outer SceneTransition handles
 * the row's entry/exit fade per the doc-level + per-row fade settings.
 *
 * Falls back to a single still (panel 0, or shot.imageUrl) when no
 * panels are present — handles the case where the pipeline hasn't run
 * yet OR generation failed. Better to show a held frame than a blank.
 *
 * See _plans/2026-05-31-doodle-explainer-2-motion-collage.md.
 */
import React from 'react';
import { AbsoluteFill, Img, Sequence, useVideoConfig } from 'remotion';
import { LowerThird, type LowerThirdVariant } from '../components/LowerThird';
import { SceneTransition } from '../components/SceneTransition';
import type { BrandKit, VideoShot } from '../types';

interface MotionCollageSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  suppressLowerThird?: boolean;
  fadeEnabled?: boolean;
  lowerThirdVariant?: LowerThirdVariant;
}

export const MotionCollageScene: React.FC<
  MotionCollageSceneProps & { shotIndex?: number }
> = ({
  shot,
  durationInFrames,
  brand,
  shotIndex = 0,
  suppressLowerThird = false,
  fadeEnabled = true,
  lowerThirdVariant = 'doodle-yellow',
}) => {
  const { fps } = useVideoConfig();
  const panels = shot.motionCollagePanelUrls ?? [];
  const N = panels.length;

  // Fallback path: no panels yet (pipeline hasn't generated, or
  // generation failed). Render the row's regular image as a held frame
  // so the editor preview isn't blank.
  if (N === 0) {
    if (shotIndex < 5) {
      console.info('[motion-collage] fallback to single image — no panels', {
        shotIndex,
        hasImageUrl: Boolean(shot.imageUrl),
      });
    }
    return (
      <AbsoluteFill style={{ background: brand.backgroundColor, overflow: 'hidden' }}>
        {shot.imageUrl && (
          <Img
            src={shot.imageUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        {/* LowerThird + SceneTransition mounted below in the success path */}
      </AbsoluteFill>
    );
  }

  // Equal subdivision across the shot window. Last panel absorbs the
  // remainder so the total exactly equals durationInFrames.
  const panelFrames = Math.floor(durationInFrames / N);
  const remainder = durationInFrames - panelFrames * N;

  if (shotIndex < 5) {
    console.info('[motion-collage mounted]', {
      shotIndex,
      panel_count: N,
      panel_frames_each: panelFrames,
      remainder_added_to_last: remainder,
      duration_frames: durationInFrames,
      duration_seconds: durationInFrames / fps,
    });
  }

  return (
    <AbsoluteFill style={{ background: brand.backgroundColor, overflow: 'hidden' }}>
      {panels.map((url, idx) => {
        const from = idx * panelFrames;
        const dur = idx === N - 1 ? panelFrames + remainder : panelFrames;
        return (
          <Sequence
            key={`panel-${idx}`}
            from={from}
            durationInFrames={dur}
            layout="none"
          >
            <Img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </Sequence>
        );
      })}
      {/* LowerThird and SceneTransition — same chrome as MotionScene and
          BRollScene. Forwarded props govern fade + variant. */}
      {!suppressLowerThird && <LowerThird shot={shot} variant={lowerThirdVariant} />}
      <SceneTransition shot={shot} fadeEnabled={fadeEnabled} durationInFrames={durationInFrames} />
    </AbsoluteFill>
  );
};
```

### Phase 5 — Scene routing

**File:** `src/remotion/compositions/YouTubeVideo.tsx` (modify, ~5 lines).

Add a branch immediately above the existing `if (shot.shotKind === 'motion')`:

```ts
if (shot.shotKind === 'motion_collage') {
  return (
    <MotionCollageScene
      {...props}
      shotIndex={shotIndex}
      suppressLowerThird={shot.suppressLowerThird ?? suppressLowerThirds}
      fadeEnabled={resolveSceneFade(shot, doc)}
      lowerThirdVariant={lowerThirdVariant}
    />
  );
}
```

Import `MotionCollageScene` at the top. That's it for routing — the rest of the composition (audio, overlays, music) is shared and runs over the new scene unchanged.

### Phase 6 — `productionDocToVideoConfig` plumbing

**File:** `src/remotion/utils.ts` (modify) — in the function that builds `VideoShot` from `ProductionRow`, thread the new field:

```ts
shotKind: row.shot_kind,
motionCollagePanelUrls: row.motion_collage_panel_urls,
```

One line each. The existing thread-through for `shotKind` (today: `'static' | 'motion' | 'hard_cut'`) extends naturally — the enum widening is type-level only.

### Phase 7 — Style mixing rules

**File:** `src/lib/production-doc-styles.ts` (modify) — extend the `doodle_explainer_2` `mixing_rules` with a new section. Insert AFTER the existing "VARIANT GROUPS" section and BEFORE "CHARACTERS":

```
== MOTION COLLAGE — REAL FRAME-BY-FRAME MOTION ==

When a beat describes REAL PHYSICAL MOTION that can't be captured by an
additive variant ("a character runs across the room", "a logo assembles
piece by piece", "a glass falls and shatters", "a hand types frantically",
"a text message types itself out", "an object falls through frame"),
emit `shot_kind: "motion_collage"` instead of forcing it into a variant
group. Motion collage produces ONE generation that contains N keyframes
in a grid (2×2, 3×2, 3×3, 4×3, …); the pipeline slices it into N
keyframes and the renderer plays them hard-cut over the row's duration.

WHEN TO USE:
- Character locomotion across the frame (running, walking, climbing,
  falling)
- An object physically moving (door opening, ball bouncing, paper
  falling, smoke rising)
- A transformation arc (fire growing, ice melting, character changing
  expression in a fast sequence, fluid spreading)
- Text or a logo appearing piece-by-piece or letter-by-letter
- A piece of evidence being assembled / disassembled in real time
- Any "before-during-after-after-after" sequence happening in ONE beat

WHEN NOT TO USE:
- Static or slow narration beats — use regular Animation rows.
- Pivot / topic change — use `shot_kind: "hard_cut"`.
- Reaction beats (eyebrow raise, mouth opens in surprise) — use the
  existing variant group system. Those don't need real motion.

GRID SIZE: pick the smallest grid that fits the motion arc. Most cases
are 2×2 (4 keyframes, the "before / starting / mid / end" arc). Use
3×2 (6) for motions that need a clearer middle. Use 3×3 (9) only for
elaborate sequences. Hard cap: 16 panels total. The pipeline will
reject anything larger.

EMITTING THE FIELDS:
- `shot_kind: "motion_collage"`
- `motion_collage_grid: { cols, rows }`
- `motion_collage_panel_prompts: ["<panel 1>", "<panel 2>", ...]`
  Length MUST be cols × rows. Order: left-to-right, then top-to-bottom.
- Leave `ai_image_prompt` EMPTY on motion_collage rows. The pipeline
  composes the collage prompt from `motion_collage_panel_prompts`.
- `script_text`, `on_screen_text`, `overlay_stock_terms`, etc. work
  normally — the row is still a normal narration beat.

PER-PANEL PROMPT RULES:
- The composition, character, camera, background, and lighting are
  IDENTICAL across every panel — only the moving element advances.
  Repeat the static parts in each panel prompt so the model has them
  reliably; the model will keep them stable across panels anyway, but
  redundancy helps consistency.
- Describe the moving element's STATE at THIS panel, not the action.
  GOOD: "the runner's right foot is mid-stride, left foot is planted"
  BAD: "the runner takes a step"
- For text-appears-by-letter: each panel shows the partial string up
  to that point. Panel 1: "H", Panel 2: "HE", Panel 3: "HEL", etc.
- Stick to ONE motion per shot. Don't try to cram a character running
  AND a logo assembling AND fire growing into the same grid.

WORKED EXAMPLE — "George runs from the burning house to the truck":
  shot_kind: "motion_collage"
  motion_collage_grid: { cols: 3, rows: 2 }  // 6 keyframes
  motion_collage_panel_prompts: [
    "<base composition: the burning house left, the truck far right,
      George standing just outside the front door, mid-stride starting
      to lift his right foot; flames on the roof; brown ground; sky
      gray with smoke>",
    "<same composition; George now 1/5 of the way across, both feet
      mid-air, arms swinging>",
    "<same composition; George now 2/5 across, right foot planted,
      left foot lifting>",
    "<same composition; George now 3/5 across, both feet mid-air again,
      arms swinging in opposition>",
    "<same composition; George now 4/5 across, right foot landing
      near the truck>",
    "<same composition; George at the truck, hand on the driver-side
      door handle, looking back at the house>"
  ]

The narration "George ran from the burning house to the truck" plays
over all 6 frames; each frame holds ~400 ms; the brain reads it as
continuous motion. ONE generation cost.

CADENCE: motion_collage is a SPICE, not a staple. Aim for at most
~1 motion_collage shot per 15-20 rows. Over-using it makes the video
feel like an animated short instead of a documentary doodle.
```

### Phase 8 — Settings panel

**New file:** `src/components/production-doc/DoodleExplainer2MotionCollageSettingsPanel.tsx`.

Clone the `PaintExplainerV1SettingsPanel` structure with the 4 new fields. Same primitives (`Field`, `Toggle`, `NumberWithUnit`), same purple-accented frame, same "Reset to defaults" affordance. Labels:

1. **Allow motion collage** (Toggle) — "Off disables every motion_collage shot for this doc."
2. **Max grid panels** (NumberWithUnit, unit: "panels") — "Hard ceiling per shot. Higher = longer generations, more nuanced motion."
3. **Min per-frame duration** (NumberWithUnit, unit: "ms") — "Frames briefer than this read as flicker. Cap at 5fps minimum."
4. **Max per-frame duration** (NumberWithUnit, unit: "ms") — "Frames longer than this stop feeling like motion."

**File:** `src/app/(app)/production-doc/page.tsx` (modify) — mount the panel conditional on `stylePreset === 'doodle_explainer_2'`, immediately below the existing `doodle_explainer_2` editor controls (find the closest sibling and wire in the same `setDoc` pattern used for `paint_explainer_v1_settings`).

### Phase 9 — Editor surface (Shot Inspector)

The shot inspector should let a user manually flip a row to `motion_collage` for testing without re-running doc-gen. v1 implementation: a small "Motion collage" toggle in the shot inspector for `doodle_explainer_2` rows, with grid picker (2×2 / 3×2 / 3×3 / 4×3) and a textarea per panel. When the user toggles it on, the row's `image_url` is cleared and the per-shot Regenerate button calls the new pipeline.

Defer the full editor UI to a follow-up plan — the LLM-emitted path is the v1 priority. Manual editor support is QA-only at first.

---

## Security (rule 13)

- **Server-only generation.** The new `generateMotionCollage` function runs in the server-side pipeline stage; no client ever invokes the image model directly. Same trust boundary as existing collage generation.
- **Prompt injection surface.** The LLM emits `motion_collage_panel_prompts`. Those flow into the model prompt unchanged. Risk is the same as the existing `ai_image_prompt` field: the model itself is the trust boundary. No new SQL / shell / SSRF surface.
- **Server-side validation.**
  - `cols × rows <= 16` (HARD CAP, irrespective of doc settings — defense in depth against a misconfigured doc).
  - `cols >= 1`, `rows >= 1`, both integers.
  - `motion_collage_panel_prompts.length === cols × rows`.
  - Each panel prompt has a hard character cap (~1500 chars; matches existing prompt caps).
  Reject early, log, mark the row failed.
- **R2 storage.** Sliced panel images upload to the same `prodoc-images-*` bucket prefix the existing collage uses, just with a new sub-prefix (`prodoc-images-motion-collage/`). Same IAM, same lifecycle.
- **Cost cap interaction.** The existing per-job `PIPELINE_IMAGE_GEN_CAP_USD` cap counts motion_collage spend just like every other call. The estimator (in the cost pre-check section) treats a motion_collage row as 1 base call at the chosen model's per-call price + Recraft upscale. Conservative; over-estimates slightly because we add a flat $0.05 buffer instead of computing exact Atlas vs. Kie pricing inline.
- **Kill switch.** `process.env.MOTION_COLLAGE_ENABLED` — when explicitly `'false'`, the pipeline refuses to generate any motion_collage row (logs a warning, marks rows failed). Lets us disable globally without a redeploy if a model regression breaks the feature. Default: enabled.
- **No PII.** No new user data flows through this path. The collage image URL and panel URLs are the same R2-hosted JPEGs as existing shot images.

## Observability (rule 14)

Every step emits a namespaced log line. Greppable on Vercel + browser console:

- `[motion-collage pipeline] start { row_index, grid, panel_count, model }`
- `[motion-collage pipeline] kill-switch off — skipping { row_index }`
- `[motion-collage pipeline] settings-disabled { row_index }`
- `[motion-collage pipeline] grid validation failed { row_index, reason }`
- `[motion-collage pipeline] generated { row_index, collage_url, ms, cost_usd }`
- `[motion-collage pipeline] sliced { row_index, panel_count, panel_w, panel_h, ms }`
- `[motion-collage pipeline] slice count mismatch { row_index, expected, actual }`
- `[motion-collage pipeline] failed { row_index, error }`
- `[motion-collage mounted]` (renderer, first 5 shots only) `{ shotIndex, panel_count, panel_frames_each, remainder_added_to_last, duration_frames, duration_seconds }`
- `[motion-collage] fallback to single image — no panels` (renderer) `{ shotIndex, hasImageUrl }`

Per-tick summary additions to the existing image-gen tick log:
- `motion_collage_attempted: <count>`
- `motion_collage_succeeded: <count>`
- `motion_collage_failed: <count>`

Telemetry signal worth tracking once the feature ships: ratio of motion_collage rows the LLM emits per doc vs. total rows. Reference: <8%. If a doc lands above 15%, the LLM is over-using; pivot the mixing_rules cadence guidance.

## Settings (rule 15)

New doc-level settings, all on the `doodle_explainer_2_motion_collage_settings` object:

| Setting | Default | Bounds | Description |
|---|---|---|---|
| `allow_motion_collage` | `true` | — | Global kill for this doc. |
| `max_grid_panels` | 12 | [4, 16] | Hard cap on panels per shot. |
| `min_per_frame_ms` | 200 | [100, 500] | Frame-flicker floor. |
| `max_per_frame_ms` | 800 | [300, 1500] | Slideshow ceiling. |

Lives in the new `DoodleExplainer2MotionCollageSettingsPanel`, mounted on the production-doc page below the existing style-conditional sections. Mirrors the `paint_explainer_v1` settings panel pattern.

Settings INTENTIONALLY NOT exposed in v1 (added complexity for niche tweaks):
- Per-frame fade duration. Hard cuts only in v1.
- Custom gutter pixel width. The slicer's trim percentages handle the gutter the model produces.
- Per-style settings (e.g. for some hypothetical future `doodle_explainer_3` style). When/if a second style adopts motion_collage, the settings object can be hoisted to a doc-level `motion_collage_settings` and shared.
- Word-onset snapping for frame transitions. v2.

Workspace-level defaults: future PR (matches the `paint_explainer_v1` settings posture).

## Testing (rule 18)

### Unit tests

**`tests/collage-slicer-grid.test.ts`** (new) — covers Phase 1.
- Slice a synthesized 1920×1080 4-tile PNG with known cells → assert 4 panels at expected dimensions.
- Slice 3×2, 3×3, 4×3, 1×4 — assert panel count + each dimension.
- Reject impossible grids: `{cols:0, rows:1}`, `{cols:1.5, rows:1}`, `{cols:5, rows:5}` (25 > 16 hard cap).
- Reject crops that fall out of bounds (e.g. a tiny 100×100 source with cols=4 rows=4 → trim math produces negative dimensions, function throws `CollageSliceError`).

**`tests/motion-collage-validation.test.ts`** (new) — covers schema validation in `generateMotionCollage`.
- Reject row missing `motion_collage_grid` → error.
- Reject row whose `panel_prompts.length` doesn't match `cols × rows` → error.
- Reject `cols × rows > 16` even when doc settings allow more → error (hard cap).
- Reject empty / whitespace-only panel prompt → error.
- Accept valid 2×2, 3×2, 3×3, 4×3, 4×4.

**`tests/motion-collage-frame-math.test.ts`** (new) — covers the per-frame timing math in `MotionCollageScene`.
- For `durationInFrames=120, N=4` → 30 frames each, remainder 0.
- For `durationInFrames=121, N=4` → 30 frames first 3, 31 frames last.
- For `durationInFrames=100, N=6` → 16 frames first 5, 20 frames last.
- For `N=0` → fallback path returns the single-image render.

**`tests/motion-collage-settings.test.ts`** (new) — covers the resolver.
- `resolveDoodleExplainer2MotionCollageSettings(undefined)` → defaults.
- Clamps out-of-bound values.
- Preserves valid values.
- Mirrors existing `tests/paint-explainer-v1-settings.test.ts` shape.

### Integration tests (deferred to v1.1)

End-to-end pipeline run with a fake LLM-emitted motion_collage row → assert R2 has N+1 images uploaded (collage + N panels) and the row's URLs are populated. Requires a fake image model in the test harness; defer until after we see real behavior in the editor preview.

### Manual QA before declaring v1 done

1. Create a doc with `doodle_explainer_2` style. Manually craft a row with `shot_kind: 'motion_collage'`, `{cols:2, rows:2}`, 4 panel prompts describing a running stick figure. Run the pipeline. Verify 4 panel URLs land in R2, the row's `image_url` shows panel 0.
2. Open the doc in the editor. Preview the row. Verify the 4 panels flip hard-cut over the row's duration.
3. Run with `{cols:3, rows:2}` (6 panels). Verify same end-to-end.
4. Run with `{cols:5, rows:5}` (25 > 16 cap). Verify rejection, no R2 upload, row marked failed with the right error in the inspector.
5. Flip the doc setting `allow_motion_collage: false`. Re-run pipeline on a `motion_collage` row. Verify it's skipped and logged.
6. Set `MOTION_COLLAGE_ENABLED=false` env. Verify global kill works even when doc setting is on.
7. Run a doc with one motion_collage row AND existing `collage_mode: true` for other rows. Verify the two paths don't trip over each other (different R2 prefixes, independent counters).
8. Render the full video. Verify motion_collage shots play cleanly in the actual MP4 output (not just the editor preview).

## UX (rules 10 + 16)

- **Doc settings panel** — clean labels, plain language, every numeric field shows the unit. Toggle copy: "Off disables every motion_collage shot for this doc." Tooltip on max_grid_panels: "Higher = longer generations, finer motion. 12 is enough for most arcs."
- **Editor shot inspector** — when the user opens a `motion_collage` row, show all N panels in a small grid preview (not just panel 0). Make the per-panel prompts editable inline. Per-shot Regenerate re-runs the full collage generation.
- **Loading state** — motion_collage generation is slower than a single image (~60-90s for the collage + 20-30s upscale + ~5s slice). The editor's per-row progress UI shows "Generating motion collage…" with the count of panels expected so the user knows it's a bigger operation.
- **Error state** — when generation fails, surface the specific error in the row inspector: grid validation, slice mismatch, model error. Don't hide it behind a generic "Generation failed."
- **Fallback display** — when the pipeline hasn't run yet OR generation failed, the renderer shows `shot.imageUrl` as a single held frame (which is panel 0 when generation succeeded, or empty when it never ran). NO broken-image icon, NO scary warning — silent graceful degradation.

## Cost (rule 8)

Per motion_collage row:

| Component | Atlas T2I (gpt-image-2) | Kie GPT Image 2 t2i | Kie Flux 2 Pro t2i |
|---|---|---|---|
| Generation (1 image, 1K) | ~$0.05 | ~$0.04 | ~$0.04 |
| Recraft upscale | $0.0025 | $0.0025 | $0.0025 |
| R2 storage (N panels) | negligible | negligible | negligible |
| **Total per shot** | **~$0.053** | **~$0.043** | **~$0.043** |

Comparison to N independent generations of the same panels: ~4-9× this cost, plus character drift between frames. The single-call collage approach is BOTH cheaper AND visually more consistent.

**Live pricing check required before locking the cost model in code.** Atlas and Kie pricing change. Per rule 8: when implementation starts, the developer pulls fresh per-call prices from each provider's docs and updates the cost-cap estimator constant if it's drifted. Do not rely on the numbers in this plan — they're a 2026-05-31 snapshot, not a contract.

For typical use (~1 motion_collage per 15-20 rows): a 60-row doc has ~3 motion_collage shots = ~$0.15 added per doc. Negligible against the existing per-doc spend ($1-2 typical). No real economic blocker.

---

## Risks + brutal honest concerns (rule 12)

**1. The model may not respect the grid count.** Asking for "3×3" sometimes produces 2×2 or 4×4 because the model decided the prompt was better suited to that layout. The slice math then crops the wrong things. Mitigation: malformed-detection heuristics from the existing collage path catch this (histogram + Sobel on each cell). If detected, we log + mark failed; no automatic retry in v1 to avoid runaway spend.

**Honest read:** this WILL happen sometimes. Even with strong prompt language, model compliance on grid count is 80-95% depending on the model. The user should be prepared to manually re-roll a failed shot from the editor inspector. Don't pretend it'll always work.

**2. Frame coherence between panels can drift even within one generation.** The model might draw the character slightly differently in each cell. Mitigation: the character_descriptions block from the doc + strong per-panel prompts that REPEAT the static composition. But this isn't bulletproof; subtle drift is realistic, especially for elaborate scenes.

**Honest read:** for SIMPLE motions (a character running across a flat background), this works well. For COMPLEX scenes (busy backgrounds, multiple characters, fine details), drift will be visible. Set user expectations: motion collage is good for clean isolated motions, not for "the whole scene comes alive."

**3. 16-panel hard cap may feel tight for elaborate motions.** A walking cycle that REALLY breathes wants 12+ frames. We cap at 16 total. Above that, generation cost climbs and panel resolution per cell drops below usable.

**Honest read:** 16 IS the right cap. Going higher trades cost and quality. If the user wants longer motions, they should split into multiple consecutive `motion_collage` rows. Document this in the mixing_rules.

**4. The LLM may emit motion_collage where it doesn't belong.** Cool new toy → over-used. Mitigation: explicit "WHEN NOT TO USE" section in mixing_rules + a cadence ceiling (~1 per 15-20 rows). Plus the doc-level kill switch.

**Honest read:** this will happen in the first generation runs. The mixing_rules cadence number will need tuning post-QA. Plan to revisit the ratio after the first 3 production renders.

**5. Sequential frame durations may feel uneven on rows with very short narration.** 2.4s row / 9 panels = 267ms each. Below the min_per_frame_ms ceiling? Depends on settings. The pipeline should cap N to fit the duration; right now the math is "if N would push frames below min_per_frame_ms, reduce N to the largest grid that fits." Need to think through whether the pipeline RE-GENERATES at a smaller grid OR just refuses to run motion_collage on too-short rows. v1 decision: REFUSE (mark the row failed, log a clear reason). Let the LLM re-emit as a different shot_kind on retry.

**Honest read:** this is annoying but better than auto-resizing the grid (which would force a re-generation and double the cost). The reject-and-let-LLM-fix posture also catches a real authoring bug — if the LLM wants 9 panels on a 2-second row, that's bad authorship.

**6. No mouth-swap on motion_collage rows means narrator-style talking doesn't sync.** If a character is talking AND running in the same beat, the lips won't move during the run. Mitigation: narrator-mascot type characters who are mostly stationary should use `shot_kind: 'motion'` (paint_explainer_v1 path) when they're talking, NOT motion_collage. motion_collage is for action shots where the character is busy doing the action.

**Honest read:** acceptable tradeoff. Real 2D animation does the same thing — when a character is doing big motion, the lip sync goes loose and the audio carries the dialogue.

---

## Delivery order

1. **Phase 1** — generalize `collage-slicer.ts` to `sliceCollageGrid`, keep `sliceCollage2x2` wrapper. Tests. Merge.
2. **Phase 2** — `generateMotionCollage` in `production-doc-image-gen.ts`. Tests for validation. Merge.
3. **Phase 3** — pipeline stage handler integration in `generate-production-doc-images.ts`. End-to-end smoke test from a hand-crafted row. Merge.
4. **Phase 4 + 5 + 6** — `MotionCollageScene.tsx` + SceneRouter branch + `productionDocToVideoConfig` plumbing. Render preview in editor. Merge.
5. **Phase 7** — extend `doodle_explainer_2` mixing_rules. Generate a fresh doc that uses motion_collage. QA the LLM emissions. Merge.
6. **Phase 8** — `DoodleExplainer2MotionCollageSettingsPanel.tsx` + mount in the production-doc page. Merge.
7. **Phase 9** — editor inspector surface for manual editing. Merge.
8. **QA round** — run the manual QA checklist end-to-end. Tune mixing_rules cadence based on what the LLM actually emits. Tune slicer trim percentages if gutter remnants appear.
9. **Memory + ROADMAP updates** — log the new shot_kind in any per-style cheatsheet memory; update ROADMAP per project convention.

## Out of scope (deferred to follow-up plans)

- **Word-onset snapping** for frame transitions (v2).
- **Cross-shot motion** (a motion arc spanning 2+ consecutive rows). The current v1 keeps motion within ONE shot's window.
- **Atlas Edit chaining** for refining individual panels after generation. v1 is one-shot regenerate-the-whole-collage.
- **Bilateral mirror** — generate one motion arc and mirror for left/right symmetry (e.g. a character running left vs. right). v2 if needed.
- **Audio-reactive frame timing** — driving frame transitions off music beats or VO emphasis. v2.
- **Workspace-level defaults** for the settings panel. v2 (matches paint_explainer_v1 posture).
- **Retrofitting motion_collage onto `paint_explainer_v1`** — that style already has motion via procedural overlays. Cross-pollination would be its own plan.

## Open questions

1. **Atlas vs. Kie for the default model.** Atlas T2I is the user's "GPT Image 2" reference, but the existing collage path uses Kie t2i only. Both work; need a brief experiment in the collage-tester debug panel to see which produces tighter grid compliance. Defer to implementation — verify at Phase 2 time.
2. **Should `motion_collage` rows respect the `variant_index` system?** No in v1 — they're standalone shots, no variant grouping. If we discover a use case where the user wants 2 motion_collage rows sharing a base, we can add it. Don't speculate.
3. **`section_title` rendering over motion_collage frames.** The doodle-yellow LowerThird variant is the doc-level overlay; should it persist across all N panels or refresh per panel? v1 decision: persist (the LowerThird renders once over the whole shot, same as every other shot_kind). Revisit if the title looks weirdly STATIC against rapidly-changing frames.
4. **Editor saliency map.** Each motion_collage shot has N images; the saliency feature currently expects ONE image. v1: only computes saliency for panel 0 (the row's `image_url`). v2: average saliency across panels OR pick the panel with the highest contrast for the overlay-placement decision. Defer.

---

## References

- Existing collage infrastructure: `src/lib/collage-slicer.ts`, `_plans/2026-05-24-system-upscale-and-collage.md`, `_plans/2026-05-26-collage-default-on-with-per-cell-augmentation.md`, `_plans/2026-05-28-auto-pipeline-collage-port.md`.
- Paint Explainer V1 (sibling motion-driven style): `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
- Doodle Explainer 2 foundation: `_plans/2026-05-25-doodle-explainer-2-built-in.md`, `_plans/2026-05-27-doodle-explainer-2-foundation.md`.
- Near-static variants (existing motion-like system): `_plans/2026-05-25-near-static-variants.md`, `_plans/2026-05-28-doodle-2-chained-variants.md`.
- Vercel function timeout (300s default): per session knowledge update, no change required.
- Sharp library (already at v0.34.5): used in `src/lib/collage-slicer.ts` already, zero new deps.
