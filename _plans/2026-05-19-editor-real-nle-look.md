# 2026-05-19 — Editor: make it look and feel like a real NLE

## Why this plan exists

The owner saw the editor on 2026-05-19 and said, verbatim: *"this is how
the editor should look like? If so it's very bad… make it feel like a
real editor, make the timeline extremely more robust, make the buttons
and options and feature look like in a real editor like capcut or veed,
UI ux and beautiful, This is crucial, The current one is ugly, messy
and unclear!"*

The previous parity refactor (`2026-05-19-editor-production-doc-parity.md`)
fixed the data round-trip — every asset the production doc generates now
flows into the editor's preview correctly. Functionally, the editor
works. Visually, it doesn't. It's a tight toolbar of plain buttons, a
black player, a single timeline row of text-only tiles, and a status
bar at the bottom. Nothing about the chrome whispers "professional
editing tool."

This plan upgrades the editor's *presentation* to feel like CapCut
Web — without rewriting the underlying shot-graph data model that's
the actual product differentiator. The shot-graph stays; the surface
on top of it becomes a real NLE-looking interface.

## Goals

1. **Look like CapCut Web at first glance.** A non-technical user
   opening `/edit/[projectId]` should feel "this is a real editor"
   inside three seconds.
2. **Multi-lane timeline** with video / audio (waveform) / captions /
   overlays as separate visual tracks, all synced to the same
   underlying shot-graph payload.
3. **Polished IA**: top menu strip, collapsible left sidebar (media /
   audio / effects / AI tools), center preview, right contextual
   inspector, bottom timeline + transport.
4. **Cooler, denser dark theme** tuned for editing work — same purple
   accent the rest of the app uses, but with the contrast / panel
   borders / typography density that pro tools use.
5. **No new dependencies.** Everything builds on Radix UI primitives,
   `lucide-react`, `wavesurfer.js`, and `framer-motion`, all already
   installed.

## Non-goals (explicit)

The owner picked direction B (hybrid). Direction C (full NLE rewrite —
arbitrary clip placement, keyframes, ripple/roll/slip, real multi-track
arrangement) was rejected for two reasons: (1) the shot-graph data
model is the differentiator, (2) the build is 6-8 weeks and competes
against CapCut on every axis we'd lose. These features are explicitly
out of scope:

- Arbitrary clip placement on the timeline (the timeline still
  represents the shot sequence; clips can't be dragged off their
  shot's tile).
- Keyframe animation of any property.
- Per-shot color grading, LUTs, filters, speed ramps.
- WebAudio-level audio editing (ducking, gain automation, volume
  keyframes). Waveform is render-only.
- Frame-accurate scrubbing inside a clip. Scrub is shot-level, same
  rule the earlier shot-graph plan locked in.
- Mobile / responsive layouts. Desktop ≥ 1280 px only.
- Real-time collab. Last-write-wins stays.
- A media bin for arbitrary external file imports. The "media"
  sidebar shows the project's own generated assets only.
- Replacing the production-doc page. It stays as the AI generation
  surface; the editor is the visual editing surface.

## Constraints

- Preserve the canonical `ProjectPayload` from the parity refactor.
  Every visual change reads from / writes to it; no new persistence.
- Preserve the editor store's command/undo/redo architecture. Every
  new visual control flows through `apply({ type: '…' })`.
- Preserve the existing keyboard shortcuts (B / Delete / Shift+Delete /
  M / Cmd+Z / Cmd+S / +/-). Add more, never break these.
- Preserve the Remotion player as the preview engine. We're not
  rebuilding playback.
- Preserve the workspace's purple-accent dark theme. Tune the
  contrast / borders / typography, don't replace the palette.
- Editor must continue to render on a brand-new project that has no
  assets yet (empty-state UX is a real surface, not an after-thought).
- No new runtime dependencies. Use what's already in `package.json`.

## Reference: CapCut Web

We're anchoring the visual language to CapCut Web (`web.capcut.com`).
Things we're explicitly borrowing:

- **Layout proportions.** Tight top header (~48 px), left vertical
  icon rail (~64 px) collapsible to a wider drawer, center preview
  with letterboxed video, right inspector (~320 px), bottom timeline
  region (~280 px including transport).
- **Timeline density.** Tracks are ~48 px tall, separated by 2-3 px
  gaps, with a ruler at the top showing time. Playhead is a vertical
  yellow line spanning every track.
- **Transport controls.** Centered under the preview: skip-back /
  play-pause / skip-forward / playback rate / time readout, in that
  order, with full-width keyboard hints on hover.
- **Inspector tabs.** Right panel switches based on selection: Shot
  tab when a tile is selected, Audio tab when the audio track is
  selected, Captions tab when a caption segment is selected.
- **Icon-forward.** Every action gets a `lucide-react` icon with the
  label as a tooltip; the toolbar uses icons-with-labels, not full
  text buttons.

Things we're NOT borrowing (because they'd require breaking the
shot-graph model):
- Arbitrary clip dragging across the timeline. Tiles stay
  shot-locked.
