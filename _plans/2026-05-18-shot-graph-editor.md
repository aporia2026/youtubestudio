# 2026-05-18 — Shot-graph editor on `/editor/[projectId]`

## Goal

Add an in-app visual editor where creators can fine-tune AI-generated videos
without exporting to CapCut. The editor works on the existing `VideoConfig`
shape (no migration of stored data shapes; only additive columns), shares the
project record with `/production-doc`, and treats every manual edit as
something the AI can *participate in* — not just record. The defensible moat
is that **edits propagate backward into generation**: shortening a shot can
re-pace the voiceover, replacing a shot can be a re-prompt to Veo/Sora, and
captions stay derived from the current voiceover instead of becoming a
fork-able track.

Success looks like: a creator opens an AI-generated video, makes 5–10 edits
(trim, split, mute, replace one clip), regenerates the voiceover once, and
hits Render — all without leaving the app. End-to-end under 10 minutes for a
3-minute video. They never wonder where the timeline is, what a "production
doc" is, or whether their changes saved.

This document supersedes the earlier instinct to build a CapCut clone in the
browser. The LLM Council unanimously surfaced that the *timeline as 1995 NLE
abstraction* is the wrong primitive when the input is generated; the native
unit is a **shot intent** node and edits are operations on that graph.
Multi-track WebAudio editing, ducking, waveform-level audio editing, fades
beyond linear, and frame-accurate scrubbing of source MP4s are explicitly
deferred — they are 3-month rabbit holes each, and small teams die in them.

## In scope (v1)

- New route `/editor/[projectId]` (Next 16 app router, behind a feature flag
  `EDITOR_V1_ENABLED`).
- `@remotion/player` preview pane (already installed, currently unused).
- Single-track visual editing on `VideoConfig.shots`:
  - **Resize shot duration** by dragging the trailing edge.
  - **Trim head / trim tail** — independent in-point / out-point per shot
    (new `trimStartMs` / `trimEndMs` fields on `VideoShot`).
  - **Split shot at playhead.**
  - **Delete shot** (with ripple-close default; option to leave a gap as a
    blank insert).
  - **Reorder shots** by drag.
  - **Mute shot audio** (per-shot toggle).
  - **Master mute** on voiceover and music tracks.
  - **Replace media** — swap the underlying `imageUrl` / `videoUrl`. Three
    sources: file upload to Vercel Blob, pick from this project's existing
    `broll_clips`, regenerate via Kie.ai picking any of the 6 model families.
- **Undo/redo** via command pattern (Zustand + immer or jotai with history;
  decided in Phase 1).
- **Text overlay** add/edit/delete (single layer above shots; reuses
  `LowerThird` component, extended to support per-shot position + font).
- **Auto-captions** from the existing `voiceoverUrl` via OpenAI
  `gpt-4o-mini-transcribe` (cheaper than `whisper-1`). Captions are
  **derived state**, regenerated when the voiceover changes. They are not
  a stored editable track in v1.
- **One transition type** between shots: cross-fade. Reuses
  `@remotion/transitions` (already installed).
- **AI participation** — three buttons, not a full feature:
  1. *"Re-pace voiceover to fit edits"* — calls ElevenLabs with the edited
     timeline durations to regenerate the VO at the new pacing.
  2. *"Regenerate this shot"* — re-prompts the original B-roll model with
     the shot's existing `visual_description`, optionally edited inline.
  3. *"Re-write this caption"* — calls Claude to rephrase a caption segment
     while preserving timing.
- **OTIO / EDL export** — a download button that serializes the timeline
  to OpenTimelineIO JSON. This is the *escape hatch* for users who want to
  finish in CapCut / Resolve / Premiere — and it carries the AI work
  forward (regenerated audio, captions, model attributions) instead of
  losing it. Per the council, export interop is a wedge, not a defeat.
- **Project record sharing with `/production-doc`** — both surfaces read
  and write the same `production_docs` (or equivalent) row. Single source
  of truth, optimistic updates, last-write-wins with a `version` integer
  bumped per save.
