# Plan: Fix render-config drop, add region-zoom padding, add region-JSON import

**Date:** 2026-05-20
**Branch target:** `phase-1-foundation`
**Author:** Claude (Opus 4.7), aligning with user

## Goal

Three connected issues the user reported on the production-doc → render
pipeline:

1. **Render bug.** The MP4 produced by "Render to MP4 → Download MP4
   (green)" is missing voiceover audio, missing per-scene motion (B-roll
   clips and/or Ken Burns), and shows lower-third / on-screen text
   even when the "Hide on-screen text overlay" toggle is ON.

2. **Region zoom too tight.** When a row uses `thumbnail_zoom_to` to
   focus on a region, the camera math zooms hard onto the region with
   no padding. User wants a per-row "Region padding" slider with a
   doc-level default.

3. **Region JSON has no inbound path.** The thumbnails page can
   *export* `result.regions` as JSON (today via "Copy regions JSON" —
   clipboard-only, not a file download). There is no UI to *import*
   that JSON into a production doc or the editor's section-thumbnail
   panel. The only inbound paths today are (a) auto-detect via vision
   model and (b) hand-drawing in the region editor.

## Why this matters

The render bug breaks the artifact users actually publish — the toggle
UI promises behaviour the renderer doesn't deliver, which means every
"Download MP4" today either silently ignores user choices or omits the
audio that makes the video usable. That's a trust-breaking class of
bug. The zoom-padding and region-import issues are also blocking the
section-divider workflow: users build a composite thumbnail in the
Thumbnails page, generate clean regions there, then have no path to
move them into the doc that consumes them. They can hand-redraw, but
that defeats the purpose of the deterministic format generators.

## Constraints from the user

- Render path is the green "Render to MP4 → Download MP4" button (not
  the in-player record button).
- Zoom control: **per-row "Region padding" slider** with a doc default
  (chosen over presets and per-region-target).
- JSON upload UI: **production-doc thumbnail card**, **inside the
  region editor modal**, and **editor section-thumbnail control**
  (parity with production-doc).
- Render must keep working with all current toggles: voiceover,
  animate-scenes, scene-fade, hide-on-screen-text, brand kit, overlays,
  alignment.

## Honest framing on the render bug

I cannot tell you the root cause of the render bug from reading the
code alone. The pipeline traces I followed (production-doc page →
`productionDocToVideoConfig` → `/api/render/video` →
`absolutizeMediaUrls` → `realignVideoConfig` → Remotion `renderMedia`
→ R2 upload → presigned download URL) all look correct on paper:

- `voiceoverUrl` flows through both `productionDocToVideoConfig` and
  `absolutizeMediaUrls`; `<Audio src={config.voiceoverUrl} ... />` in
  `YouTubeVideo.tsx` does mount when the URL is truthy.
- `animateScenes` does gate `rowVideoClips` in
  `productionDocToVideoConfig`; stills without clips still get Ken
  Burns inside `BRollScene`.
- `suppressLowerThirds` IS passed only to `BRollScene` and
  `ScreenMockupScene`. `TitleCardScene`, `TextRevealScene`,
  `IconScene`, and `OutroScene` ignore it — but those scenes are
  text-driven by design, so it's not obvious that's the user's bug.

The user reports three concrete missing behaviours. Each could come
from a different drop point: state-not-yet-committed (refs vs closure),
URL not making it to Remotion's fetch, scene-router branch picking the
wrong scene type, or something specific to this user's environment
(stale build, browser cache, voiceover library state).

**I will not blind-fix this.** The plan is: add forensic logging that
captures the exact `VideoConfig` Remotion saw, persist it on the
`render_jobs` row, and expose it to the client so we can diff
"intended" vs "rendered." Then fix the real gap.

## Approach

### Phase A — Render diagnostics (no behaviour change, just visibility)

A.1. **Persist the rendered config on the job row.** Add
`render_jobs.input_config_json TEXT` (idempotent ALTER + a migration).
Persist a *redacted, summarized* shape, not the whole config:
  - `voiceoverUrl: present|absent|origin`
  - per-shot: `i`, `sceneType`, `hasImageUrl`, `hasVideoUrl`,
    `hasOnScreenText`, `sectionTitleLayout`, `transitionInId`,
    `sceneFade`, `videoDurationSeconds`
  - top-level flags: `suppressLowerThirds`, `sceneFadeEnabled`,
    `animateScenesResolved` (derived from per-shot videoUrls), `fps`,
    `width`, `height`, `shotCount`
  - `alignmentTelemetry` (already computed)
- Write happens inside `startRender` / `startLambdaRender` after the
  effective config is finalised (post-absolutize, post-realign).

