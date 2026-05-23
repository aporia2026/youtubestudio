# Editor — Timeline + Shots UX Overhaul + Expanded AI Editing

**Date:** 2026-05-23
**Owner:** Yoav (info@flexelent.com)
**Source thread:** in-chat conversation, 2026-05-23

## 1. Goals

Make the shot-graph editor feel like a real NLE for a *lazy user* (CLAUDE.md
rule 10): every action obvious, every state visible, no hidden affordances.
Specifically:

1. **Audio and video are visibly and functionally separate** — clear lane
   boundaries, independent selection, independent right-click context menu,
   independent inspector.
2. **Live narration text appears below the preview** as it plays, so the
   user always knows what's being said.
3. **Click an element → press Play → playback starts from that element**, not
   from wherever the playhead was sitting (standard NLE behavior).
4. **Horizontal timeline scrolling is obvious** via a minimap strip with a
   draggable viewport rectangle, plus a thick visible scrollbar.
5. **Right-click on any timeline element (and any Shots-tab item)** brings up
   a context menu with relevant verbs (delete, duplicate, split at playhead,
   set duration, mute, etc).
6. **Shots tab is more usable**: right-click works, click jumps the preview
   *and* the timeline (currently it only selects).
7. **Expanded per-element AI editing**: surface background removal, mask
   inpaint / erase, outpaint / canvas extend, and upscale as one-click verbs
   on shot images and overlays — using the existing kie.ai integration where
   models exist, and Replicate Bria for RMBG (already wired in
   `src/lib/overlay-rmbg.ts`).

## 2. Constraints

- This is the live editor used today; the change is incremental, not a
  rewrite. The existing `TimelineV2` shell, `Timeline.tsx` video lane,
  `AudioLane`, `CaptionsLane`, `OverlaysLane`, `ShotsTab`, `TransportBar`
  and editor store (`useEditorStore` + commands) all stay. We add affordances
  on top of them.
- Per CLAUDE.md rule 1: no API surface I cite below has been re-verified
  against current kie.ai docs yet — the WebFetch attempts on `kie.ai/api`,
  `docs.kie.ai`, and `kie.ai/market` all returned JS-rendered shells. The
  catalog additions for outpaint / upscale / smart-mask are flagged with a
  **PRICE TBD — verify before merge** marker in §11, and the plan will be
  updated after I open the live market page and pull real model IDs and
  per-image costs.
- Per CLAUDE.md rule 9: when I touch wavesurfer, @dnd-kit, @remotion/player,
  Replicate, kie.ai, or any other external lib, I'll query Context7 first
  for current docs.
- Per project AGENTS.md: this is a non-standard Next.js — read
  `node_modules/next/dist/docs/` before touching routing / data fetching
  shape if the work crosses an API route boundary.
- No new database migrations unless absolutely required. New per-row state
  (e.g., audio mute, audio volume override) lands as new JSONB fields on
  the existing rows table, gated behind a migration that runs automatically
  on Vercel deploy (project policy in `CLAUDE.md` / `AGENTS.md`).

## 3. Requirements (locked by user, 2026-05-23)

| Topic | Choice |
|---|---|
| "Audio editable separately" | **Selectable + per-segment actions.** Voiceover stays as one MP3 anchored at t=0; we add selection, an audio inspector body for mute / volume / fade in / fade out, and a right-click menu. Full drag-to-move / split is **out of scope** for this PR (a future plan can layer it on). |
| Narration display | **Strip directly under the preview.** A 32-40 px tall bar that shows the active caption segment, advances with the playhead, and clicks-to-seek on each line. |
| Click-then-play behavior | **Seek to element start, play forward.** Clicking a shot card / shots-tab item moves both the preview frame and the timeline playhead to that element's start; pressing Play continues from there. |
| Scroll UX | **Minimap with draggable viewport** (Premiere / Davinci style) plus a thicker, always-visible scrollbar as a belt-and-braces fallback. |

## 4. The lazy-user walkthrough (rule 10)

Before writing code, here's what the user sees end-to-end after this PR:

1. They land in the editor. Three things are immediately obvious: a stacked
   timeline with **labeled, visually separated** Video / Audio / Captions /
   Overlays rows; a **narration strip** under the preview that updates as
   the playhead moves; and a **minimap** under the timeline showing the
   whole project with a viewport rectangle they can drag.
2. They click a shot card on the video lane → the preview jumps to that
   shot's first frame, the playhead snaps to the shot's start, the
   ShotsTab on the left highlights the same shot. They press Space → the
   project plays forward from that shot.
3. They right-click the shot card → context menu offers Delete, Duplicate,
   Split at playhead, Set duration…, Reset trim, Add cross-fade, Cycle
   transition, AI Edit ▸ (sub-menu: Erase region, Replace with prompt,
   Remove background, Outpaint, Upscale). Same menu (minus split / trim) is
   reachable by right-clicking the matching ShotsTab item.
4. They right-click the audio lane → context menu offers Mute, Volume
   override, Fade in… / Fade out… , Replace voiceover, Open audio inspector.
5. They drag the minimap viewport → the timeline scrolls in real time.
   They wheel-scroll on the timeline → it pans horizontally (shift+wheel
   still works for explicit horizontal scroll).

This walkthrough is the spec for the UI surfaces below.

## 5. Architecture — three real choices

Most of the work is mechanical. Three places have a genuine tradeoff and
get presented as alternatives below.

### 5A. Lane visual separation

**Recommendation: B.**

- **Option A — keep current colored backgrounds, just add a 1 px stronger
  divider.** Cheapest. Doesn't fully fix the visual bleed where the
  waveform centerline sits on the lane boundary.
- **Option B (recommended) — explicit container per lane with a 6-8 px
  gap, rounded corners, and a tinted edge.** Each lane reads as its own
  "track strip" the way CapCut / Premiere render them. The playhead line
  still spans them as one element. The audio waveform gets clamped to the
  lane's interior so it can't visually bleed.
- **Option C — collapse audio into a thin status bar above the timeline.**
  Saves vertical space but loses the per-segment context menu surface the
  user just asked for. Rejected on requirement grounds.

### 5B. Minimap implementation

**Recommendation: B.**

- **Option A — render the video lane at scale.** Reuse the existing
  thumbnails downscaled. Pixel-perfect but expensive to render on every
  zoom / scroll tick (lots of `<img>` reflows).
- **Option B (recommended) — render colored blocks at scale (one block per
  shot, audio band underneath).** Cheap, fast, no thumbnail download
  pressure. Aliases nicely on small widths. Click jumps the viewport;
  drag the viewport rectangle pans the timeline.
- **Option C — render a 1D heatmap of caption density only.** Cute, but
  hides which shot you're scrolling to. Rejected.

### 5C. AI editing surface

**Recommendation: B.**

- **Option A — a single modal "AI tools" launched from a button on each
  shot card.** Centralized but adds a click to every action.
- **Option B (recommended) — a sub-menu on the right-click context menu
  PLUS a quick-actions strip on the inspector's Shot tab.** Right-click
  is the fast path (power users); strip is the discoverable path (lazy
  users, rule 10). Both call into the same backend handlers.
- **Option C — a floating "AI" pill that hovers over the selected shot's
  preview frame.** Visually busy; risks fighting the existing
  TransformOverlay that's already wired for image_x/y/scale/rotation.

## 6. Build phases

Sized so each phase is independently shippable + reviewable.

### Phase 1 — Lane separation + audio selectability (no AI yet)
- Rework `TimelineV2.tsx`'s lane container into stacked "track strips" per
  §5A option B.
- Add an `onSelectLane('audio' | 'captions' | 'overlays')` callback so the
  user can click any lane to switch the inspector tab. Already wired
  visually in `EditorInspector`'s tab list — we just need to dispatch.
- Clamp the wavesurfer waveform so it can't render outside the audio
  lane's interior padding.
- New per-row state on the audio (voiceover_mute, voiceover_volume_db,
  voiceover_fade_in_ms, voiceover_fade_out_ms). Persisted via PATCH on the
  ProductionDoc; defaults preserve current behavior.
- Inspector → Audio tab gains the volume / mute / fade controls.