- **Telemetry** (Phase 0) — `editor_open`, `edit_applied`,
  `export_clicked`, `cap_cut_export_clicked` events to Postgres. So that
  by week 4 we have evidence on whether the editor reduces CapCut export
  intent, which is the only metric that matters.

## Out of scope (v2+)

The council's biggest contribution was a kill list. These are deliberately
deferred until v1 traction justifies the cost. Each one is at least 4–8
weeks of focused work on its own.

- **Multi-track audio editing.** No third audio track. No per-shot
  audio levels beyond mute. The single `voiceoverUrl` + single `musicUrl`
  contract from `VideoConfig` is preserved. WaveSurfer.js will render
  waveforms read-only in the audio strip; editing them is v2.
- **Volume keyframing, fades beyond linear, ducking.** All three are
  WebAudio rabbit holes with credible-quality cliffs. If the user wants
  music to dip under VO, do it server-side at render time via FFmpeg in
  Lambda — that's already infrastructure we have.
- **Frame-accurate MP4 scrubbing.** Trim handles snap to *shot-level*
  frame boundaries (round to `1000/fps` ms at the data layer). Scrubbing
  inside a single shot is preview-only via `@remotion/player`. We do not
  decode source MP4s in the browser. WebCodecs is gated and Kie.ai outputs
  across 6 model families have inconsistent GOP structures — this is
  exactly the "ship trim-to-nearest-keyframe and call it a feature" trap.
- **Color correction, LUTs, speed ramps.** Speed change is per-shot
  data only (`playbackRate` on `VideoShot`), no UI in v1.
- **Multiplayer / real-time collab.** The shared-record design *allows*
  collab later but does not deliver it. v1 is single-editor with
  last-write-wins. No CRDTs, no presence indicators, no Yjs.
- **fabric.js / canvas overlay editor.** Drawing shapes, masking, etc.
- **Captions as an editable track.** Captions stay derived. Editing
  caption text is allowed (calls the Claude rewrite endpoint); editing
  caption *timing* directly is not.
- **Replacing `/production-doc`.** That surface keeps shipping AI
  features in parallel — Option C from the planning conversation is
  explicitly rejected.

## Why this shape (decision log)

These decisions were pressure-tested in the LLM Council session preceding
this plan. The full council transcript is not saved; the operative
verdicts are below.

- **Chose Option B (dedicated route, shared record) over Option A
  (extend `/production-doc`).** The 77-`useState` production-doc page is
  already a maintainability problem; layering a timeline on top of it
  inherits that fragility. A dedicated route gets a clean state
  architecture (Zustand + command pattern) from day one. The user
  confusion risk that the Outsider advisor flagged is mitigated by
  same-nav, same-project chrome — see UX walk-through below.
- **Chose Option B over Option C (replace `/production-doc`).**
  Production-doc has an unstaged image-upload plan in flight today and
  shipped 16 new B-roll model integrations in the last week. Tearing it
  down mid-velocity means either freezing AI features for months or
  rebuilding the editor against a moving target. Both are worse than
  living with two routes.
- **Chose a shot-graph editor over a CapCut-clone feature list.** Four
  of five council advisors converged on this independently. The
  asymmetry that matters: we have `VideoConfig` with each shot's
  prompt, model, and intent recorded — no other editor has that. Edits
  that propagate backward into AI generation are the only competitive
  position; tactile pixel manipulation we will lose to CapCut on every
  axis (perf, polish, mobile).
- **Did NOT choose the Contrarian's recommendation to skip the editor
  entirely and double down on generation.** The user explicitly asked
  for an editor and named the operations they want. The Contrarian's
  technical objections are real and inform the *kill list* above, but
  the strategic claim (don't build an editor) was overruled by stated
  product intent.
- **Did NOT pick the Expansionist's grand vision (SDK licensing,
  multiplayer, template marketplace, agent edits as v1 features).**
  All five reviewers flagged that as four products bolted onto an
  unshipped editor. The data model in v1 *enables* those later (it's
  JSON, it's diff-able, it's typed) but none ship in v1.
- **Chose `gpt-4o-mini-transcribe` over `whisper-1` and
  `gpt-4o-transcribe`.** Half the cost ($0.003/min vs $0.006/min) at
  quality good enough for derived captions. If quality complaints
  surface, swap models behind a single function — they share the
  transcription API shape. (Verified live: OpenAI pricing as of 2026-05.)
