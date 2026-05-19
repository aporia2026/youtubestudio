# 2026-05-20 — Editor ↔ Production-Doc feature parity batches

Follow-up to `_plans/2026-05-19-editor-real-nle-look.md`. The owner
asked on 2026-05-20: "I want to be able to add voiceovers from the
narrator team member in the editor. Preferably it will auto detect
which one is relevant" — and then added "also add the regions feature
from production doc / make sure again that all features from the
production doc are beautifully and comfortably implemented in this
editor."

This plan captures the catch-up work as four (eventually five)
independently-shippable batches.

## What's already shared between both pages

- Overlay system: `OverlayPositionEditor`, `OverlayEditDialog`,
  `OverlayContextMenu` — editor imports from production-doc.
- B-roll kickoff: `kickoffBrollGeneration` from `BrollCell.tsx` — used
  by the editor's inspector Generate-animation button.
- Drift report, VO regen modal, doc regen-from-script modal — same
  component, two mount points.

## Production-doc features missing from the editor (the gap)

| Feature | Production-doc location | Status in editor | Batch |
|---|---|---|---|
| Voiceover picker w/ narrator auto-match | inline `VoiceoverPicker` in page.tsx | Audio tab is a stub | A |
| Section thumbnail (composite image) | `SectionThumbnailCard` | Not surfaced | B |
| Region drawing on thumbnail | `ThumbnailRegionEditor` | Not surfaced | B |
| Per-shot image edit (smart + brush) | `MaskBrushEditor` + inline `EditPanel` | Not surfaced (only regen-from-prompt exists) | C |
| Per-section / per-shot row controls | `SectionRowControls` (pillarbox, layout, zoom) | Inspector edits text fields only | C |
| Transition picker | `TransitionDialog` | Inspector has a toggle only | C |
| Visual brand kit override | `VisualBrandKitOverridePanel` | Renderer reads, no UI to set | D |
| Animate-all batch generator | inline in page.tsx | Only per-shot generation | D |
| Scene timing controls (min ms / tail buffer) | inline pills | Read-only via doc payload | D |
| Render to MP4 | full Lambda pipeline | Editor only exports .otio | E (later) |
| History sidebar | `HistoryPanel` | None in editor | Out of scope |
| Schedule-item linking + banner | `ScheduleLinkBanner` | None in editor | Out of scope |
| Style presets | picker at generation | N/A — set at generation | Out of scope |

## Batches

### Batch A — Voiceover picker with narrator auto-detect

**Goal**: bring the narrator-aware picker into the editor with silent
auto-detect on first load.

**Resolved open-questions (owner picked 2026-05-20)**:
- Aggressiveness: silent auto-pick when no VO set; never override an
  existing pick.
- Location: Inspector Audio tab AND Left-rail Audio tab.
- Approval flow: out of scope — picker only.

**Work**:
1. Lift `VoiceoverItem` type + `sourceLabel` + `pickBestVoiceover`
   into `src/lib/voiceovers/picker-types.ts`.
2. Lift the React `VoiceoverPicker` into
   `src/components/voiceover/VoiceoverPicker.tsx`.
3. Update production-doc to import from the shared modules — zero
   behavior change.
4. Extend `ProjectPayload` with optional `linkedProjectId` +
   `linkedScheduleItemId` so the editor has the strong match signals.
   Migrator backfills `undefined`; production-doc autosave fills them
   on every patch.
5. Wire the picker into the editor's Inspector Audio tab and
   left-rail Audio tab. Auto-detect logs `[editor voiceover]
   auto-matched { source, signal, narratorName }` on the first
   silent pick.

### Batch B — Section thumbnail + regions

**Goal**: let the editor upload a composite thumbnail and draw
labeled regions on it (the existing zoom-to-region transition).

**Work**:
1. `SectionThumbnailCard` + `ThumbnailRegionEditor` move out of the
   `production-doc/` folder into `src/components/thumbnail/` so both
   pages import from there.
2. New `PATCH_DOC` command on the editor store — needed so the
   thumbnail field (lives on `doc.thumbnail`, not on rows) can be
   mutated with undo/redo/autosave support. Also unblocks the
   Settings tab's Auto-fetch overlays toggle from Phase 3.
3. Inspector → Shot tab gets a "Region zoom" sub-section: when the
   current shot has a `thumbnailZoomTo` field, show the target
   region; let the user pick a region or clear.
4. Left rail AI Tools tab gets a "Section thumbnail" row that opens
   a modal hosting `SectionThumbnailCard` (upload, region drawing,
   stripe height control).

### Batch C — Per-shot polish

**Goal**: every per-shot control production-doc has should be
accessible from the editor's Inspector.

**Work**:
1. Port `MaskBrushEditor` into a shared module (already at
   `src/components/production-doc/`, just moves up to
   `src/components/image-edit/`) and wire the inspector image
   section to open a smart-edit dialog → mask-brush dialog flow.
   Same UX production-doc has.
2. Port `SectionRowControls` into the inspector as a "Layout"
   accordion section. Exposes per-shot `section_title_layout`,
   `pillarbox_color`, `scene_zoom`, `scene_fade`.
3. Port `TransitionDialog` as the trigger when the user clicks the
   transition toggle. Per-transition tuning (duration / curve)
   instead of a binary flag.

### Batch D — Brand kit + animate-all + scene timing

**Goal**: doc-level configuration the editor currently can't reach.

**Work**:
1. `VisualBrandKitOverridePanel` ports into a shared module; mounted
   inside the inspector kebab menu (already has the Animate /
   Lower-thirds toggles — brand kit slots in there).
2. Animate-all in the left-rail AI Tools tab: button kicks off
   B-roll generation for every shot missing a ready clip, with the
   same cost confirmation production-doc shows.
3. Scene timing controls (min ms / tail buffer) move into the
   left-rail Settings tab. Doc-level overrides via the new
   `PATCH_DOC` command from Batch B.

### Batch E — Render to MP4 (deferred, requires planning)

**Owner opted in 2026-05-20** but wants careful planning. NOT in this
plan's execution; revisit after Batches A-D land. Risk: render bugs
now happen on two surfaces. Mitigation: shared render-launcher
helper, single render-status hook, no inline pipeline logic in the
editor.

## Out of scope (won't be ported)

- History sidebar (production-doc IS the project-creation surface).
- Schedule-item linking + banner.
- Style preset picker (generation-time only).
- Auto-pipeline UI hooks.
- Google Sheets / CSV exports.

If any of these need to be in the editor too, it's a separate
conversation — they're not "editing" features in the NLE sense.

## Execution order

A → B → C → D, then talk about E. Sign-off captured in the answers
to the 2026-05-20 question block. Each batch lands in 1-2 commits
and pushes to `phase-1-foundation`. I stop after any batch that
needs owner input before continuing.
