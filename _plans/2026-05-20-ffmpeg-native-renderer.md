# Plan: Native FFmpeg renderer replacing Remotion server-side renders

**Date:** 2026-05-20
**Branch target:** new branch off `phase-1-foundation`
**Author:** Claude (Opus 4.7), aligning with user

## Why this exists

Today's render pipeline runs through Remotion's `renderMedia` on Vercel.
The same Remotion composition powers the in-browser preview `<Player>`
and the server-side MP4 export. We've spent significant time debugging
why rendered MP4s come back missing animations, with fades that should
be off, and a file size that proves only the still-image path is
rendering. Multiple targeted fixes (scene-fade override, R2 URL probe,
same-origin video proxy) have not solved the core symptom that
`<OffthreadVideo>` silently produces empty frames on the Vercel runtime.

This plan replaces Remotion's `renderMedia` with a custom server-side
pipeline driven by FFmpeg. The in-browser preview keeps using Remotion's
`<Player>` (it works fine for preview), so creators see the same UX. The
EXPORT path becomes deterministic, debuggable, and owned end-to-end.

The user has approved this as the long-term solution, with the
local-render script (commit `4c66a1e`) covering the immediate need to
ship the current video.

## Goal

A renderer that takes the existing `VideoConfig` shape (the one
`productionDocToVideoConfig` already produces) and writes an MP4 with:

- Voiceover audio
- Background music (when present)
- Per-shot stills with Ken Burns animation
- Per-shot video clips (B-roll, "image-to-video" Kling clips)
- Section title stripes
- Lower-third on-screen-text overlays
- Burned-in captions
- Scene-to-scene cross-fades (configurable)
- Thumbnail-zoom scenes (the section-divider zoom feature)
- Real-image overlays (logo / brand mark composite)
- Doc-level text overlays
- Region-zoom padding (the slider from earlier today)
- Letterbox layout when sectionTitle + letterbox mode

That's roughly fifteen distinct visual concerns the current Remotion
composition handles. Each one needs FFmpeg equivalents OR a clear
"out-of-scope for v1" decision.

## Constraints (from the user)

- Build "robustly." Not a 2-day hack.
- Keep the existing in-browser preview (Remotion `<Player>`). Only
  REPLACE the export path.
- Continue to honor every user-facing setting that's already in the
  production-doc UI.

## Approach — three serious alternatives

### Alternative A: Pure FFmpeg filter graph

Compose the entire video via a single `ffmpeg` invocation with a
complex `-filter_complex` graph. Each input (audio, image, video clip)
becomes a labelled stream; overlays, fades, scales, and timing windows
chain together; one final mux to MP4.

- **Summary:** Single ffmpeg process. Everything declarative in a giant
  filter string.
- **Tradeoffs:** Hardest to debug. Filter graph syntax is unforgiving.
  Memory usage spikes for long videos with many clips. Errors are
  cryptic (`Error reinitializing filters! Error parsing filterchain...`).
  Best when the pipeline is small and stable. Worst when there are
  fifteen visual concerns and the user keeps adding controls.
- **Recommendation:** No. Will create a new maintenance nightmare.

### Alternative B: Multi-pass FFmpeg + intermediate files

Generate each scene as a standalone short MP4 with its own ffmpeg
invocation, then concatenate the scenes, then mux the master audio
track. Section title stripes, lower-thirds, and other overlays apply
to per-scene clips before concatenation. Cross-fades use ffmpeg's
`xfade` filter between adjacent scene clips during concat.

- **Summary:** Each scene becomes its own intermediate MP4. Concat at
  the end. Audio muxed last.
- **Tradeoffs:** Easier to reason about (per-scene isolation). Debugging
  is trivial — you can inspect each scene's MP4 individually. Disk usage
  is higher (need /tmp space for 81 intermediate scenes). More ffmpeg
  invocations adds startup overhead, but startup is fast (~50ms per).
  Cross-fades between scenes need careful frame-accurate timing at
  concat boundaries, but `xfade` handles it cleanly.
- **Recommendation:** This is the right architecture. Scene-by-scene
  composition matches how creators reason about the video, makes the
  code testable scene-by-scene, and the per-scene MP4 artifacts ARE the
  debug logs.