- **Chose to add `trimStartMs` / `trimEndMs` on `VideoShot` instead of
  splitting shots into "source + visible range" objects.** Two new
  optional fields. Backward compatible. Old `VideoConfig` rows still
  render exactly as today.
- **Chose `@remotion/player` for preview over a custom HTML video
  pipeline.** Already installed, already speaks the same composition
  model the render path uses, has a published imperative ref API
  (`play`, `pause`, `seekTo`, `getCurrentFrame`, `frameupdate` event).
  Verified live at <https://www.remotion.dev/docs/player/player>.
- **Chose OTIO export over EDL or FCPXML as the primary interop
  format.** OpenTimelineIO is JSON, the modern Pixar-led standard, has
  importers in Resolve / Premiere / CapCut Desktop via converters.
  Carries our model attributions cleanly. EDL/FCPXML can be added
  later via a converter library.

## Phases

### Phase 0 — Instrumentation + decision validation (2 days)

Before any editor code ships, answer the question the council called the
cheapest one: **do current users actually export to CapCut, and for what?**

1. Add an `editor_telemetry` table (migration; check next free migration
   number against `src/lib/migrations/`):
   ```sql
   CREATE TABLE editor_telemetry (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     workspace_id  UUID NOT NULL,
     project_id    UUID,
     event         TEXT NOT NULL,
     payload_jsonb JSONB,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX ON editor_telemetry (workspace_id, created_at DESC);
   CREATE INDEX ON editor_telemetry (event);
   ```
2. Two probes on the existing production-doc page:
   - When a creator clicks **Render**, emit `editor_event: render_clicked`
     with `{ shot_count, voiceover_seconds, has_overlays }`.
   - Add a one-tap "I'm going to finish this elsewhere" exit survey on
     the render-complete screen — three buttons (CapCut, Premiere, Other)
     + a "stayed here" implicit option. Emit `cap_cut_export_intent` or
     `external_edit_intent` with the choice.
3. Let it run for 2 weeks while Phase 1 is being built. At Phase 4 we'll
   re-read the data and decide whether the editor scope is right.

If real signal disagrees with the plan (e.g. nobody ever exports), we cut
v1 scope further or kill it. Honest off-ramp per CLAUDE.md rule 12.

### Phase 1 — Foundations (Week 1–2)

1. Migration: add additive columns to `production_docs` (or the
   equivalent — Explore confirmed it lives in `pipeline_stage_artefacts.metadata_jsonb`;
   open question Q1 below decides whether we keep it in JSONB or promote
   to a typed `video_configs` table).
2. Migration: extend the `VideoShot` shape — add optional fields
   `trimStartMs`, `trimEndMs`, `muted`, `playbackRate`,
   `transitionInId` (FK to a transitions table, nullable). Wire these
   through `src/remotion/types.ts` and `BRollScene.tsx` so the renderer
   honors them. Verify existing renders are byte-identical when these
   fields are absent.
3. Create the route shell: `src/app/(app)/editor/[projectId]/page.tsx`
   plus a `layout.tsx` that imposes the editor's full-bleed dark chrome
   while keeping the global nav reachable via a thin top bar
   ("← Back to Project").
4. Stand up the Zustand store: `src/lib/editor/store.ts`.
   - State shape: `{ config: VideoConfig, selection: ShotId | null,
     playheadMs: number, isDirty: boolean, version: number }`.
   - Commands: every mutation is dispatched via `applyCommand(cmd)`
     which pushes to an undo stack and returns the new state. Commands
     are pure (`(state, args) => newState`).
   - `useEditorStore.subscribe()` is the only thing that touches the
     network — debounced 800ms save, optimistic with a version bump.
5. Drop in `@remotion/player` reading from the store. Render
   `<Player component={YouTubeVideo} inputProps={{ config }}
   durationInFrames={...} fps={30} compositionWidth={1920}
   compositionHeight={1080} />`. Confirm preview matches the existing
   `/production-doc` render.
6. Ship behind `EDITOR_V1_ENABLED` flag. Default off.