A.2. **Return the summary in the GET status response.** Add
`config_summary` to the `/api/render/video?renderId=…` response. The
production-doc page renders a small `<details>` block next to the
Download MP4 button: "Render config (shotN: img/vid/ost · …)". Lazy
to read at a glance, expandable.

A.3. **Client-side log capture.** The existing `[render config built]`
log already prints per-row presence. Mirror that log to a buffered
in-memory client array and ship it with the POST body as
`clientDiagnostics: { renderConfigBuilt: { … }, lockMapSize, … }`.
Server logs alongside.

A.4. **User action:** With the diagnostics live, the user runs ONE
render of the failing project. They share the `config_summary`. We
then read it and identify the exact dropped fields. *This phase ships
visibility before we ship a fix.*

### Phase B — Render fix (post-diagnostic, scope sized after Phase A)

Likely fix lanes (concrete change scoped in B once we see the
telemetry):

- **B-voiceover.** If `voiceoverUrl: absent` in the summary, the bug
  is in the production-doc page state — the URL never made it into
  `productionDocToVideoConfig`. Trace `voiceoverUrl` state, the
  `useProject` payload hydration, and the autosave/restore cycle. Fix
  at the source (probably a restore path that didn't re-hydrate
  `voiceoverUrl` from the canonical payload).
- **B-motion.** If `hasVideoUrl: false` across all rows AND
  `animateScenesResolved: false`, the toggle isn't sticking. Fix the
  state plumbing (refs vs closure). If `hasVideoUrl: false` but the
  user has generated clips, the `rowVideoClips` ref isn't populated
  at render time — fix the read.
- **B-text-overlay.** If `suppressLowerThirds: true` but the lower-third
  still appears, the affected scene must be one of {TitleCard,
  TextReveal, Icon, Outro}. Decide whether `suppressLowerThirds`
  should suppress those scenes' on-screen text too (probably yes,
  since the toggle's label says "skip the lower-third band — only the
  image's baked text appears"). Thread the flag into the remaining
  scenes and have them skip their text block when on.

Phase B has its own follow-up sub-plan once Phase A data lands.

### Phase C — Region-zoom padding (independent of render bug)

C.1. **Data model.** Add two fields:
  - `ProductionDocRow.region_zoom_padding_pct?: number` (per-row)
  - `ProductionDoc.region_zoom_padding_default_pct?: number` (doc
    default)
  Bounds: `[0, 50]` (percent of the region's longest edge added on each
  side). Default at `15` so existing renders zoom out slightly — matches
  the "still focused, but breathing room" the user described.

C.2. **Math change** in
  `src/remotion/scenes/ThumbnailZoomScene.tsx`'s `regionFraming`:
  - Inflate the region by `paddingPct` on each side before computing
    scale: `rw' = rw + 2 * paddingPx`, `rh' = rh + 2 * paddingPx`,
    where `paddingPx = max(rw, rh) * paddingPct/100`.
  - Then `scale = min(cW/rw', cH/rh')`.
  - Focus stays at the original region center (no shift), clamped to
    image bounds as today.
  - At `paddingPct = 0` the math is identical to today — backwards
    compatible.

C.3. **Resolve order** in
  `productionDocToVideoConfig`:
  `row.region_zoom_padding_pct` → `doc.region_zoom_padding_default_pct`
  → `15` (the new default). Pass through to the shot as
  `shot.regionZoomPaddingPct`. `ThumbnailZoomScene` reads from the
  shot.