- Multi-clip-per-row arrangements. One shot per slot.
- Effects / transitions library beyond the single cross-fade we
  already support.

## Information architecture (the actual layout)

```
┌──────────────────────────────────────────────────────────────────────┐
│  [logo]  Title · 7:59 · v1                Save · Export · Help · ←   │   48px header
├──────┬────────────────────────────────────────────┬──────────────────┤
│      │                                            │                  │
│  M   │                                            │   Inspector      │
│  A   │           ┌─────────────────────┐          │   ──────────     │
│  ★   │           │                     │          │   (contextual,   │
│  C   │           │   Remotion player   │          │   320px wide,    │
│  T   │           │                     │          │   tabs: Shot /   │   center grows
│  ✨  │           │                     │          │   Audio / Caps   │
│  ⚙   │           └─────────────────────┘          │   / Doc)         │
│      │   ⏮  ▶  ⏭   1×   0:42 / 7:59       ⛶     │                  │
│      │                                            │                  │
├──────┴────────────────────────────────────────────┴──────────────────┤
│  ─── time ruler ────────────────────────────────────────────────────│
│  ▶ video    ┌───┐┌───────┐┌─────┐┌──────┐                            │
│             │ 1 ││   2   ││  3  ││  4   │  ← thumbnails fill tiles  │   ~280px
│  ▶ audio    ░▒▓▒░░▒▓▒░░▒▓▒░░▒▓▒░░▒▓▒░░▒▓▒░  ← waveform              │
│  ▶ captions │ Morris Worm │  10% │ 60k machines │ BACKFIRED          │
│  ▶ overlays              ┌──┐         ┌──┐                            │
│                          │ ❒│         │ ❒│  ← overlay markers       │
└──────────────────────────────────────────────────────────────────────┘
```

Pieces, top to bottom:

### 1. Top header (~48 px)

- Project icon + title (editable inline on click, commits on blur).
- Shot count · duration · version.
- Right side: Save status pill (auto from `saveStatus`), Export
  dropdown (.otio, MP4 render — the existing flows), Help (`?`),
  ← Production Doc.
- No flag toggles or asset action buttons here — those move to the
  left rail / inspector.

### 2. Left rail / drawer (collapsible)

Vertical icon-only rail by default (~64 px wide), expands to a
~240 px drawer when an icon is clicked. Icons:

- **Shots** (default open): list of all shots with thumbnail +
  script preview. Click jumps to that shot.
- **Media**: project's generated images, B-roll clips, voiceover
  files. Drag onto a shot tile to assign (Phase 5+; for the first
  cut, click-to-replace).
- **Audio**: voiceover picker, music picker, alignment status.
- **Captions**: caption track summary, regen button, settings.
- **AI Tools**: Regen VO, Regen doc, Drift report, Generate
  captions — the existing AI affordances, grouped together with
  proper icons and descriptions.
- **Settings (per-project)**: animateScenes toggle, suppressLowerThirds
  toggle, brand kit override, overlays disabled — these all move out
  of the top toolbar into a contextual settings tab.

### 3. Center preview

- Full-bleed Remotion player with letterboxing on the dark canvas.
- Below the player: a transport bar with skip-back, play/pause,
  skip-forward, playback-rate dropdown (0.5x / 1x / 1.5x / 2x), live
  time readout, and a fullscreen button. Centered, icon-only,
  high-contrast.
- Above the player on hover: a thin shot-position breadcrumb showing
  "Shot 3 of 81" and the current shot's script preview, so the user
  always knows what's on screen.

### 4. Right inspector (~320 px)

Tabbed panel. The tab is auto-selected based on what's selected on
the timeline:

- **Shot tab** (default): every field the current ShotInspector
  surfaces (script, visual_description, AI image prompt, on-screen
  text, section title, image + regen + replace, clip + generate +
  pick, overlay controls). Re-skinned with proper section dividers,
  collapsible groups, and consistent typography.
- **Audio tab**: voiceover URL, alignment status, mute master,
  music URL. Active when the audio lane is selected.