**Definition of done:** an authenticated user can open
`/editor/<projectId>?flag=editorV1` and see a read-only preview of the
project that matches what `/production-doc` would render. No editing
yet. Saved version round-trips.

### Phase 2 — Single-track editing (Week 3–6)

The mechanical bulk of the work. Per the Executor advisor, this is
where small teams die if they don't aggressively snap to frame
boundaries at the data layer.

1. Timeline strip component (`src/components/editor/Timeline.tsx`):
   - Horizontal scroll, zoom 1–10x (keyboard `+` / `−`).
   - One video track, one VO track, one music track. All three are
     visual; only the video track is structurally editable in v1.
   - Per-shot card showing thumbnail (use `imageUrl` if present, else
     first-frame of `videoUrl`), duration label, model badge.
   - Drag-resize trailing edge → updates `durationMs` via a
     `ResizeShotCommand`. Snaps to `1000/fps` ms.
   - Trim-head / trim-tail handles on hover → `TrimShotCommand`. Writes
     `trimStartMs` / `trimEndMs`.
2. Playhead and scrubbing:
   - Click on the timeline ruler → `playerRef.current.seekTo(frame)`.
     The conversion is `frame = Math.round(timelineMs * fps / 1000)`.
   - Listen to the `frameupdate` event on the player ref → throttle to
     50ms before writing back to the store. Avoids the council's
     warning about excessive listeners.
3. Split at playhead (`SplitShotCommand`) — clones the shot, sets the
   first half's `durationMs` to `playhead - shot.startMs`, sets the
   second half's `startMs` to `playhead`.
4. Delete shot (`DeleteShotCommand`) — two modes: *ripple* (default;
   shifts all downstream `startMs` by `-deletedDuration`) and *blank*
   (inserts a gap, useful when keeping the VO in place during edits
   the user plans to fill later). Default determined by a modifier key
   (`Shift+Delete` = blank).
5. Reorder (`ReorderShotsCommand`) — drag-drop, library of choice
   `@dnd-kit/core` (already familiar to the project; check
   package.json).
6. Mute (`SetMuteCommand`) — both per-shot and master.
7. Undo/redo — keyboard `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`. Stack
   depth capped at 200.
8. Save-state UX — debounced 800ms, but a "Saved 4s ago" indicator in
   the top bar with manual `Cmd/Ctrl+S` to force-flush.

**Definition of done:** a user can take a 6-shot AI-generated video,
trim shot 2, split shot 4, delete shot 3 with ripple, swap shots 5 and
6, mute shot 1, and re-render to MP4 via the existing Lambda path. The
result plays correctly with audio still aligned where it should be.

### Phase 3 — Replace media + AI participation (Week 7–9)

The differentiator vs CapCut. Three buttons, two of them new
infrastructure.

1. **Replace media** popover (`src/components/editor/ReplaceMediaPopover.tsx`):
   - Tabs: *Upload*, *From this project*, *Regenerate*.
   - Upload — file picker, drag-drop, validates MIME (`video/mp4`,
     `image/png`, `image/jpeg`, `image/webp`), size cap 100 MB,
     uploads to Vercel Blob, sets `imageUrl` or `videoUrl` on the
     shot. Strips EXIF before upload (privacy).
   - From this project — lists `broll_clips` for this `project_id`
     and presents them as a grid. One-click swap.
   - Regenerate — shows the shot's current `visual_description` in a
     textarea, model picker dropdown defaulting to the shot's
     existing `model_id`. Submits to `/api/broll` (existing endpoint)
     and polls. While polling, the shot card shows a generation
     state. When ready, swap automatically.
2. **Re-pace voiceover** button — top-right of the timeline.
   - Hands the current timeline (per-shot durations + on-screen text)
     to a server endpoint that calls ElevenLabs with the existing
     voice id and the same script, re-cut at the new pacing.
   - Existing endpoint or new? Likely new — confirm in Phase 1 recon.
     New endpoint `/api/editor/repace-voiceover` is fine.
   - Cost: per ElevenLabs character. Already a known line item.