### Alternative C: Headless browser + canvas capture

Run a headless Chromium instance (Puppeteer or Playwright), navigate
to a hidden render route that mounts our existing Remotion composition,
and capture frames via the Web Codecs API or screencast → ffmpeg
encode.

- **Summary:** Keep the React composition, replace only the frame
  extraction layer.
- **Tradeoffs:** This is essentially what Remotion's renderer ALREADY
  does. If we hit issues with Remotion on Vercel, rolling our own
  headless-browser wrapper is unlikely to dodge them. Plus it's
  fragile (Chromium version pinning, font rendering differences, etc.).
- **Recommendation:** No. Same risks as today's Remotion path.

## Chosen approach: Alternative B

Per-scene intermediate MP4s, concatenated, then muxed with audio.

## Architecture

```
VideoConfig (existing shape, no changes)
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Scene compiler — pure TypeScript, no FFmpeg yet  │
│ Translates each shot into a SceneRecipe:         │
│   { sceneType, durationMs, inputs, overlays,     │
│     transitions, ... }                           │
└──────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│ FFmpeg scene executor — one per scene            │
│ Reads SceneRecipe, builds the ffmpeg command,    │
│ writes scene-<i>.mp4 to /tmp                     │
└──────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Concat assembler                                 │
│ Builds the concat list with xfade transitions    │
│ between adjacent scenes; writes video-only.mp4   │
└──────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Audio muxer                                      │
│ Mixes voiceover + music (ducked) into audio.mp3, │
│ mux with video-only.mp4 → final.mp4              │
└──────────────────────────────────────────────────┘
       │
       ▼
   R2 upload (existing code path)
```

Each step writes a real file. Each step is independently testable.
A failure at any stage leaves the intermediate output for inspection.

## Phases

### Phase 1 — Scene compiler + first scene type (b-roll with still + Ken Burns)

**Goal:** Render a SINGLE b-roll scene to MP4. No transitions, no audio,
no overlays. Just: take a still image URL, apply Ken Burns over N
frames at 30fps, write `scene-0.mp4`.

**Why first:** B-roll-with-still is the most common scene type in
production. If we can't get a clean Ken Burns scene out of ffmpeg, the
whole approach is in question. This is the riskiest unknown.

**Deliverables:**
- `src/lib/ffmpeg-renderer/types.ts` — `SceneRecipe` interface
- `src/lib/ffmpeg-renderer/compile.ts` — `compileScene(shot, ctx): SceneRecipe`
- `src/lib/ffmpeg-renderer/execute.ts` — `executeScene(recipe, outPath): Promise<void>`
- `src/lib/ffmpeg-renderer/kenburns.ts` — pure math producing the
  ffmpeg `zoompan` filter expression
- `tests/ffmpeg-renderer-kenburns.test.ts` — pure-math tests on the
  zoom-and-pan curves

**Exit criteria:**
- Given a `VideoShot` with `imageUrl` set + `durationMs: 5000`, the
  pipeline writes a 5-second 1920x1080 30fps MP4 with the image
  visibly zooming in.
- File size ~3-6 MB.
- Plays in VLC + browser without errors.

**Scope discipline:** No overlays. No audio. No transitions. Stop at
the working still + Ken Burns.

### Phase 2 — B-roll with video clip (Kling animations)

**Goal:** Same scene type but with `videoUrl` set. Fetch the video,
optionally apply playback rate to fit scene duration, write to
`scene-<i>.mp4`.

**Deliverables:**
- Extend `executeScene` to handle videoUrl branch
- Playback-rate calculation matching today's BRollScene logic
  (`effectiveClipSeconds / sceneSeconds`, clamped [0.5, 2.0])
- Handle the clip-shorter-than-scene case (freeze last frame OR loop —
  decide based on testing)
- Handle the clip-longer-than-scene case (trim)

**Exit criteria:**
- Given a `VideoShot` with `videoUrl` set + `durationMs: 7000`, the
  pipeline writes a 7s clip that visibly plays through the source
  video.
- This is the scene type that the current Vercel renderer fails on.

