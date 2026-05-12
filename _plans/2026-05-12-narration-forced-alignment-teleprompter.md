# 2026-05-12 — Narration forced-alignment teleprompter + comment-at-timestamp

## Goal

In the project workspace **Narration** tab, when a reviewer plays back the
narrator's full-audio MP3, the corresponding script text scrolls and
highlights word-by-word in true sync with the audio — driven by real
word-level timestamps from forced alignment, **not** by guessing word
positions across the duration. At the same time, the reviewer can pause
anywhere and leave a comment pinned to that exact moment for the narrator.

Today's [src/components/narrator/ScriptFollow.tsx](../src/components/narrator/ScriptFollow.tsx)
already has a "Teleprompter" mode, but it spreads words evenly across the
audio duration — a guess that drifts badly the moment the narrator pauses,
re-takes a line, or speaks at uneven pace. This plan replaces that timing
source with ground-truth word timings from
[ElevenLabs Forced Alignment](https://elevenlabs.io/docs/api-reference/forced-alignment/create),
which accepts the audio + the known script and returns per-word + per-character
start/end times plus a confidence loss score.

## Out of scope

- Changing the narrator-side upload flow (still presigned R2 PUT into
  `narrator_takes`, no change).
- Per-section take alignment. Only the **full-audio take** (the
  `section_number = 0` synthetic row on `narrator_takes`) is aligned in this
  phase. Per-section takes keep the existing player.
- Replacing the current
  [AudioPlayer](../src/components/narrator/AudioPlayer.tsx) /
  [ScriptFollow](../src/components/narrator/ScriptFollow.tsx) /
  [TakeReview](../src/components/narrator/TakeReview.tsx) trio. The new
  unified player **sits alongside** behind a per-user toggle so the owner can
  A/B before we delete anything (per user direction).
- Hebrew / RTL support. Codebase has no Hebrew signals in the narrator
  workflow; English-only confirmed.
- Self-hosted alignment infrastructure (WhisperX etc.). At <5h/mo of audio,
  baseline GPU server cost dwarfs the $1/mo API spend. Reconsider only if
  volume scales 100× or data-residency constraints emerge.

## Constraints

- Use the existing `ELEVENLABS_API_KEY` env var (already wired across
  [src/lib/elevenlabs.ts](../src/lib/elevenlabs.ts) and six API routes). No
  new keys, no new vendor account.
- Use raw `fetch` with the `xi-api-key` header — match the existing pattern
  in [src/lib/elevenlabs.ts](../src/lib/elevenlabs.ts). Do **not** add
  `@elevenlabs/elevenlabs-js` as a dependency. (CLAUDE.md rule 2: match the
  file's existing structure.)
- Reuse [WaveformPlayer](../src/components/narrator/WaveformPlayer.tsx) and
  the existing take-comment table for timestamp comments. Do not rebuild
  the comment system.
- Migration must be additive (new columns only on `narrator_takes`), default
  status `pending`, backfill existing rows in-place. No destructive schema
  changes.
- Function timeout: stay within the existing `maxDuration = 300` envelope
  used by [stitch route](../src/app/api/narrator/assignments/[id]/stitch/route.ts).
  ElevenLabs forced alignment on a 14-min MP3 finishes well under 60s in
  practice, so we run inline from the alignment route.

## Approach

### Data model (migration 0051)

Add three columns to `narrator_takes` (the table that already holds both
per-section takes and the synthetic `section_number = 0` full-audio take):

- `alignment_json` `JSONB NULL` — raw ElevenLabs response. Stored as-is so
  we can re-derive section-level slicing without a re-call.
- `alignment_status` `TEXT NOT NULL DEFAULT 'pending'` —
  `pending | running | ready | failed`.
- `alignment_error` `TEXT NULL` — short error string when status is
  `failed`. (No stack traces; surfaced to the user.)

Re-upload invalidation: the existing `full-audio` upload route resets the
take's status back to `pending` and clears `alignment_json` /
`alignment_error`.

### Alignment client

Add `forceAlign({ audioUrl, text })` to
[src/lib/elevenlabs.ts](../src/lib/elevenlabs.ts) — slots in next to
`getVoices` / `generateVoiceover`, keeping the file's structure clean (rule
2). Fetches the audio server-side from the R2 presigned URL, posts
`multipart/form-data` with `file` + `text` to
`https://api.elevenlabs.io/v1/forced-alignment`, returns the parsed
response. Production cues (`[pause]`, `[excited]` etc.) are stripped via the
existing `stripProductionCues()` helper before being sent, then re-injected
for display only.

### Trigger

New route: `POST /api/narrator/assignments/[id]/align`. Reads the take's
audio URL and the assignment's full script (concatenated section text),
calls `forceAlign`, writes `alignment_json` + flips status to `ready`. Fired
fire-and-forget from the existing `full-audio` upload completion (same
pattern as the existing fire-and-forget email send in `approve-full/route.ts`).
Also reachable as a manual "Retry alignment" button from the Narration tab
when status is `failed`.

### Storage of derived word offsets

The ElevenLabs response gives global timestamps over the full audio. The
Narration tab needs to know which word belongs to which section. We do this
**at read time** in a small pure helper `sliceAlignmentToSections(alignment,
sections)` that maps each word back to its source section by matching
character offsets in the original script text. No additional DB column —
keeps the data model lean.

### UI — the new unified player

New component
`src/components/narrator/NarrationReviewPlayer.tsx`:

- Top half: scrollable script with per-word `<span>` elements. The active
  word (whose `[start, end]` contains `currentTime`) gets a high-contrast
  highlight; recently-spoken words get a muted "already said" treatment;
  upcoming words are at normal opacity. Click any word → seeks the audio to
  `word.start`. The active section auto-scrolls into view. Words with
  high alignment `loss` get a subtle underline (lazy-user lens: gives the
  reviewer an instant visual cue of "narrator probably misread here, listen
  closely").
- Bottom half: existing `WaveformPlayer` with comment pins and the existing
  "click waveform to add comment" affordance — both halves share one HTMLAudioElement
  via a ref, so there's one playhead and one source of truth.
- Pause behavior: when paused, a "Comment on this word" affordance appears
  directly under the active word — clicking it opens the existing comment
  modal pre-filled with `start_time = word.start`. Writes to the existing
  `narration_take_comments` table (migration 0006).
- Fallback: if `alignment_status !== 'ready'`, the component renders the
  current behavior (no highlight, just plain text + waveform) plus a small
  status badge: "High-accuracy sync still loading" / "Sync unavailable —
  retry?".

### A/B placement

In [src/components/narrator/NarrationTab.tsx](../src/components/narrator/NarrationTab.tsx),
add a per-user toggle (localStorage-backed, no DB column) above the
full-narration card:
`[Classic player] [New synced player (beta)]`. Default = classic, so
existing behavior is untouched for everyone until the owner opts in. When
the new player is selected, it replaces the `AudioPlayer` + `ScriptFollow`
block within that card; everything else (per-section grid below) is
unchanged.

## Rejected alternatives

- **OpenAI Whisper word-timestamps + script-reconciliation merge.** Same
  monthly cost, but pure ASR drifts from the canonical script on proper
  nouns, contractions, and punctuation — the exact words the reviewer most
  cares about. We'd own a Levenshtein/DP merge layer indefinitely.
  Rejected.
- **Deepgram / AssemblyAI ASR with keyword/term boosting.** Same drift
  problem. The `keyterm` boost helps recognition but does not lock the
  output to the script. Rejected.
- **WhisperX self-hosted on a GPU box.** Best accuracy ceiling and zero
  per-minute fees, but adds a GPU instance + container + secrets + monitoring
  surface for a feature that costs ~$1/mo via API. Rejected for current
  volume; reconsider at 100+ videos/mo or with data-residency requirements.
- **Replace the existing player outright in one PR.** Faster to ship but
  the user explicitly asked for an A/B period. Rejected by direction.

## Security (CLAUDE.md rule 13)

- **Secrets.** `ELEVENLABS_API_KEY` stays server-side only; never sent to
  the browser. Alignment route runs on the server. Matches the existing
  pattern in [generate/route.ts](../src/app/api/elevenlabs/generate/route.ts).
- **Audio access.** The aligner fetches the audio from R2 via a short-lived
  presigned URL minted server-side. The browser never sees the unsigned
  object key. Matches existing R2 access in `narrator-db.ts`.
- **AuthZ.** The new `/api/narrator/assignments/[id]/align` route reuses
  the same project-membership check used by the existing
  `narrator/assignments/[id]` endpoints. Reviewers without project access
  cannot trigger alignment.
- **PII.** No PII is sent to ElevenLabs beyond the script text the narrator
  already produced. The audio is the narrator's own recording — not third-
  party content. Document this in the project's privacy notes if/when one
  exists.
- **Failure surface.** On failure, the recorded `alignment_error` is a
  short human-readable string ("ElevenLabs returned 503", "audio fetch
  timed out") — no API key, no full URL with signing params, no stack
  traces. Browser sees only `failed` status + the short string.
- **Rate / cost cap.** A soft monthly spend ceiling (env var
  `ELEVENLABS_ALIGNMENT_BUDGET_USD`, default `5`) is checked before each
  call; over budget = mark `failed` with reason `"monthly alignment budget
  exceeded"` and surface in the existing admin
  [key-status endpoint](../src/app/api/settings/key-status/route.ts).

## Cost (CLAUDE.md rule 8)

ElevenLabs forced alignment is billed under the Scribe STT tier at
**$0.22 / hour** (~$0.0037 / minute). Verified May 2026 on
<https://elevenlabs.io/pricing/api>. At the user's stated ceiling of
~20 videos × ~14 min ≈ 280 min/month, monthly spend is approximately
**$1.04 / month**. Re-runs (e.g., retry after failure) are billed again —
the soft budget cap above guards against runaway loops.

## UX walkthrough (lazy-user lens — CLAUDE.md rule 10)

1. Reviewer opens project → Narration tab. New badge near the player:
   `Classic ⏵ Synced (beta)`. Defaults to classic — no surprise.
2. Reviewer flips the toggle. The "Full narration" card swaps to the new
   layout: script text on top with section headings, waveform underneath.
3. Reviewer hits play. The active word lights up; the script scrolls so
   the active word stays in view. Easy to verify "yes, the narrator said
   exactly this here."
4. Reviewer hears a misread → hits pause. A small "Comment on this word"
   chip appears over the active word. Click → existing comment modal opens
   with the timestamp pre-filled. Type → submit → comment pin appears on
   the waveform.
5. Reviewer clicks a different word later in the script. Audio seeks
   there. No fiddling with the waveform.
6. Edge: narrator re-uploads. On next page load, status shows "Sync
   updating…"; once alignment finishes (seconds for a 14-min file) the
   player picks up the new timings automatically.
7. Edge: alignment failed. Player still works (classic behavior) and shows
   "Sync unavailable — retry?" with a one-click retry. Reviewer is never
   blocked.

## QA checklist (CLAUDE.md rule 6)

Golden path:

- [ ] Upload full audio → alignment runs automatically → status flips to
      `ready` within a minute for a 14-min file.
- [ ] Toggle to "Synced (beta)" → words highlight in time with playback.
- [ ] Click a mid-script word → audio seeks within 100ms.
- [ ] Pause → comment chip appears over active word → submit comment →
      pin appears on waveform → narrator-facing view shows the comment
      with the correct timestamp.

Edge cases:

- [ ] No alignment yet (`pending`) → player shows badge + falls back to
      classic behavior; no errors.
- [ ] Alignment `failed` → retry button works; one retry doesn't double-
      bill (status guard).
- [ ] Re-upload → previous `alignment_json` cleared, new alignment runs.
- [ ] Long silences / `[pause]` cues → display preserved, alignment still
      maps correctly (cues stripped before alignment, re-injected for
      render).
- [ ] Section split is correct: words near a section boundary land in the
      right section.
- [ ] Audio file >25 MB (long high-bitrate MP3) → still aligns (ElevenLabs
      cap is much higher than OpenAI's). If we ever hit a cap, surface
      `failed` with a clear reason.
- [ ] Two browser tabs open → no double-trigger of alignment (status
      `running` guard).
- [ ] Budget cap exceeded → alignment marked `failed` with the budget
      reason; admin sees the flag.

Regressions in adjacent code:

- [ ] Classic player still works exactly as before when toggle is off.
- [ ] Per-section take review (the section grid below) is untouched.
- [ ] `WaveformPlayer` keyboard shortcuts still work inside the new
      unified player.
- [ ] Existing comments on the take render in both classic and synced
      views (one comment table, two readers).

## Open questions

None at plan-write time. All three pre-plan questions resolved with the
user:

1. ElevenLabs API key — already in Vercel env as `ELEVENLABS_API_KEY`. ✔
2. Ship in one pass (alignment pipeline + storage + UI together). ✔
3. New player sits alongside the existing one behind an A/B toggle. ✔

## Implementation order

1. Migration 0051 (additive columns on `narrator_takes`).
2. `forceAlign()` helper in `src/lib/elevenlabs.ts` + tests.
3. `POST /api/narrator/assignments/[id]/align` route + budget cap +
   fire-and-forget trigger from full-audio upload completion.
4. `sliceAlignmentToSections()` pure helper + tests.
5. `NarrationReviewPlayer.tsx` component (teleprompter + waveform + comment
   chip).
6. Toggle wiring + localStorage key in `NarrationTab.tsx`.
7. QA pass per checklist above.