3. **Re-write caption** — per-segment Claude call. Right-click on a
   caption segment → "Rephrase…" → opens a tiny dialog with the
   current text and a "regenerate" button. Preserves segment timing.
4. **Conflict resolution rule** (the field-level question the council
   flagged): if the user manually edits a shot's `visual_description`
   while a regen-from-doc job is pending for that shot, the manual
   edit wins. Per-field `editedAt` timestamps on `VideoShot`. AI
   regenerations are no-ops if the field has been edited more
   recently. This is a database column, not a UI behavior — must be
   enforced server-side.

**Definition of done:** a user can replace an underperforming AI shot
with a new Veo 3.1 generation from inside the editor, regenerate the
voiceover to fit the new pacing, and have the captions auto-update.
No round trip through `/production-doc`.

### Phase 4 — Captions, transitions, text overlays, export (Week 10–12)

1. Captions:
   - On VO change, fire `/api/editor/captions/regenerate` which calls
     `gpt-4o-mini-transcribe` and stores the result keyed by
     `voiceoverUrl` hash so repeat calls are free.
   - Cache hits via Vercel KV.
   - Render via `@remotion/captions` (verify the package is installed;
     if not, add it).
   - Editing caption text → calls the Claude rephrase endpoint above.
2. Transitions:
   - One type for v1: cross-fade.
   - UI: gap between two shot cards in the timeline shows a `+` icon
     on hover → click to insert a cross-fade. Default duration 500ms.
3. Text overlays:
   - Extend `LowerThird`. Per-shot text plus master overlay layer.
   - Two preset positions (lower-third, top-center), font size, color.
     No animation tuning UI in v1 — fixed fade-in.
4. **OTIO export**:
   - Server-side endpoint `/api/editor/export/otio` that serializes
     the `VideoConfig` into OpenTimelineIO JSON.
   - Includes per-clip metadata: source URL, model id, prompt,
     generation timestamp. So a creator finishing in Resolve has a
     full provenance trail of which shot came from which AI.
   - Download as `.otio` file. No third-party service involved.
   - Telemetry: emit `editor_event: otio_exported` so we can see who
     uses it.
5. Render integration:
   - The existing `/api/render/video` already takes `VideoConfig`.
     New fields (`trimStartMs`, `muted`, etc.) flow through the
     existing path. Per-shot `<Sequence>` rendering in Remotion
     already supports `from` and `durationInFrames`; we wire the trim
     fields into those.
   - The cross-fade transition uses `@remotion/transitions`'s
     `<TransitionSeries>` API.

**Definition of done:** v1 is shippable. Flip the `EDITOR_V1_ENABLED`
flag for the author's workspace first, soak for a week, then expand.

## Cost estimate (rule 8)

Verified live 2026-05-18.

### Per-creator-session costs

For a typical 3-minute video, 6-shot project, 1 voiceover regeneration,
2 shot replacements, captions on:

| Service | Quantity | Unit cost | Subtotal |
|---|---|---|---|
| Lambda render (1080p) | 1 final render | $0.017/min | **~$0.05** |
| ElevenLabs VO regen | ~600 chars | (existing rate) | **~$0.06** |
| Kie.ai shot regen (Veo 3.1, ~8s) | 2 regens | varies by model | **$0.40–1.20** |
| OpenAI captions (`gpt-4o-mini-transcribe`) | 3 min audio | $0.003/min | **<$0.01** |
| Caption rephrase (Claude) | ~5 calls | input+output tokens | **<$0.01** |
| Vercel Blob storage | <100 MB | $0.023/GB·mo prorated | **<$0.01** |

**Per-session marginal cost: ~$0.50 – $1.35.** The dominant cost is
B-roll regeneration, which is the existing cost line, not new.

### Per-creator-month at 20 sessions

~$10–27/month per active creator. Most of this is already in the
business model (B-roll generation is the AI line item we already
charge for). The editor adds *additional* B-roll regens by making
them cheap to trigger — this is a feature, but must be visible to the
user (show running session cost in the UI, soft-cap regens per project
to 10 by default).

### Fixed infra

No new monthly fixed cost. Vercel KV usage for caption caching is
within the free hobby tier at this scale.

### Risk: the "happy regen" loop