### Phase 3 — Audio tracks (voiceover + music)

**Goal:** Mix the voiceover audio + optional background music, mux into
the existing video-only output.

**Deliverables:**
- `src/lib/ffmpeg-renderer/audio.ts` — `mixAudio(voiceoverUrl, musicUrl, musicVolume)`
- Music ducking when voiceover is present (sidechain compressor in
  ffmpeg's `acompressor` + `sidechaincompress`)
- Mux with `-c copy` so video stream isn't re-encoded

**Exit criteria:**
- Final MP4 has voiceover audible.
- Music is present at ~12% volume under voiceover, normal between
  voiceover gaps.

### Phase 4 — Concat with cross-fades

**Goal:** Two scenes → one MP4 with optional cross-fade at the boundary.

**Deliverables:**
- `src/lib/ffmpeg-renderer/concat.ts` — `concatScenes(scenes, transitions)`
- Use `xfade` for cross-fades; concat demuxer for hard cuts
- Frame-accurate boundary timing (no off-by-one frame at cut points)

**Exit criteria:**
- A 3-scene test config with cross-fade between scenes 1↔2 and hard
  cut between scenes 2↔3 produces an MP4 where you can VISUALLY
  confirm the right transitions at the right times.
- doc-level `scene_fade_enabled: false` results in zero fades.

### Phase 5 — Overlays (lower-third, section title stripe, captions, text overlays, real-image overlay)

**Goal:** All the overlay surfaces the current composition supports.

**Deliverables:**
- `src/lib/ffmpeg-renderer/overlays.ts`
- Use ffmpeg's `drawtext` filter for text (lower-third, section title,
  captions, doc-level text overlays)
- Use `overlay` filter for image-based overlays (logo, real-image
  overlay)
- Letterbox layout: `pad` + `overlay` to put the stripe above a
  shrunken scene container
- Honor `suppressLowerThirds` flag (skip the lower-third overlay
  entirely when set)

