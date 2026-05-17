# 2026-05-17 — Scene minimum duration + tail buffer + estimated→aligned gap fill

**Status:** Approved, ready to implement
**Triggering bug:** User reported on the Morris Worm doc
(`scheduleItemId=8bb58d56-128e-43fe-8a91-9833dc01b8bf`) that the
opening title card "Morris Worm" disappears about a second in, while
the narrator is still mid-word, before the next scene cuts in.

Diagnostic chain (`scripts/diag-row1-timing.ts` + ffmpeg
`silencedetect` on the source MP3) established:

- The narrator **does** say "Morris Worm" — spoken from roughly
  **0.77 s to 1.44 s** in the audio (verified by silence detection
  on the file at `-40 dB`).
- ElevenLabs forced alignment **failed to map those two words** —
  the aligner skipped row 1's script entirely and placed its first
  matched word ("Screens") at 1.160 s. `alignRowsToWords` therefore
  returned row 1 as `source: 'estimated'` with the doc's 1000 ms
  fallback span.
- The renderer then plays row 1's scene from 0 → 1.0 s. Since "Worm"
  is still being spoken at 1.0 s, the audience sees the cut land in
  the middle of the word.

Two compounding root causes:

1. The forced aligner is unreliable on very short isolated phrases
   like two-word title rows. We cannot count on it to give us
   precise end-of-row timings for those.
2. There is no minimum scene duration and no gap-fill in the render
   pipeline, so an estimated row's wall-clock floor is whatever the
   AI-generated WPM estimate happened to produce — in this case,
   1000 ms, which is too short for any narrated title.

The durable fix must work regardless of alignment success on any
given row. It must also leave the audio playback untouched (shifting
audio would invalidate alignment caches and desync the rest of the
video).

## Goal

Every shot in the rendered video is on screen long enough to read /
absorb, with no dead-air gaps between consecutive shots, regardless of
whether forced alignment ran. Provide user-controllable defaults so
the bar can be tuned without code changes.

## Non-goals

- Renaming or removing the "Time" column in the production-doc table.
  Estimated timecodes stay as the AI's view of the doc; the renderer
  is what owns final timing.
- Forcing alignment to run earlier. The fix must work whether
  alignment is ready, missing, or partial.
- Per-row arbitrary durations editable from the table. That's a
  larger UI feature; the user picked the workspace-defaults design
  (Option A) over per-row overrides (Option B).

## Design

Three timing rules, applied in order during shot construction:

### 1. Gap-fill (renderer-level invariant)

When shot `i` is followed by shot `i+1` and `shot[i].endMs <
shot[i+1].startMs`, set `shot[i].endMs = shot[i+1].startMs`. No black
frames between two consecutive shots, ever.

Lives in `realignVideoConfig` because that's the only place gaps can
appear today (estimated-then-aligned pattern). `calcShotDurations`
already chains shots back-to-back via `next - start`.

### 2. Tail buffer (post-narration breathing room)

For shots whose timing came from alignment (`source: 'aligned'`),
extend `endMs` by `tailBufferMs` (default 400 ms). This is the
"narrator finishes a word and we still hold for a quarter-second"
buffer.

Applied in `realignVideoConfig`. The next shot's `startMs` is also
pushed forward by the same amount if it would otherwise overlap;
gap-fill rule (1) covers the cascading shifts.

Skipped for estimated shots — they have no narration end to pad past.

### 3. Minimum scene duration (visibility floor)

After 1 and 2, enforce `shot.durationMs >= minSceneMs` (default
2000 ms). If a shot is below the floor, extend its `endMs` to meet
the floor; subsequent shots whose `startMs` falls inside the extended
region are pushed forward.