C.4. **UI (per row).** In `SectionRowControls.tsx` (the row's
  Zoom-to dropdown's neighbour), add an inline slider that appears
  *only* when `thumbnail_zoom_to` is set. Label: "Padding". Range
  0–50%. Live updates the preview if the player is mounted.
  Tooltip: "How much breathing room around the region. Higher = camera
  pulls back further."

C.5. **UI (doc default).** In the existing settings panel (where
  scene-fade and animate-scenes live), a "Region zoom padding (default)"
  slider with the same range. Persists on the doc.

C.6. **Persistence.** Mirror through `payload.ts` and the autosave
  write path so the field round-trips through the canonical payload.
  Migration: not needed — JSON column, nullable field.

### Phase D — Region JSON import

D.1. **Shape.** Accept the same shape `result.regions` exports today:
  `Array<{ id, label, x, y, w, h }>`. Validate strict — reject if
  any region is out of bounds for the target image, or if the array
  is empty / over 50 entries.

D.2. **Three entry points** (each opens the same
  `RegionJsonImportDialog` component):

  a. **Production-doc thumbnail card**
     ([SectionThumbnailCard.tsx](src/components/production-doc/SectionThumbnailCard.tsx)).
     Next to "Edit regions" — a button labelled "Paste JSON".
  b. **Region editor modal**
     ([ThumbnailRegionEditor.tsx](src/components/production-doc/ThumbnailRegionEditor.tsx))
     header. Next to "✨ Auto-detect regions" — a button labelled
     "Paste JSON". On import: pushes current regions onto undo stack
     (so Ctrl-Z reverts), then replaces them.
  c. **Editor section-thumbnail control**
     (Batch B's `section thumbnail + regions` UI in the editor —
     find the matching component in
     [src/components/editor/](src/components/editor/)). Same affordance.

D.3. **Dialog UX.** Single-screen modal with a textarea pre-focused.
  Pasted content is validated on every keystroke (visible inline
  errors). "Import" button disabled until valid. Confirmation needed
  when overwriting existing regions ("Replace N existing regions with
  M imported regions?").

D.4. **Bonus: "Copy regions JSON" → "Copy or Download JSON".** Small
  UX upgrade in [TopicCardGridPanel.tsx](src/components/thumbnails/TopicCardGridPanel.tsx)
  and [NLevelsPanel.tsx](src/components/thumbnails/NLevelsPanel.tsx)
  so the JSON can also be saved to disk. *Deferred — not required by
  the user, but trivial; pull in only if it's a clean drive-by.*

### Phase E — QA

E.1. Render diagnostics: render one project, confirm the
  `config_summary` echoes back what the toggles said.
E.2. Zoom padding: a row with `thumbnail_zoom_to` set to a small
  region, slider at 0 → identical framing to before; slider at 50% →
  camera pulls back far enough to show the region with ~50% padding.
E.3. Region import: paste the JSON output from
  TopicCardGridPanel directly into the production-doc dialog; regions
  appear, can be edited, persist through save.
E.4. Edge cases:
  - Paste empty array → error toast, no clobber.
  - Paste regions out of bounds → error toast naming the bad region.
  - Paste with duplicate IDs → regenerate IDs server-side, warn user.
  - Paste while the editor has unsaved draft regions → confirm
    overwrite.

## Alternatives rejected

- **"Just fix the render based on best guesses."** Considered and
  rejected. The pipeline has multiple plausible drop points and a
  blind fix risks introducing regressions while leaving the real bug
  unfixed. Diagnostics first, fix second.
- **Region zoom: fixed Tight/Medium/Loose presets.** User picked
  slider. Presets would be 30 minutes faster to ship but less precise.
- **Region zoom: per-region preferred zoom.** Rejected per user. The
  zoom shape is a *row*-level decision in the storytelling, not a
  region-level property.

## Security + safety

- The render `config_summary` will deliberately NOT include the
  voiceoverUrl secret query strings, presigned signatures, or any
  PII. Only presence/absence and origin host (not full path).
- Region JSON import is parsed with strict JSON + JSON-schema
  validation (label length, coord bounds). No `eval`. The pasted
  string never touches `dangerouslySetInnerHTML`.
- The `region_zoom_padding_pct` is clamped server-side and
  client-side to `[0, 50]` so a malformed payload can't produce an
  infinite/NaN scale that crashes Remotion.

## Observability

- `[render config built]` log already exists client-side — extended
  to push to a buffered diagnostics array shipped to the server.
- `[render]` server logs already cover `alignment outcome` and per-job
  errors; add `[render config persisted]` after the new
  `input_config_json` write.
- `[thumbnail-zoom] mounted` log already exists; extend with
  `paddingPct` and the inflated `rw'`/`rh'` so a zoom regression is
  diagnosable from the console.
- `[regions import]` logs: pasted-bytes-length, parsed-region-count,
  validation-result, final-action (replace/cancel/error).

## Settings audit

Per rule 15:

- New per-row control: **Region padding slider** in row's section-
  thumbnail controls. Visible only when a zoom target is set.
- New doc-level default: **Region zoom padding (default)** in the doc
  settings panel, near the existing scene-fade / animate-scenes
  toggles.
- New action button: **Paste regions JSON** in three places (see D.2).
- Not surfaced as a setting: the diagnostic verbosity. It's always on
  and lightweight; no knob.

## Cost implications

None. No new third-party services. The render path is unchanged
financially. Diagnostics live entirely in the existing Postgres
`render_jobs` row.

## Plan dependencies / sequencing

- Phase A is independent — ships first, takes ~30 min.
- Phase C and D are independent of A/B and of each other — can ship
  in parallel.
- Phase B is BLOCKED on Phase A telemetry coming back from the user.

## Open questions for the user

1. Is the Phase A diagnostic-first approach OK, or do you want me to
   take a best-guess swing at Phase B blind?
2. Default region-zoom padding — `15%` reasonable, or should I land
   it at `0%` (no behaviour change) and let users opt in?
3. Should the imported region JSON OVERWRITE existing regions by
   default, or APPEND with renamed labels?
