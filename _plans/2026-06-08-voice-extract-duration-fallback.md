# 2026-06-08 — Voice-extract duration probe + transcript fallback

## Symptom

User uploaded 7 sample videos to channel-clone. The voice-extract step
gave up immediately with logs:

```
[VOICE-EXTRACT] no further candidate windows fit inside video
                startSec=0 videoDurationSec=0
[VOICE-EXTRACT] chosen source video
                title="What If WE Are The Aliens?" videoId=upload-7
                durationSec=0 transcriptWords=1996
[VOICE-EXTRACT] no usable window found in chosen video — giving up
```

The user pointed out the obvious: all 7 videos contain voice from
second 0 onwards. So nothing's actually wrong with the audio.

## Root cause — silent failure on the duration probe

Voice-extract's window-fitting guard at
[voice-extract-during-intake.ts:103-111](src/lib/channel-clone/voice-extract-during-intake.ts#L103-L111):

```ts
while (attempt < MAX_WINDOW_ATTEMPTS) {
  const startSec = initialStartSec + attempt * WINDOW_SLIDE_STEP_SEC;
  if (startSec + WINDOW_DURATION_SEC > chosen.durationSec) {
    log.warn('voice-extract', 'no further candidate windows fit inside video', { startSec, videoDurationSec: chosen.durationSec });
    break;
  }
  // ... encode + silence-probe
}
```

When `chosen.durationSec === 0` (the chosen sample video's video-level
duration) the very first check `0 + 30 > 0` fires and the loop exits.
The silence check never even runs.

Upstream, `probeDurationSec` at
[intake-upload-runner.ts:475](src/lib/channel-clone/intake-upload-runner.ts#L475)
parses ffmpeg's stderr with a strict regex requiring exactly two
fractional-second digits:

```ts
const m = /Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/.exec(probe.stderr);
if (!m) return 0;
```

For uploads where ffmpeg emits `Duration: 00:13:18.5,` (one decimal)
or `Duration: 00:13:18,` (no decimal) or `Duration: N/A,` (some
re-encoded files), the regex misses, the function silently returns 0,
and the caller's `.catch(() => 0)` re-wraps any thrown error as 0 too
— so the silent-zero propagates with no diagnostic in the log.

## Fix

Two layers:

### Layer 1 — robust pure parser + diagnostic log

New helper `src/lib/channel-clone/parse-ffmpeg-duration.ts`:

- `parseFfmpegDuration(stderr)` accepts 1-2 digit field widths and
  0-6 digit fractional seconds. Returns `{ seconds: number | null,
  matchedText: string | null }`. Explicit `Duration: N/A` recognition
  with `seconds: null`.
- `estimateDurationSecFromWords(wordCount)` returns
  `Math.round(wordCount / 150 * 60)` seconds — a moderate speaking
  pace fallback.

The thin runtime wrapper in `intake-upload-runner.ts:probeDurationSec`
now calls `parseFfmpegDuration` AND logs the ffmpeg stderr tail when
parsing fails, so the next time something weird shows up we see it
instead of staring at `durationSec=0`.

### Layer 2 — transcript-derived fallback at the intake call site

When the probe returns 0 but the operator pasted a transcript, fall
back in this order:

1. If the transcript was SRT-cleaned, use `transcript.durationSec`
   (cleanCaptions stamps it from the last cue's startSec).
2. Otherwise use `estimateDurationSecFromWords(transcript.wordCount)`.

For the user's reported case: 1996 words / 150 wpm × 60 = 798 seconds.
voice-extract's `initialStartSec = floor(798 × 0.1) = 79`. The window
check `79 + 30 = 109 < 798` passes, the encode + silence probe
proceed.

## Files

- `src/lib/channel-clone/parse-ffmpeg-duration.ts` — new pure helpers.
- `src/lib/channel-clone/intake-upload-runner.ts` — `probeDurationSec`
  rewired to the helper + transcript fallback at the call site.
- `tests/parse-ffmpeg-duration.test.ts` — 15 cases pinning the parser
  + estimator behaviour, including the exact regression patterns.

## Observability

New / improved log lines:

- `[intake] ffmpeg duration probe returned no usable value` with
  `{ videoSandboxPath, exitCode, matchedText, stderrTail }` — fires
  when the parser can't find a real duration.
- `[intake] duration falling back to transcript timestamp` — fires
  when SRT was provided and we use the cue-derived duration.
- `[intake] duration falling back to word-rate estimate (150 wpm)` —
  fires for plain-text transcripts (the user's exact case).

## Re-run note

This change only affects FUTURE intake runs. Existing jobs that
already failed with `durationSec=0` need to be re-uploaded — the
captured `voiceSample: null` on the job state isn't auto-retried.

## Out of scope

- Per-video silence-probe sensitivity tuning. The current 50%
  threshold is a separate knob; we won't touch it without a real
  reproduction case.
- Defense-in-depth inside voice-extract itself (treat
  `durationSec === 0` as "try anyway"). The intake-side fix covers
  every realistic case the user reported; we'll add the inner guard
  only if a transcript-less upload starts failing in production.