- **Captions tab**: caption count, language indicator, regen +
  re-time + per-segment edit affordances.
- **Doc tab**: doc-level fields (title, total duration readout,
  flags toggles, brand kit override, music). Always available via
  a small "≡" button at the inspector header.

### 5. Bottom timeline region (~280 px)

The big visible change. Four tracks stacked vertically, all driven
by the same shot-graph payload:

- **Time ruler** at the top with minute / second labels and a
  draggable playhead.
- **Video lane**: shot tiles with full-bleed thumbnails (filling
  each tile), title overlay at the bottom, transitions visualized
  as small overlapping wedges between tiles, drag the trailing
  edge to resize (existing), drag the top handle to reorder
  (existing).
- **Audio lane**: a single continuous waveform across the timeline,
  rendered via `wavesurfer.js` against the voiceover URL. Clickable
  to seek the playhead. Mute toggle on the lane header.
- **Captions lane**: caption segments as little rounded pills, each
  showing the first 30 chars. Click selects the segment and opens
  the Captions tab in the inspector.
- **Overlays lane**: row overlays as small marker icons on the
  shots that carry them. Click jumps to the overlay position editor.

Transport-style zoom buttons + zoom slider on the right side of the
timeline header (`-`, slider, `+`, "Fit to screen").

All four lanes share the same horizontal scroll AND the same playhead
position. When the player advances, the playhead glides across all
four tracks in sync.

## Theme tuning

The current theme is functional but flat. Specific changes:

- **Backgrounds**: `--bg` stays the same hue, drop the lightness by
  ~3% for the editor's full-bleed canvas so the preview frame pops
  more.
- **Panel borders**: 1 px borders at ~6% white alpha (currently ~10%)
  for less visual noise; replace borders with subtle inset shadows
  where two panels meet.
- **Typography**: tighten line-heights on panel content (was 1.5,
  →1.35), bump the editor's body font weight from 400 to 450 so the
  density feels intentional, not cramped.