Applied in `realignVideoConfig` (and on the estimated-only path, in
`calcShotDurations`, since it's also reachable via SSR).

### Why apply in `realignVideoConfig` rather than `calcShotDurations` alone

`calcShotDurations` already applies a 1500 ms floor — but
`realignVideoConfig` silently *replaces* that floor with the aligner's
output. The bug lives at this hand-off. The plan keeps
`calcShotDurations` for the no-alignment path and adds the same three
rules to `realignVideoConfig` so behaviour is identical regardless of
which path executed. The user picks the same numbers once.

### Resulting behaviour for the Morris Worm doc

Ground truth from ffmpeg silence detection on the source MP3:
- Narrator says "Morris Worm" from ~0.77 s to ~1.44 s.
- 200 ms silence between "Worm" and "Screens".
- "Screens" begins at ~1.64 s.

Pre-fix render state:
- Row 1 estimated `[0, 1000]` — cut lands mid-"Worm".
- Row 2 aligned `[1160, 18710]` (aligner placed "Screens" 480 ms
  early relative to actual onset, a known weakness).
- 160 ms dead-air gap between row 1's end and row 2's start.

Post-fix render state:
- After rule 1 (gap-fill): Row 1 endMs → 1160 (no gap).
- After rule 3 (min 2000): Row 1 endMs → 2000. Row 2 startMs pushed
  from 1160 → 2000.
- After rule 2 (tail buffer): Row 2 endMs → 19110.
- Audio is *not* shifted. Narrator's "Worm" finishes at ~1.44 s, the
  natural pause runs to ~1.64 s, then "Screens" begins under the
  title card and the visual cut to row 2's b-roll lands at 2.0 s.
  The audience hears ~360 ms of "Scre..." while the title is still
  on screen — a natural cross-fade, not a sync error.

If a future doc's narrated title runs longer than 2 s, the aligner
may still fail on it, and the floor alone won't be enough. The
fallback in that case is a per-project override (raise the floor or
set a custom row duration). That's why the override surface in the
production-doc header is part of this plan, not a follow-up.

## Defaults

- `minSceneMs = 2000`
- `tailBufferMs = 400`

Source: user picked the "Recommended" tier from the alternatives
prompt. These are workspace-defaultable and per-project overridable.

## Settings UI (rule 15)

### Workspace defaults

Add to `src/app/(app)/settings/page.tsx`, under a new "Video timing"
group (alongside the existing style / B-roll defaults). Two number
inputs with sensible bounds:

| Field | Type | Default | Bounds | Help text |
|---|---|---|---|---|
| Minimum scene duration | number (ms) | 2000 | 500–10000 | Every scene stays on screen for at least this many ms, even if narration is shorter. |
| Tail buffer after narration | number (ms) | 400 | 0–3000 | Extra hold time after the narrator finishes the row's words. Prevents cuts mid-breath. |

Persisted via a new endpoint `POST /api/user/settings/video-timing`
(mirrors the existing default-style / broll-default pattern). DB:
add two NULL columns to whichever table holds per-user prefs (the
existing settings page reveals the pattern — copy it). NULL means
"use the system default" (2000 / 400).

### Per-project override

In the production-doc page header (where `speaking_pace_wpm` already
lives), add a small two-input control labelled **"Scene timing"**
showing both numbers with the workspace default as placeholder. The
override lives on the production doc itself: `doc.min_scene_ms?` and
`doc.tail_buffer_ms?`, persisted in `user_history.payload.doc.*`.

The renderer (`productionDocToVideoConfig`) reads:
- per-project override if set,
- else workspace default fetched at page mount,
- else system default 2000 / 400.

## Observability (rule 14)

Namespace: `[render-timing]`. Logs added in three places:

1. **`productionDocToVideoConfig`** — once per call:
   `console.info('[render-timing] config built', { rowCount, alignmentPresent, minSceneMs, tailBufferMs })`
2. **`realignVideoConfig`** — once per call:
   `console.info('[render-timing] realigned', { aligned, estimated, gapFilledRows, floorAppliedRows, bufferAppliedRows })`
3. **`calcShotDurations`** — once per call:
   `console.info('[render-timing] shot durations', { rowCount, minSceneMs, minHits })`

Server-side equivalents use the existing `logger.info` wherever the
function is called from a route handler. Logged values are *actual
values, not just events* (per rule 14): per-row before/after for the
first 5 rows.

## Security (rule 13)

- Settings POST: gated by the existing user session middleware. No
  new attack surface — same auth as the other `/api/user/settings/*`
  routes.
- Per-project override is stored inside the doc JSON that the user
  already owns; no privilege boundary crossed.
- Numeric inputs validated server-side (`min/max`) and client-side.
  No string fields means no injection vector.
- No PII added.

## Files to touch

| File | Change |
|---|---|
| `src/remotion/utils.ts` | Add `minSceneMs` / `tailBufferMs` to `ProductionDocToVideoConfigOptions`. Thread through `calcShotDurations` and `realignVideoConfig`. Add the three rules. Add the namespaced logs. |
| `src/remotion/Root.tsx` (or composition) | Plumb the new options through if a code path constructs `VideoConfig` directly. |
| `src/lib/voiceover-alignment.ts` | Optional: surface `gapFilledRows` etc. as part of `AlignedRow[]` for the logs. (May not be needed — the logger can count from before/after diff.) |
| `src/app/(app)/production-doc/page.tsx` | Add per-project override controls in the header. Pass `minSceneMs` / `tailBufferMs` into the `productionDocToVideoConfig` call site(s). Persist override in the doc payload. |
| `src/app/(app)/settings/page.tsx` | Add "Video timing" section with the two inputs. |
| `src/app/api/user/settings/video-timing/route.ts` (new) | GET/POST workspace defaults. |
| `src/lib/migrations/0070_add_video_timing_settings.ts` (new) | Add two NULL columns to the user prefs table (look up which one — current default-style/broll-default uses the same one). |

## Effort

| Step | Effort |
|---|---|
| Migration 0070 | 10 min |
| `realignVideoConfig` + `calcShotDurations` changes + logs | 45 min |
| Settings endpoint + UI | 30 min |
| Per-project override in production-doc header | 30 min |
| QA pass | 30 min |
| Re-verify on the Morris Worm doc | 10 min |

**Total: ~2.5 hours.**

## QA checklist (rule 6)

1. **Morris Worm doc**: re-render → row 1 holds for 2.0 s, no black
   gap, narrator audio plays naturally underneath. The cut to row 2's
   b-roll lands at exactly 2.0 s.
2. **Long-row doc** (any row whose aligned duration > minSceneMs):
   floor is a no-op; tail buffer extends `endMs` by 400 ms; next
   row's `startMs` shifts by the same.
3. **No-alignment doc**: estimated-only path uses `calcShotDurations`
   with the same numbers. Every row ≥ 2000 ms.
4. **Per-project override**: setting min to 3000 / tail to 0 on one
   doc affects only that render, leaves workspace default unchanged
   and other docs unchanged.
5. **Workspace default change**: changing the workspace default does
   not retroactively re-render existing videos; takes effect on the
   next render of any doc without an override.
6. **Bounds**: setting min = 0 in the UI clamps to 500; setting
   tail = 10000 clamps to 3000. The server-side validator must
   match (defense in depth).
7. **Regression**: a doc that's already perfectly aligned (no gaps,
   every row > 2 s, no narration cuts) renders identically except
   for the +400 ms tail buffer cascading the final shot's endMs.