### Phase 2 — Narration strip + click-to-jump
- New component `NarrationStrip` in `src/components/editor/`.
- Driven by the same `captions` bundle the CaptionsLane reads. Picks the
  segment whose `[start, end)` contains `playheadMs/1000`; renders the
  text in a 14-15 px line. Click on the strip seeks to that segment's
  start.
- Mount inside the preview slot, directly under the `<Player>`. Hidden
  when no captions exist (degrades gracefully).
- In `EditorClient.tsx`, change ShotsTab and Timeline shot-card click
  handlers to ALSO call `seekFromUser(rowStartMs[i])` after the existing
  `SET_SELECTION`. Currently only SET_SELECTION fires (verified in
  EditorClient.tsx:1858 and src/components/editor/leftrail/ShotsTab.tsx).

### Phase 3 — Right-click context menus
- Generalize `OverlayContextMenu` (already used by overlay cells) into a
  shared `EditorContextMenu` that lives in `src/components/editor/`. Same
  API (`x, y, items, onClose`); same portal-render + ESC-close +
  click-outside-close behavior.
- Wire context menu trigger on:
  - shot card (video lane) — Delete / Duplicate / Split at playhead / Set
    duration… / Reset trim / Add or remove cross-fade / AI Edit ▸
  - audio lane — Mute / Unmute / Volume override… / Fade in… / Fade out…
    / Replace voiceover / Open audio inspector
  - caption pill — Edit text / Set timing… / Delete segment / Re-align
    segment from current playhead
  - overlay marker — Edit position / Replace overlay / Remove overlay /
    AI Edit ▸
  - ShotsTab item — Delete / Duplicate / Jump preview to start (also the
    default click) / Set duration… / AI Edit ▸
- "Set duration…" / "Volume override…" / "Set timing…" / "Fade … ms" open
  small inline popovers, not full modals. Confirm by Enter, cancel by
  Escape.

### Phase 4 — Minimap + thick scrollbar
- New component `TimelineMinimap` in `src/components/editor/timeline-v2/`.
- Renders a 28-32 px strip below the lane stack, full project width.
- One colored block per shot (purple at full saturation for the active
  shot, dimmer for others); a thin cyan band representing audio coverage;
  a 1 px gold mark per caption segment.
- A viewport rectangle is painted at the same x-range the scrolling
  timeline is showing; user drags it to pan, or click-anywhere to center
  the viewport on that point.
- `.editor-scroll` overrides for the timeline strip bump the scrollbar
  height to 14 px with a high-contrast thumb (existing class lives in
  `src/app/(app)/edit/[projectId]/editor-theme.css` lines 252-268).

### Phase 5 — Per-element AI editing surface
- New `EditorAIActions` component, rendered as both:
  - a sub-menu (`AI Edit ▸`) in every relevant context menu (§Phase 3)
  - a quick-actions strip near the top of the Inspector's Shot tab