**Exit criteria:**
- Toggle `suppressLowerThirds: true` → no lower-third bands in output
  (the bug we couldn't fix in Remotion).
- Letterbox layout matches today's Remotion output pixel-for-pixel.
- Burned-in captions appear at the right times with correct text.

### Phase 6 — Thumbnail-zoom scenes + region padding

**Goal:** The section-divider zoom feature (full thumbnail → animated
zoom into a marked region).

**Deliverables:**
- `src/lib/ffmpeg-renderer/thumbnail-zoom.ts`
- `zoompan` filter expression for the contain → region camera motion
- Honor the new `regionZoomPaddingPct` (15% default, from earlier
  today's work)
- Spring easing approximated with a piecewise-linear `zoompan`
  expression (ffmpeg doesn't have a real spring; approximate with
  3-4 keyframes for an easeOutCubic-ish curve)

**Exit criteria:**
- A doc with thumbnail-zoom scenes produces visibly correct camera
  motion onto the marked region.
- Padding slider at 0 / 15 / 50 produces visibly different framings.

### Phase 7 — Integration into the render route

**Goal:** Flip the render backend from Remotion to ffmpeg behind an
env flag.

**Deliverables:**
- Extend `selectRenderBackend()` in
  `src/app/api/render/video/route.ts` to recognize `RENDER_BACKEND=ffmpeg`
- Branch `startRender` into `startFfmpegRender(renderId, config)`
- Default the env var to `vercel` (current behaviour) so the flip is
  opt-in per environment
- Same `render_jobs` row updates as today (progress, output_url, error)

**Exit criteria:**
- Flipping `RENDER_BACKEND=ffmpeg` in a Vercel preview deployment
  produces a working MP4 with all features above.
- Production stays on Remotion until we've validated the ffmpeg path
  on a real video end-to-end.

### Phase 8 — Validation + cutover

**Goal:** Cut over once we have proof.

**Deliverables:**
- Side-by-side comparison: render the same VideoConfig through both
  backends, diff the output frames for unexpected differences
- Performance benchmark: render time, peak memory, /tmp usage on
  Vercel for an 81-shot 8-min video
- Cutover: change the default of `selectRenderBackend()` to
  `'ffmpeg'`. Remotion path stays in the code as a `RENDER_BACKEND=remotion`
  escape hatch for one release.

**Exit criteria:**
- ffmpeg path renders the failing project this whole session was
  about with all animations, no unwanted fades, all settings honored.
- Performance is acceptable (render time within 2x of Remotion's
  best-case, no memory crashes).

## Risk register

- **FFmpeg binaries on Vercel.** Vercel functions ship a recent ffmpeg
  but version drift can cause filter syntax to vary. We need to pin a
  specific ffmpeg via `@ffmpeg-installer/ffmpeg` or similar.
- **/tmp space.** 81 intermediate scenes × ~5 MB each = ~400 MB before
  concat. Plus the source video downloads. Plus the final output.
  Vercel functions have ~512 MB /tmp by default. We'll need to
  download-process-delete per scene rather than keep all intermediates
  in /tmp at once.
- **Function timeout.** 81 scenes × ffmpeg startup + render time could
  exceed Vercel's 300s. Lambda backend stays as the fallback if
  function execution time becomes the bottleneck.
- **ffmpeg filter graph complexity.** Spring easing, sidechain
  compression, multi-overlay composition — these are real ffmpeg
  features, but the syntax is unforgiving and errors are obscure.
  Phase 1 will tell us how bad the development experience is.

## Cost implications (per rule 8)

No new third-party services. ffmpeg is free. The render workload
moves from one Vercel function to another. Net Vercel cost should be
approximately the same — slightly less if the per-scene approach uses
less memory and finishes faster than today's Remotion path.

R2 egress is still free. Voiceover and broll URLs still resolve
through R2. Same media flow.

## Observability (per rule 14)

Each phase ships its own diagnostic logs:
- `[ffmpeg-renderer] scene compiled` — per-scene recipe summary
- `[ffmpeg-renderer] scene executed` — per-scene timing + output size
- `[ffmpeg-renderer] concat assembled` — final video-only.mp4 stats
- `[ffmpeg-renderer] audio muxed` — final.mp4 stats
- `[ffmpeg-renderer] ffmpeg error` — when ffmpeg exits non-zero,
  capture stderr + the offending command (sanitize URLs)

The intermediate per-scene MP4 files double as debug artifacts: when
a render fails, the per-scene outputs are inspectable individually.

## Security + safety (per rule 13)

- URLs passed to ffmpeg are quoted with `child_process.spawn` (not
  `exec`) and arguments are an array, never a shell-escaped string.
  Prevents command injection from a malformed videoUrl.
- ffmpeg processes have a hard timeout per scene (default 60s) to
  prevent a hung scene from holding the function open until the
  Vercel 300s limit.
- Intermediate /tmp files are unlinked after use even on error
  (`finally` block).
- No secrets in URLs make it to logs — same `slice(0, 120)` redaction
  pattern used elsewhere.

## Settings audit (per rule 15)

No new user-facing settings needed for v1. Every setting today is
honored by the new backend.

If creators want to tune ffmpeg quality (e.g., CRF for h264), expose
later via a "Render quality" doc-level setting (Draft / Standard /
High). Not in scope for v1.

## Open questions for the user

1. Are you on Vercel Pro? The 300s function timeout is the hard cap.
   8-minute renders with 81 scenes are at the edge. If we hit
   timeouts, we'll need Vercel Enterprise OR keep Remotion Lambda as
   the production renderer and use the ffmpeg path for shorter
   videos. Need to know your plan limits.
2. Is there an existing ffmpeg-on-Vercel pattern you've used before?
   If yes, what package (`@ffmpeg-installer/ffmpeg`, `fluent-ffmpeg`,
   raw `child_process.spawn`)?
3. After Phase 8 cutover, do you want Remotion's bundle removed
   entirely from server-side rendering (gain: smaller cold start), or
   kept as a fallback (gain: rollback safety)?

## Decision needed before Phase 1 starts

- Confirm Alternative B (per-scene → concat) is the right architecture.
- Confirm scope: every feature listed at the top is in v1, no
  drop-outs.
- Confirm phasing order: stills-with-Ken-Burns FIRST, then video clips.

Once those three are confirmed I start Phase 1.