8. **Empty doc / one row**: doesn't crash. Single-row video is its
   own start-to-end; floor applied; tail buffer applied.
9. **Logs**: open DevTools, render once with alignment, render once
   without — both produce `[render-timing]` lines naming the per-row
   numbers.

## Decision log

- **Apply rules in `realignVideoConfig` not just `calcShotDurations`.**
  The bug lives at the alignment hand-off. Belt-and-braces is fine;
  the function is pure and idempotent.
- **Don't shift the voiceover audio.** Pushing audio to match
  extended title cards desyncs everything downstream and breaks the
  existing alignment cache. The renderer holds visuals, audio plays
  at its native offset.
- **Tail buffer doesn't apply to estimated rows.** They have no
  narration end to anchor; the floor + gap-fill handles them.
- **Defaults 2000 / 400** chosen from the user's "Recommended" pick
  in the alternatives prompt. Bounded so a misconfigured workspace
  can't disable the protection entirely (min ≥ 500, tail ≥ 0).
- **NULL = workspace default; absent override = NULL.** Standard
  three-level fallback (system → workspace → project).
- **No new table.** Two NULL columns on the existing user prefs
  table are enough; matches default-style / broll-default pattern.
- **Diagnostic script stays in `scripts/diag-row1-timing.ts`.** It
  was useful for this triage and will be useful again whenever a
  reviewer reports "scene N is too short / too long" — generic
  enough to handle any schedule item.

## Cost (rule 8)

Zero direct cost. No new paid API calls; no extra storage beyond two
INTEGER columns. Rendering an extra few seconds per video is
already covered by the existing Remotion budget — for the Morris
Worm doc, total duration goes from 7:59 to ~8:01 (rounding up only
the rows whose floors actually fired).
