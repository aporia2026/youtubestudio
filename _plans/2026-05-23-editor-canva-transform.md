# 2026-05-23 — Editor Canva-style free-transform on per-shot visual

## Goals

The user wants to select the image/video/animation on each scene and
freely position + resize + rotate it, like Canva. Today, a row's visual
fills the 1920×1080 frame uniformly (`object-fit: contain/cover`) with
a single `scene_zoom` slider for uniform scale and `pillarbox_color`
for the background. There's no way to crop, offset, or rotate.

This plan adds a Canva-style free-transform on every shot.

## Constraints

- **Editor preview and render output must match exactly.** The
  renderer is the source of truth; the editor's interactive overlay
  just dispatches transform updates. No second timing path.
- **Applies to stills AND clips.** Same transform fields on every row
  regardless of source — one mental model.
- **Keep `scene_zoom` alongside.** Existing docs that rely on
  `scene_zoom` keep working; the new transform composes on top
  (final scale = scene_zoom × image_scale_pct).
- **No new asset writes.** Transform fields live on `ProductionRow`,
  go through the existing full-payload PATCH (doc.rows is not asset-
  blind), so persistence reuses what's already there.
- **Settings audit (rule 15):** new per-shot fields. Doc-level
  defaults (image_x_default, image_y_default, image_scale_default,
  image_rotation_default) are deferred to a follow-up — the MVP
  surfaces only per-shot transforms.

## Data model

Four new optional fields on `ProductionRow` in
`src/remotion/utils.ts`:

```ts
/** Free-transform offset of the visual element on the 1920×1080
 *  canvas, expressed as a percentage of canvas width/height from
 *  the center. `0` = centered. Range [-100, 100]. */
image_x_pct?: number;
image_y_pct?: number;

/** Free-transform scale of the visual element as a percentage of
 *  its natural fit size. `100` = fits the canvas the way today's
 *  render does. Composes with `scene_zoom`: effective scale is
 *  scene_zoom% × image_scale_pct%. Range [10, 400]. */
image_scale_pct?: number;

/** Free-transform rotation in degrees, clockwise. `0` = no
 *  rotation. Range [-360, 360]. Stored unbounded so spins can be
 *  represented (the renderer applies modulo). */
image_rotation_deg?: number;
```

The migrator already passes unknown row fields through verbatim, so
older docs without these fields default to undefined → render
identical to today.

## Renderer change

`src/remotion/scenes/BRollScene.tsx` (and the FallbackBRoll branch)
currently render the still / video inside an `<AbsoluteFill>`. Wrap
the visual element in an inner `<div>` whose `style.transform` is
computed from the four fields:

```ts
const tx = (shot.imageXPct ?? 0) * 0.01 * 1920;
const ty = (shot.imageYPct ?? 0) * 0.01 * 1080;
const scale = (shot.imageScalePct ?? 100) * 0.01;
const rotate = shot.imageRotationDeg ?? 0;
style.transform = `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotate}deg)`;
style.transformOrigin = '50% 50%';
```

The Ken Burns inner-zoom still runs as today, sitting inside the
wrapper. `scene_zoom` already wraps the outer AbsoluteFill — the new
transform layers on top of it.

`VideoShot` (in `src/remotion/types.ts`) gains four optional fields
mirroring the row shape so the renderer can read them off the shot.
`productionDocToVideoConfig` forwards them in the mapper.

## Editor surfaces

### Batch A — Foundation (MVP, ship first)

- Data model + renderer changes above.
- New inspector card "Transform" in `ShotInspector` with four numeric
  inputs (x %, y %, scale %, rotation °) + Reset button. No
  interactive overlay yet — just numbers.
- `PATCH_ROW` already handles arbitrary row patches; no store changes.

### Batch B — Interactive overlay

- New component `<TransformOverlay>` mounted absolutely positioned
  over the Player container in `EditorClient`.
- Compute the Player's display rect via `ResizeObserver` so the
  overlay tracks resizes.
- Map screen pixels → canvas coords (1920×1080) via the rect.
- Render selection box around the visual element with 8 handles (4
  corners aspect-locked, 4 edges free).
- Mouse-down on the body starts a move drag; mouse-down on a handle
  starts a resize drag. Mouse-up commits via `PATCH_ROW`.
- Show selection only when a shot is selected on the timeline.

### Batch C — Canva polish

- Rotation handle (small circle above the selection box).
- Snap guides: snap to canvas center, canvas edges, and 25% / 50% /
  75% gridlines. Shift to disable snapping during a drag.
- Aspect-lock toggle (top of the Transform card). Default locked.
- Keyboard nudges (arrow = 1px, shift+arrow = 10px).
- Reset button per axis + a master Reset.

### Batch D — Multi-shot apply

- "Apply to all shots" button on the Transform card that copies the
  current row's transform to every shot in the doc.
- "Apply to shots 1-N" range picker (mirrors prod-doc's range-apply
  pattern for stripe layout / pillarbox).
- Future: actual multi-select in the timeline. Defer until users
  ask — the apply-to-all pattern handles 90% of the use case.

## Alternatives rejected

- **Replace `scene_zoom` with the new transform.** Cleaner data
  model but breaks every existing doc that has scene_zoom set, and
  scene_zoom's uniform-zoom slider is genuinely useful as a fast
  shortcut. Keep both.
- **Stills-only transform.** Asymmetric — user expects the same
  affordance on every shot regardless of source. Single mental model
  wins.
- **External library (Konva/Fabric.js/Moveable).** Adds a dep + bundle
  size for a feature with well-defined surface. Custom overlay is
  ~300 lines and we control the snap/keyboard semantics. Reconsider if
  Batch C polish gets complicated.

## Security & safety (rule 13)

- All transform inputs clamped at the validator boundary:
  `image_x_pct` ∈ [-200, 200], `image_y_pct` ∈ [-200, 200],
  `image_scale_pct` ∈ [10, 400], `image_rotation_deg` ∈ [-3600, 3600].
- NaN / non-finite values rejected on the migrator side.
- No new endpoints or external calls.

## Observability (rule 14)

- `[editor transform] commit` log on every PATCH_ROW from the overlay
  + numeric inputs (rowIndex, before/after values, source).
- `[editor transform overlay] drag-start / drag-end` with the
  starting + final transform.
- `[renderer transform applied]` (debug level, gated) once per shot
  on first mount so we can verify the renderer is reading the fields.

## QA plan (rule 6)

After each batch:
1. Set transform on shot 1 → preview reflects → save → reload → still
   there.
2. Set transform → render MP4 → MP4 frame matches preview frame.
3. Transform composes with scene_zoom: scene_zoom 80% + image_scale 50% →
   effective 40%.
4. Reset button clears all four fields.
5. Reorder shots → transforms travel with their rows.
6. Two tabs: edit transform in one, second tab pulls from doc → sees
   the new transform.
7. Both stills and B-roll clips honor the transform.