If a creator regenerates 50 times in a session because the UI makes
it cheap to do so, costs spike. **Guardrail:** hard cap of 20 regens
per project per 24 hours, configurable per workspace. Soft cap warning
at 10. Telemetry tracks every regen. Re-uses the rate-limiting pattern
already in `src/lib/remotion-lambda-quotas.ts`.

## Security (rule 13)

Per CLAUDE.md rule 13: planned in from day one.

### Threat surface added by this feature

- **User-uploaded media.** Direct browser → Vercel Blob upload via
  presigned URL. Server validates MIME, size, and decodes the first
  frame (libvips / sharp) to confirm it's a real video/image before
  accepting it. Strips EXIF from images. Rejects HEIC / RAW / SVG.
- **AI regeneration triggered from the timeline.** Every regen is a
  paid API call. Rate-limit per workspace and per project (see Cost
  section above). Auth required on every endpoint — reuse the
  existing workspace-scoping middleware that production-doc uses.
- **Shared edit surface.** Both `/production-doc` and `/editor` write
  the same row. Both endpoints must check `workspace_id` on every
  read and write. Last-write-wins with a `version` integer
  guards against accidental clobbering of a tab that was open in the
  background.
- **OTIO export.** The exported file contains URLs to assets in our
  Vercel Blob. Those URLs are already public-readable by design (same
  as the existing render output). No new exposure. Do not include
  the workspace id, the creator's email, or any internal database
  ids in the OTIO payload — only the data the user already owns.
- **Captions / transcription.** Voiceover audio is sent to OpenAI for
  transcription. This is the same data we already produce. Set
  `store=false` on the API call (OpenAI default is no training for
  paid API). Do not log raw transcripts to server logs — store only
  in the caption cache row.
- **Authorization.** Every editor route checks the user is a member of
  the project's workspace and has at least `editor` role. Reuse
  `requireWorkspaceMember()` from existing handlers.
- **Defense in depth on regens.** Hard cap regens server-side, not
  client-side (client cap is hint; server cap is law). The
  rate-limiter is the only thing between a leaked API key and a
  thousand-dollar Kie.ai bill.
- **Audit trail.** Every command applied to a `VideoConfig` is logged
  to `editor_telemetry` with a non-PII payload (no shot prompts, just
  command type + shot id + duration deltas). Lets us debug user
  reports of "the timeline lost my edit" without leaking content.

### Things we are explicitly NOT doing in v1

- **No multiplayer collab.** Avoids CRDT / OT complexity entirely.
  Last-write-wins is the simpler, safer fallback.
- **No external user uploads to publicly shared URLs.** Uploads go to
  Vercel Blob with the existing project-scoped URL pattern. No new
  bucket, no new IAM policy.
- **No client-side keys.** ElevenLabs / OpenAI / Kie.ai keys stay
  server-side. The editor's "regenerate" buttons are server-mediated
  endpoints, not direct API calls from the browser.

## UX walk-through (rule 10)

The lazy-user path, refresh-safe, mobile-aware.

1. Creator finishes their production-doc, voiceover, and B-roll
   generation. The render-result page now has **two** buttons:
   *Render Final Video* (existing) and *Open in Editor* (new). The
   editor button is visually equal weight, not buried.
2. Click *Open in Editor*. Loads `/editor/<projectId>`. Same nav, same
   project title, dark canvas. The first time they open it, a single
   coach mark over the timeline: "Drag, trim, replace. Your AI work is
   here." Dismissable. Never shown twice.
3. They scrub the timeline. The `@remotion/player` preview updates
   live. Performance is smooth on a mid-range laptop because the
   preview is the same Remotion path they already render; we are not
   asking the browser to decode arbitrary MP4s.
4. They drag the trailing edge of shot 3 to shorten it. The preview
   reflows in <200ms. The captions strip below the video updates as
   shot timings shift (captions are derived, not stored).
5. They notice shot 5 is wrong. Click it → side panel slides in with
   *Trim*, *Split*, *Mute*, *Replace*. Click *Replace* → popover with
   *Upload*, *Pick from project*, *Regenerate*. Click *Regenerate*,
   bump the prompt, pick Veo 3.1, submit. The shot card shows a
   spinner. They keep editing.
