# Scene transition controls — production-doc Remotion preview/render

**Date**: 2026-05-17
**Branch**: phase-1-foundation
**Status**: approved by user, ready to implement

## Goal

Let the creator control the transition between scenes in the production-doc
Remotion preview/render. Two distinct transitions exist today; the user wants
both controllable, with an option to disable each one entirely (immediate cut).

1. **Scene-to-scene cross fade** — currently every scene component renders a
   `<SceneTransition fadeIn fadeOut />` overlay that fades to/from black at
   the start and end of each shot. Always on; no UI to disable it.
2. **Thumbnail-zoom transition** — already user-controllable
   (`hard-cut` / `smooth` kinds with speed + easing). Missing: a "no
   transition at all" option that lands on the target region immediately.

## Requirements (confirmed)

- Both transitions controllable.
- Doc-level default **plus** per-row override (matches the existing thumbnail-
  zoom transition UX pattern).
- "No transition at all" means **everything** removed — the very first
  fade-in-from-black on the opening scene and the very last fade-out on the
  outro also disappear. Video starts and ends on its first/last rendered frame.

## Out of scope

- Cross-fade between scenes (A→B blend). Today's "transition" is a fade to
  black at the boundary, not a blend. Cross-fading would need both scenes
  to render simultaneously, which is a separate plan.
- New transition kinds beyond `none` for the thumbnail zoom (`slide`, `wipe`,
  etc.). Punted until asked.

## Data model

`src/remotion/types.ts`:

- `ThumbnailTransitionKind` becomes `'hard-cut' | 'smooth' | 'none'`.
- New `VideoConfig.sceneFadeEnabled?: boolean` — doc-level default. `undefined`
  ⇒ `true` so every existing rendered doc keeps current behaviour.
- New `VideoShot.sceneFade?: boolean` — per-row override. `undefined` falls
  through to doc default.

`src/remotion/utils.ts`:

- New `ProductionDoc.scene_fade_enabled?: boolean` — persisted doc default.
- New `ProductionRow.scene_fade?: boolean` — persisted per-row override.
- `productionDocToVideoConfig` maps both fields onto `VideoConfig` / `VideoShot`.

Storage: both fields are optional booleans; they round-trip through the
existing JSON `saveProductionDocEntry` / `updateProductionDocEntry` path the
same way `pillarbox_color_default` already does — no migration needed.

## Renderer

`src/remotion/compositions/YouTubeVideo.tsx`:

- In `SceneRouter`, resolve `fadeEnabled = shot.sceneFade ?? config.sceneFadeEnabled ?? true`.
- Pass `fadeEnabled` prop to every scene component.
- Emit `[scene-fade resolved]` log per shot (one-shot, frame 0 only) with
  `{ shotIndex, perRow, docDefault, resolved }`.

Six scene components — `BRollScene`, `TitleCardScene`, `TextRevealScene`,
`IconScene`, `ScreenMockupScene`, `OutroScene`, and `FallbackBRoll` (inside
BRollScene) — accept `fadeEnabled?: boolean` (default `true`) and pass
`fadeIn={fadeEnabled} fadeOut={fadeEnabled}` to their `<SceneTransition>`.

`ThumbnailZoomScene`:

- When `transition.kind === 'none'`, skip both phases (hard-cut path's
  hold + zoom, smooth path's zoom-out-then-in) — render the `target`
  framing from frame 0.
- Gate the existing 4-frame `intro` opacity ramp on `fadeEnabled` so the
  scene also responds to the scene-fade toggle.

## UI

### Thumbnail-zoom `'none'` kind

`src/components/production-doc/TransitionDialog.tsx`:

- Add a third Style button: **"None — immediate cut to target"**.
- When `kind === 'none'`, hide the Speed slider + Easing dropdown (they
  have no effect). Keeps the dialog honest.
- `speedFromConfig` / `configForSpeed` continue to operate on the stored
  durations; `'none'` doesn't need them.

### Scene-fade doc-level default

`src/app/(app)/production-doc/page.tsx`:

- Add a small two-state pill (**"Scene fade: On / Off"**) inside the Video
  Preview & Render section header. Always visible — does NOT require a
  thumbnail. Reads `doc.scene_fade_enabled` (default `true` when undefined).
- On toggle: `console.info('[ui scene-fade] doc default', { from, to })` then
  update the doc.

### Scene-fade per-row override

`src/components/production-doc/SectionRowControls.tsx`:

- Add a small three-state pill (**"Fade / Cut / Default"**) at the bottom
  of the row controls.
- Drop the `doc.thumbnail` gate on `<SectionRowControls>` in `page.tsx` so
  the pill renders for every row. Inside the component, the thumbnail-zoom
  controls stay gated on `thumbnail` being non-null.
- On change: `console.info('[ui scene-fade] row override', { rowIndex, from, to })`
  then update the row.

### Three-state pill semantics

- `Default` — `scene_fade === undefined`. Inherits doc default.
- `Fade` — `scene_fade === true`. Force fade, even if doc default is off.
- `Cut` — `scene_fade === false`. Force cut, even if doc default is on.

## Observability (rule 14)

- `[scene-fade resolved]` in `YouTubeVideo` SceneRouter (frame 0, per shot).
- `[ui scene-fade] doc default` on doc-level toggle.
- `[ui scene-fade] row override` on per-row pill click.
- Existing `[thumbnail-zoom] mounted` log already includes
  `transition.kind` — `'none'` will show up there too without changes.

## Security / safety (rule 13)

Three new optional persisted fields, all booleans or fixed-enum strings.
- Render-side: every read goes through a null-coalesce to a safe default.
- No user-provided strings rendered as HTML.
- No new network calls or third-party deps.

## Cost (rule 8)

Zero. Pure client/render code.

## Settings audit (rule 15)

The doc-level scene-fade default IS the settings surface for this feature
(per-doc, not per-workspace). Future workspace-level default could be added
to the existing Settings page, but punted — most users won't want a
workspace-wide opinion about transitions yet.

## QA (rule 6)

Golden path:
1. Open a production doc with several rows + a thumbnail. Toggle the
   doc-level pill from "On" to "Off". Reload the Remotion preview. Confirm
   no fade-from-black on first frame, no fade-to-black on last frame,
   hard cuts between every shot.
2. Toggle back to "On". Confirm fades return.
3. Open a row's per-row pill, set it to "Cut" while doc default is "Fade".
   Confirm that one row hard-cuts and the rest still fade.
4. Open the thumbnail-zoom Transition dialog, pick "None". Confirm the
   thumbnail-zoom scene shows the target region immediately on its first
   frame with no zoom motion.

Edge cases:
- Doc with no thumbnail: pill should still render and toggle correctly.
- Doc with a thumbnail but no zoomed rows: pill works; "None" kind in the
  dialog is harmless (no zoom rows to apply to).
- Legacy doc with no `scene_fade_enabled` field saved: behaves as today
  (faded).
- Per-row `scene_fade === false` on a thumbnail-zoom row: the
  ThumbnailZoomScene's `intro` 4-frame fade also turns off. Should look
  like a clean hard cut into the zoom.

Regression risk:
- Every scene component is touched. Manual smoke: render a 4-row doc and
  confirm each scene type still mounts and finishes cleanly with the
  default (`fadeEnabled === true`) behaviour identical to today.

## Files touched

- `src/remotion/types.ts`
- `src/remotion/utils.ts`
- `src/remotion/compositions/YouTubeVideo.tsx`
- `src/remotion/scenes/{BRoll,TitleCard,TextReveal,Icon,ScreenMockup,Outro,ThumbnailZoom}Scene.tsx`
- `src/components/production-doc/TransitionDialog.tsx`
- `src/components/production-doc/SectionRowControls.tsx`
- `src/app/(app)/production-doc/page.tsx`