- Verbs (each lands as its own one-click handler):
  - **Replace with prompt** — existing `image/edit` route with the
    user's choice of prompt-only model (Nano Banana, Qwen, Seedream,
    Flux Kontext). Already exists for production-doc; this exposes the
    same picker on the editor's shot inspector.
  - **Erase region (brush mask)** — opens `MaskBrushEditor` on the
    shot's current image; on apply, calls `image/edit` with
    `intent: 'erase'`, which already routes to the mask-capable Erase
    backend (`DEFAULT_ERASE_OPTION_ID` — Ideogram v3 Quality today).
  - **Remove background** — new endpoint
    `POST /api/generate/production-doc/image/rmbg` that pipes the row's
    image through `removeBackground()` (Replicate Bria, already wired
    in `src/lib/overlay-rmbg.ts`), uploads the cutout to R2, and patches
    `row.image_url`. Backwards-compat: a "restore original" affordance
    keeps the pre-RMBG URL on the row so the action is undoable.
  - **Outpaint / extend canvas** — **NEW catalog entry needed.** Verify
    kie.ai market for a current outpainting model (likely candidates:
    Ideogram v3 outpaint, Flux Fill, Bria expand). Add to
    `image-edit-pricing.ts` with **PRICE TBD** until verified.
  - **Upscale 2× / 4×** — **NEW catalog entry needed.** Verify kie.ai
    market for current SR offering (likely Topaz Gigapixel, Real-ESRGAN
    variants, or Replicate's clarity-upscaler). Add behind the same
    catalog.
  - **Smart-mask suggest** *(stretch)* — auto-segment the image and let
    the user click an object instead of brushing. SAM-2 / Florence /
    YOLO-Seg via Replicate. Deferred unless kie.ai already exposes one
    cheaply; if so, becomes a "click to erase object" affordance on the
    Erase verb.
- The picker UX reuses the existing dropdown from `OverlayEditDialog`,
  ported into the shot inspector.

## 7. Per-rule audit

### Security (rule 13)
- Every new mutation endpoint reuses `apiRoute.authed`, `checkRateLimit`,
  `checkSafePublicUrl` — same pattern as the existing
  `image/edit/route.ts`. No new auth path.
- Mask uploads continue to flow through R2 with the same signed-URL
  shape; no client-controlled URLs reach kie.ai without SSRF check.
- The Erase prompt stays server-generated (see
  `image-edit-pricing.ts:ERASE_PROMPT`). New verbs follow the same rule:
  the client sends `intent` + media URLs, the server picks the model and
  prompt.
- No PII / secrets in logs. The new `console.info` lines below quote
  shot indices, ms values, model ids — never the script_text content.

### Observability (rule 14)
Logs added per surface, in the project's existing `[editor <subsystem>]`
namespace:
- `[editor timeline lane-select] kind=audio|captions|overlays` on lane click
- `[editor timeline context-menu] open kind=shot|audio|caption|overlay
  rowIndex=… x=… y=…`
- `[editor timeline context-menu] dispatch action=delete|duplicate|split|…
  rowIndex=…`
- `[editor narration-strip] segment-change idx=… text-prefix=…`
- `[editor minimap] viewport-drag fromMs=… toMs=…`
- `[editor minimap] click jumpMs=…`
- `[editor shots-tab] click rowIndex=… seekTo=…`
- `[editor ai-actions] dispatch verb=erase|replace|rmbg|outpaint|upscale
  rowIndex=… modelId=…`
- `[editor ai-actions] result verb=… durationMs=… ok=true|false`

Server side mirrors with `logger.info(...)` in
`src/app/api/generate/production-doc/image/rmbg/route.ts` and any new
verb routes.

### Settings audit (rule 15)
New keys in `src/lib/editor/settings.ts`:
- `editor.timeline.minimapHeight` (default 28, range 20-48)
- `editor.timeline.scrollbarHeight` (default 14, range 10-20)
- `editor.timeline.showMinimap` (default true)
- `editor.narration.showStrip` (default true)
- `editor.narration.fontSize` (default 14, range 12-18)
- `editor.playback.clickShotToSeek` (default true) — escape hatch in case
  someone wants the old select-only behavior
- `editor.ai.defaultReplaceModel` (default `'nano-banana-edit'`)
- `editor.ai.defaultOutpaintModel` — defined after price verification
- `editor.ai.defaultUpscaleModel` — defined after price verification
- `editor.audio.defaultVolumeDb` (default 0)
- `editor.audio.defaultFadeInMs` (default 0)
- `editor.audio.defaultFadeOutMs` (default 0)

Each setting surfaces in the existing `SettingsTab` left-rail. New group
header: "Timeline" / "AI editing" / "Audio".

## 8. Out of scope (explicit non-goals)

- Drag-to-move / split / multi-clip audio. Today there's one MP3 anchored
  at t=0 — making it draggable is a separate plan.
- Multi-track audio (music + VO as two independent clips). Music URL
  exists in the doc but the editor lane shows VO only.
- Per-shot audio (per-shot SFX). Same reason.
- Real-time captions edit beyond the current double-click-to-edit inline
  flow.
- Keyboard shortcuts beyond the existing set. Right-click is the new
  surface; shortcuts come in a separate plan after the menus settle.

## 9. Risks

1. **Wavesurfer height clamp may distort the waveform on tall lanes.** I'll
   verify with Context7 docs that `barAlign` / `cursorWidth` / container
   padding actually clip the bars and don't just hide them. If clipping
   fails, fall back to a custom `<canvas>` waveform we render once on
   load.
2. **Minimap re-render cost.** If thumbnail-block rendering causes layout
   thrash at 200+ shots, debounce the viewport rectangle to a ref and
   draw via `transform: translateX(…)` instead of changing `left`.
3. **Right-click conflicts with the dnd-kit reorder grab handle.** The
   shot card's top 14 px is the grab handle; right-click on that strip
   should still open the menu, not start a drag. dnd-kit only listens to
   `pointerdown`/`mousedown` with `button === 0` so this should be safe —
   verify in `Timeline.tsx` before claiming "done".
4. **kie.ai endpoints I'm citing for outpaint / upscale don't exist or
   have moved.** Mitigated by the "PRICE TBD — verify before merge"
   marker in §11 and by gating those verbs behind a feature flag until
   the route is end-to-end green in dev.

## 10. Rejected alternatives summary

- Single AI modal (5C-A): adds friction; rejected by rule 10.
- Lane visual-only fix (5A-A): doesn't fix the audio-into-video bleed.
- Thumbnail minimap (5B-A): expensive re-render churn.
- Caption-density heatmap (5B-C): hides what's where.
- Full draggable audio clip (requirement Q1 "Full NLE-style"): user
  picked the selectable-only path; defer the rest.

## 11. Pricing notes — verify before merge (rule 8)

The existing `image-edit-pricing.ts` catalog has verified prices for the
14 mask + prompt-only edit options. New entries this plan introduces:

| Verb | Candidate model | Source | Price | Status |
|---|---|---|---|---|
| Remove background | Replicate `bria/remove-background` (already wired) | Replicate | known to caller (it's part of the overlay-rmbg pipeline today) | **VERIFY current per-prediction cost on Replicate's model page before exposing as a one-click verb** |
| Outpaint | TBD (Ideogram v3 outpaint? Flux Fill? Bria expand?) | kie.ai market | — | **TBD — pull from `kie.ai/market` before adding catalog row** |
| Upscale 2×/4× | TBD (Topaz? clarity-upscaler? real-esrgan?) | kie.ai market or Replicate | — | **TBD — pull from market page; pick cheapest sane default** |
| Smart-mask suggest | SAM-2 via Replicate? | Replicate | — | **TBD — stretch** |

Plan will be updated with concrete model IDs and per-image USD costs as
soon as the market page is open in a browser (WebFetch can't render its
JS catalog).

## 12. Resolved questions (locked 2026-05-23)

- **"Set duration…" UI** → both. Render a small text input (ms / s
  toggle) **and** a horizontal slider, side by side. Editing either
  drives the other live. Enter commits, Escape cancels. Useful for
  power-user precision (text) and lazy-user dragging (slider) — covers
  rule 10 for both audiences.
- **Background-remove output** → alpha overlay, undoable. The verb
  doesn't replace the row image; instead it stores the RMBG cutout as
  a new per-row field (`row.image_rmbg_url`) and toggles a per-row
  `image_rmbg_applied` flag. When the flag is on, the renderer composes
  the cutout over the row's `background_color` (or a transparent
  background fed to the player when null). Undoing is one click:
  clearing the flag restores the original image as the visible layer
  without losing the cutout — re-applying is free. Adds two new
  columns; lands in the next migration. The right-click menu shows
  "Remove background" → "Restore original background" depending on the
  flag state.
- **Minimap on long projects** → two-row wrap once the project exceeds
  a length threshold (default: 5 minutes, exposed as
  `editor.timeline.minimapWrapThresholdMinutes`). Below the threshold,
  single row. Above, two stacked rows showing first half / second half
  of the project. The viewport rectangle is drawn on whichever row(s)
  the visible window covers; when the visible window straddles the
  midpoint, two rectangles are drawn (one per row) that move together
  during a drag. Add a settings toggle
  `editor.timeline.minimapWrapEnabled` (default true) so the user can
  fall back to single-row if the two-row layout gets in the way.

I'll wait for sign-off on the alternatives in §5 before starting
Phase 1.