6. They hit *Re-pace voiceover*. 12-second progress indicator. New VO
   slots in; captions auto-update. They never had to leave the page.
7. They close the tab to grab coffee. Come back 20 minutes later. The
   editor reopens to exactly where they were — the autosave is
   honest. The pending regen has finished and the shot is updated.
8. They hit *Render Final Video*. Existing Lambda path takes over.
   90 seconds later they have an MP4. They never typed the word
   "timeline."
9. **Alternative path: they want to finish in CapCut.** *Export
   project* button is in the editor menu, not buried. Click → OTIO
   file downloads. Three sentences of inline help: "Open this in
   DaVinci Resolve or convert with [otioconvert] for Premiere/CapCut.
   All AI generations are preserved." Telemetry fires; we know to
   come back and improve this path.
10. **Mobile.** Editor route shows a holding screen on viewports
    <1024px: "Editing is desktop-only for now. Production-doc works
    on mobile." No half-broken touch timeline. v2 problem.
11. **Refresh during a pending regen.** Pending state is persisted to
    the `broll_clips` row; the editor on remount picks up the polling
    job from the regen task id. No work lost.
12. **Two tabs open on the same project.** Second tab to save shows a
    "Newer version exists — reload?" toast. Last-write-wins under the
    hood, but the user gets a chance to merge mentally before the
    clobber happens.

## Open questions