- **Accent**: keep the purple (#a78bfa) but reserve it for the
  active states (selected tile, playing transport icon, active tab).
  Reduce its use in muted decorative places to make the active
  highlight more meaningful.
- **Icons**: switch from emoji (🎬 / ⤓ / ↶ / ↷ / ✨ — the current
  set in the toolbar) to `lucide-react` icons throughout. Pixel-
  consistent, scales correctly, dark-theme-friendly.

A single CSS file `src/app/(app)/edit/[projectId]/editor-theme.css`
holds the editor-only overrides so the app-wide theme stays untouched.

## Components (new)

These are the new React components the plan introduces. Each lives
in `src/components/editor/` unless otherwise noted.

- `EditorChrome.tsx` — the top-level layout shell. Owns the grid
  template that places header / left-rail / preview / inspector /
  timeline. Replaces the current `EditorClient.tsx` render tree
  (the data-layer logic stays; only the render tree moves).
- `EditorHeader.tsx` — top 48 px bar.
- `EditorLeftRail.tsx` — vertical icon rail + drawer. Tabs: Shots /
  Media / Audio / Captions / AI Tools / Settings.
- `EditorPreviewFrame.tsx` — Remotion player wrapper + transport
  bar. The transport bar is its own subcomponent.
- `TransportBar.tsx` — skip / play / pause / rate / time / fullscreen.
- `EditorInspector.tsx` — tabbed inspector shell. Tabs: Shot / Audio
  / Captions / Doc.
- `TimelineV2.tsx` — the new multi-lane timeline. Composes:
  - `TimelineRuler.tsx`
  - `TimelinePlayhead.tsx`
  - `VideoLane.tsx` (the existing Timeline's tile logic, re-skinned)
  - `AudioLane.tsx` (new — wavesurfer integration)
  - `CaptionsLane.tsx`
  - `OverlaysLane.tsx`
  - `TimelineZoomControls.tsx`

The existing components (`Timeline.tsx`, `ShotInspector.tsx`,
`StatusBar.tsx`, `EditorClient.tsx`) are not deleted — they're either
re-wrapped (ShotInspector becomes the body of EditorInspector's Shot
tab) or retired with redirects. Nothing breaks during the rollout.

## Phases

### Phase 1 — Theme + chrome shell (2 days)

1. Add `editor-theme.css` with the cooler/denser dark-theme tweaks.
2. Build `EditorChrome.tsx` with empty regions — just the grid layout
   and the panel chrome. No content moved yet.
3. Wire the existing player + timeline + inspector into the new
   regions so the page renders end-to-end with the new shell.
4. Smoke-test: nothing breaks; the editor renders, edits still work.

### Phase 2 — Header + transport bar (1-2 days)

1. Build `EditorHeader.tsx` with the new title block, save badge,
   export menu, help icon, back link.
2. Build `TransportBar.tsx` with skip / play / pause / rate / time
   / fullscreen. Wire to the Remotion `PlayerRef`.
3. Replace the in-page top toolbar with these components. The flag
   toggles, undo/redo, save button move to header / inspector.

### Phase 3 — Left rail + drawer (2-3 days)

1. `EditorLeftRail.tsx` with the six tabs.
2. **Shots tab**: list of shots with thumbnails + script preview.
3. **Media tab**: project's generated images + clips + voiceover.
4. **Audio tab**: voiceover picker pulled in from production-doc's
   existing `VoiceoverPicker` component.
5. **Captions tab**: caption count, regen button.
6. **AI Tools tab**: the existing Drift report, Regen VO, Regen doc,
   Generate captions affordances regrouped here with icons.
7. **Settings tab**: animateScenes, suppressLowerThirds, brand kit,
   overlays-disabled toggles — moved out of the top toolbar.

### Phase 4 — Tabbed inspector (2 days)

1. `EditorInspector.tsx` shell with tabs Shot / Audio / Captions /
   Doc, auto-switching on selection.
2. Shot tab: the existing `ShotInspector` body, re-skinned with
   proper section dividers and Radix UI accordion for collapsible
   groups.
3. Audio + Captions + Doc tabs: simple panels surfacing the relevant
   fields. No new capabilities; these are just nicer homes for
   existing controls.

### Phase 5 — Multi-lane timeline (3-4 days, the biggest visual win)

1. `TimelineV2.tsx` skeleton with the four-lane grid layout, shared
   horizontal scroll, shared playhead.
2. `TimelineRuler.tsx` — drag-to-seek time ruler.
3. `VideoLane.tsx` — port the existing Timeline tile logic. Now
   tiles use full-bleed thumbnails (image fills the tile, label
   floats over a gradient at the bottom).
4. `AudioLane.tsx` — wavesurfer.js integration. Render the voiceover
   waveform across the full timeline width, sync the playhead.
   Click-to-seek.
5. `CaptionsLane.tsx` — caption pills positioned by segment timing.
6. `OverlaysLane.tsx` — overlay markers on rows that carry them.
7. `TimelineZoomControls.tsx` — zoom slider + fit-to-screen button.

### Phase 6 — Icons + polish (1-2 days)

1. Replace every emoji in the editor surface with the matching
   `lucide-react` icon.
2. Tooltips on every icon button (Radix UI `<Tooltip>`).
3. Loading skeletons in every panel for the brief moment before
   data arrives.
4. Final visual pass: hover states, focus rings, motion (use
   `framer-motion` for tab transitions and the playhead glide).

### Phase 7 — QA + observability (1 day)

1. Manual QA matrix (see below).
2. New observability log lines for the new components:
   `[editor transport]`, `[editor timeline-v2]`, `[editor inspector
   tab]`. Same `[…]` namespacing rule as the rest of the codebase.
3. Settings audit: anything in the new UI that has a configurable
   choice (timeline lane heights, default tab, autoplay-on-load)
   gets exposed via `src/lib/editor/settings.ts`.

Total: ~12-15 working days. About 2.5-3 weeks calendar time
including the natural reviews between phases.

## Security & safety (rule 13)

Nothing in this plan changes the auth model, the API endpoints, the
data validation, or the URL allowlist. The persist layer + payload
validator from the parity refactor keep enforcing scope. The new UI
is presentational only. Specific notes:

- **No new endpoints.** Every action the new UI fires hits an
  endpoint the editor already calls today.
- **Wavesurfer security**: wavesurfer.js fetches audio via the
  browser's standard `fetch`; same-origin enforcement applies. We
  feed it the voiceover URL straight from the payload, which the
  `validatePayload` route boundary already gates.
- **CSP**: no inline scripts added; styles all in CSS modules /
  Tailwind. The existing CSP stays intact.
- **XSS surface**: every user-supplied string (titles, script text,
  captions) renders via React's default escaping. No `dangerouslySet
  InnerHTML`. The new components inherit React's default safety.
- **Cost guard**: clip generation and VO regen are the only paid
  actions surfaced in the new UI. Both keep their existing
  confirmation flows (no skipping the "you're about to spend $X"
  step).

## Observability (rule 14)

New log lines, in addition to the `[project payload …]` /
`[editor …]` namespaces already in place:

- `[editor chrome] mount { projectId, layoutDims }` — once per page
  load.
- `[editor transport] play / pause / seek { playheadMs, source }` —
  source is `'transport-button' | 'timeline-click' | 'keyboard'`.
- `[editor timeline-v2] zoom { level, pxPerSecond }` — on every zoom
  change.
- `[editor timeline-v2] lane click { lane, position }` — on every
  click in a lane.
- `[editor inspector tab] switch { from, to, trigger }` — trigger
  is `'selection' | 'manual'`.
- `[editor waveform] ready { sourceUrl, durationMs }` /
  `[editor waveform] error { detail }`.

Every namespaced log has its real diagnostic values, not just
"X happened" — per rule 14.

## Settings audit (rule 15)

Three new editor settings get exposed in the existing 🎬 Editor
settings panel:

- `editor.layout.leftRailDefaultTab` — Shots / Media / Audio /
  Captions / AI Tools / Settings. Default: Shots.
- `editor.timeline.laneHeights.video` — int 32..96. Default 64.
- `editor.timeline.laneHeights.audio` — int 32..96. Default 56.
- `editor.transport.defaultPlaybackRate` — 0.5 / 1 / 1.5 / 2.
  Default 1.
- `editor.preview.fitMode` — `'contain' | 'fill'`. Default `contain`.

All in `src/lib/editor/settings.ts` next to the existing four keys.
Unit tests follow the same shape as the existing
`tests/editor-settings.test.ts`.

## Risks (honest)

- **Wavesurfer integration.** The waveform needs to align with the
  timeline pixel-per-second exactly. We've never had a custom-
  positioned wavesurfer before; the first attempt may visually
  drift against the video tiles by a few px. Mitigation: build the
  audio lane against a known-good fixture in isolation before
  wiring into the live timeline.
- **Refactor scope.** Moving the current toolbar into header /
  inspector / settings tabs is a lot of small surgical changes. The
  risk is that an existing keyboard shortcut or affordance gets
  dropped silently. Mitigation: Phase 7's QA matrix has a row for
  every existing shortcut and toolbar button, verified after each
  phase, not just at the end.
- **Performance.** Four lanes × N tiles × full-bleed thumbnails is
  more rendering work than today's single row of text tiles. On a
  100-shot project the timeline could feel sluggish. Mitigation:
  virtualize the lanes (only render tiles inside the visible
  viewport), measured during Phase 5.
- **The shot-graph model showing through.** Some users may try to
  drag a clip off its shot tile and be surprised they can't. We
  surface the constraint in the empty-state copy and the inspector
  copy ("This shot's animation"), but it's a known asymmetry vs
  CapCut.

## What "done" looks like

- A non-technical user opening `/edit/[projectId]` says "this looks
  like a real editor" within three seconds.
- The four lanes render and stay in sync as the playhead glides.
- Every existing editor capability (save, undo, redo, split, delete,
  mute, image upload, clip pick, clip generate, overlay edit,
  drift report, regen VO, regen doc, regen captions, export .otio,
  flag toggles) still works. Nothing was dropped during the
  re-skin.
- The bottom is a multi-lane timeline + zoom controls, not a status
  strip. The status info that used to live there migrates to the
  header save badge + the empty-state messaging.
- The five new settings are wired and tested.
- All new observability logs fire in a smoke run with real values.

## Open questions — resolved 2026-05-19

- **Does the project's voiceover work with wavesurfer's default
  loader?** STILL OPEN. Proxy paths (`/api/voiceovers/{id}/audio`)
  should work; ElevenLabs-direct URLs may CORS-fail. Verified by
  hand-fetching during Phase 5; if CORS bites, we proxy through our
  own route.
- **Left rail default state?** → **Collapsed to icons.** User clicks
  an icon to expand the drawer.
- **Doc-level project flags surface?** → **Kebab `⋮` menu in the
  inspector header.** Inspector tabs stay Shot / Audio / Captions
  only; project-level settings open from the kebab.
- **Caption editing inline?** → **Inline edit in the captions lane.**
  Double-click a caption pill opens an inline editor; commits on
  blur or Enter. Phase 5 ships with this enabled.
- **Empty-state UX?** → **Centered card overlay on the player area**
  with "This project hasn't been generated yet — Open in Production
  Doc →" CTA. Same card pattern for projects that have a doc but no
  assets ("Add a voiceover and generate scenes to start editing").