1. **JSONB vs typed table for `VideoConfig` storage.** ✅ **Resolved
   2026-05-18 — stay JSONB, no new `video_configs` table, no new
   migration to move rows.**
   - **Correction to the plan's premise:** `VideoConfig` is NOT
     persisted. The auto-pipeline writes the LLM's *production doc*
     to `pipeline_stage_artefacts.metadata_jsonb` (see
     [generate-production-doc.ts:143-151](../src/lib/auto-pipeline/stages/generate-production-doc.ts#L143-L151));
     the user-facing `/production-doc` page persists doc edits via
     `user_history` (table from migration 0049, polymorphic
     `kind`/`payload` JSONB, per-user, see
     [history.ts:1011](../src/lib/history.ts#L1011)). The Remotion
     `VideoConfig` shape is reconstructed on the fly at render time
     from the doc.
   - **Implication:** the editor edits *the doc*, not a derived
     `VideoConfig`. The plan's proposed `trimStartMs` / `muted` /
     `playbackRate` / `transitionInId` fields live on the doc-row
     shape as **additive optional fields**, same pattern as
     `sceneFade` / `sectionTitle` / `sceneZoom`. **Confirmed by
     operator 2026-05-18.**
   - **TS-only changes** in `src/remotion/types.ts` and the doc-row
     type. No SQL migration for these fields.
2. **Does `@remotion/player` support live `inputProps` updates
   without remount?** ✅ **Resolved 2026-05-18 — yes, no spike
   needed.**
   - Verified via Remotion docs (Context7, `/remotion-dev/remotion`).
     Canonical pattern is `useMemo(() => ({ ...props }), [deps])` +
     `<Player inputProps={inputProps} />`. Docs label this
     *"Real-time prop updates via React state."* Player re-renders
     on reference change, does NOT remount.
   - `PlayerRef` exposes `play`, `pause`, `seekTo`,
     `getCurrentFrame`, plus `addEventListener('frameupdate' |
     'timeupdate' | 'seeked')`. `frameupdate.detail.frame` is the
     current frame (available since v3.2.27).
   - **Footgun:** any inputProps value that is a fresh function /
     object on every render will re-render every consumer.
     Memoize at primitive granularity. Zustand + immer's structural
     sharing handles this cleanly.
3. **Multi-user editing inside a workspace.** ✅ **Resolved
   2026-05-18 — single-owner-edits for v1.** Owner can edit,
   teammates view read-only. Matches the deferred-multiplayer
   decision. No CRDT, no presence, no workspace-scope migration in
   Phase 1.
4. **Shared-record version column.** ✅ **Resolved 2026-05-18 —
   single new migration `0078`: add `version INT NOT NULL DEFAULT 1`
   to `user_history`.** Updates send `version` in the body; server
   runs `UPDATE ... SET payload=$1, version=version+1 WHERE id=$2
   AND version=$3`. 0 rows affected → 409 + current row, client
   shows "newer version exists — reload?" toast.
5. **Editor billing visibility.** ✅ **Resolved 2026-05-18 — build
   the soft cap + per-session cost meter from day one.** 10-regens
   soft warning, 20-regens hard cap per project per 24h
   (server-enforced). Cost meter visible in the editor chrome by
   default. Adds ~2 days to Phase 3 but protects against the happy-
   regen loop.
6. **ElevenLabs re-pace API contract.** Does ElevenLabs support
   re-generating a voiceover at *per-segment* target durations, or
   only globally? If only globally, the *Re-pace voiceover* button
   has to be smarter — possibly split the script into segments and
   request each one with its target duration. **Resolve in Phase 3
   recon.** (Not a Phase 1 blocker.)
7. **Captions package.** Confirm `@remotion/captions` exists or
   determine the render-path equivalent. The Explore recon noted
   captions are "burned in" on shorts via `SubtitleText` — that
   pattern may extend cleanly to longform. **Resolve in Phase 4
   recon.** (Not a Phase 1 blocker.)

## Phase 1 corrections (2026-05-18 recon)

The recon pass before Phase 1 surfaced two corrections to the
original plan. Both are reflected in the resolved opens above; this
section calls them out for anyone reading the plan top-down.

- **No `video_configs` table.** The plan referenced creating one;
  scrap that. Edits live on the doc row in `user_history.payload`
  (or in `pipeline_stage_artefacts.metadata_jsonb` for auto-
  pipeline-generated docs). The renderer keeps reconstructing
  `VideoConfig` at request time and now reads the new optional
  fields.
- **One migration for Phase 1, not two.** Migration `0078` adds
  `version INT NOT NULL DEFAULT 1` to `user_history` and nothing
  else. No `VideoShot`-shape SQL change; those are TS-only.
- **`@remotion/player` spike is dropped.** Q2 is answered by docs.
  Pocket the spike day for the timeline component instead.

## Effort estimate

| Phase | Scope | Estimate |
|---|---|---|
| 0 — Instrumentation | Telemetry probes + 2-week data collection | 2 days code, 2 weeks calendar |
| 1 — Foundations | Route, store, player, schema migrations | 2 weeks |
| 2 — Single-track editing | Timeline, trim/split/delete/reorder/mute, undo/redo | 4 weeks |
| 3 — Replace + AI participation | Media replace, voiceover re-pace, caption rewrite, conflict rules | 3 weeks |
| 4 — Captions + transitions + overlays + export | gpt-4o-mini-transcribe, cross-fade, OTIO export | 3 weeks |

**Total: ~12 weeks of focused work, plus the Phase 0 calendar wait.**
Flag-gated soft rollout to the author's workspace first. Decision to
ship to all workspaces gated on Phase 0 telemetry + one-week soak.

If Phase 0 telemetry shows nobody exports to CapCut and nobody asks
for editing, **kill the project at week 2.** Cheap exit per rule 12.

## References

- LLM Council session (verbal, 2026-05-18) — unanimously surfaced that
  the shot-graph reframe beats the CapCut-clone framing.
- Remotion Lambda cost example, verified live 2026-05-18 at
  <https://www.remotion.dev/docs/lambda/cost-example> — $0.017/min HD,
  ~$0.078/min 4K.
- Remotion Player API, verified live 2026-05-18 at
  <https://www.remotion.dev/docs/player/player> — `PlayerRef` methods
  and event names confirmed.
- OpenAI transcription pricing, verified 2026-05-18 —
  `gpt-4o-mini-transcribe` $0.003/min, `gpt-4o-transcribe` $0.006/min.
- Related plan: `_plans/2026-05-13-lambda-render-migration.md` —
  Lambda already deployed, cost guardrails in place. The editor reuses
  that infrastructure end-to-end for final renders.
- Related plan (in-flight): `_plans/2026-05-18-prodoc-image-upload-and-edit.md`
  — production-doc continues to ship; not blocked by this work.
