# 2026-06-07 — Channel-clone narrator-voice analysis + ElevenLabs cloning

A new pipeline stage and UI surface for channel-clone: listen to the
narrator on the uploaded / yt-dlp'd reference videos, describe the
voice in structured terms, generate a ready-to-paste ElevenLabs Voice
Design prompt, and offer a one-click Instant Voice Cloning button that
mints an ElevenLabs voice_id stored on the job.

User decision in chat: **"Both — prompt + one-click clone"**.

## Goals

1. **Always-on voice description.** After intake completes, the
   pipeline automatically extracts an audio sample from one reference
   video and produces a structured voice profile (gender, age range,
   pace, timbre, accent, energy, emotional register) plus a Voice
   Design prompt the operator can paste into ElevenLabs themselves.
   Zero ElevenLabs API spend. Always runs.
2. **Opt-in one-click cloning.** A `Clone this voice` button on the
   panel sends the audio sample to ElevenLabs Instant Voice Cloning
   and stores the returned `voice_id` + `name` on the job. Runs only
   when the operator presses it — never automatic.
3. **Visible result.** The panel surfaces (a) the structured voice
   profile so the operator understands what the model heard, (b) the
   paste-ready Voice Design prompt, (c) the `voice_id` after cloning
   with a copy button, and (d) the option to delete the cloned voice
   from ElevenLabs if they no longer want it.
4. **Honest cost surfacing.** Both the description stage's LLM spend
   AND the ElevenLabs character-spend get rolled into the existing
   `/api/channel-clone/jobs/[id]/cost` endpoint so the cost summary
   stays truthful.

## Non-goals

- **No automatic TTS.** We do not synthesise narration from the
  cloned voice as part of this plan. The operator can do that later
  via the existing narration / voiceover surfaces; here we only
  produce the `voice_id`.
- **No Professional Voice Cloning.** Instant Voice Cloning only.
  PVC needs longer training data (30+ minutes), a separate ElevenLabs
  flow, and weeks of asynchronous training — out of scope.
- **No audio storage beyond what's needed.** We keep one ~30-60s audio
  clip per cloned job in R2 (the clone payload). We do not archive
  the full narration audio.

## Constraints

### Cost (rule 8 — verified live 2026-06-07)

- **ElevenLabs Starter** ($6/mo, 30k credits ≈ 30 min TTS, **Instant
  Voice Cloning included**) is the minimum tier for this feature.
- **Creator** ($11–$22/mo, 121k credits ≈ 121 min, **adds Professional
  Voice Cloning**) is the smarter default if the user will also be
  doing TTS through ElevenLabs later. We surface both — operator
  picks their tier; we just need a valid API key.
- **Instant Voice Cloning itself costs 0 credits** to create. Credits
  are consumed only when you generate audio with the voice. Verified
  via the pricing page and tier matrix above.
- **Audio sample size**: 30s mono 16kHz MP3 ≈ 60 KB. Negligible R2.
- **LLM description stage**: one multimodal call (audio → structured
  JSON). Default model is `kie-gemini-2.5-flash` at $0.075 in / $0.30
  out per MTok — the cheapest **verified audio-capable** model in our
  registry. Estimate: < $0.005 per voice profile. See "Verification
  spike" below for the path to upgrading to `kie-gemini-3-5-flash`
  later if its audio support is confirmed.

### Security (rule 13)

- `ELEVENLABS_API_KEY` lives in Vercel env vars, NEVER on the client.
  The cloning button POSTs to `/api/channel-clone/voice/clone`; that
  route is the only thing that sees the key.
- Audio samples are owned by the workspace. The clone endpoint
  re-validates workspace ownership against the job row before
  uploading anything to ElevenLabs.
- Cloned voice records on the ElevenLabs side are tagged with
  `workspaceId` + `jobId` in their `description` field so we can
  detect orphans if the user deletes the job before deleting the
  voice.
- ElevenLabs requires a "voice ownership" attestation in their ToS
  (the operator must own the voice rights). We surface a checkbox
  before the one-click button that the operator must tick — same
  approach the ElevenLabs UI uses. Without the tick, the button
  stays disabled.
- The audio clip is uploaded to ElevenLabs over TLS via their REST
  API. After cloning succeeds, the local R2 copy stays for a 24-hour
  TTL (so the operator can re-clone if the first attempt was bad)
  then a lifecycle rule purges it.

### Tech-stack alignment (rule 1, rule 9)

- ElevenLabs API: REST + multipart upload at
  `POST https://api.elevenlabs.io/v1/voices/add` with `name`,
  `files`, `description`, and a `labels` JSON map. Returns
  `{ voice_id }`. **Verified via Context7** before writing the
  runner — schemas drift between versions.
- Audio extraction: `ffmpeg -i video -ss <start> -t 30 -ac 1 -ar 16000
  -b:a 32k sample.mp3`. Runs inside the existing intake sandbox so we
  don't spin up a second sandbox. Sandbox is destroyed at end of
  intake either way — we extract the audio BEFORE the destroy call.
- LLM stage uses our existing `generateText` / `generateObject`
  helper with structured-output schema. Per memory
  `feedback_model_defaults_user_owned.md`, **the user picks the
  default model**, not us. Plan exposes it under a new AppFeature
  `channel-clone-voice-profile` and lets the existing Settings →
  Model Defaults panel handle picker rendering.

### UX (rule 10, 16)

- The audio extraction silently runs as part of intake — no new
  button to press.
- The voice profile + Voice Design prompt show up as a new collapsed
  section on the run page, between the analyze result and the topics
  picker. Default-collapsed; not in the operator's way.
- The `Clone this voice` button shows EVENTUALLY (after the voice
  profile lands). It has three states:
  - **Empty** — "Clone this voice" with a tooltip explaining cost +
    ownership rules.
  - **Cloning** — spinner + "Uploading to ElevenLabs..."
  - **Done** — voice id, copy button, "Delete from ElevenLabs" link.
- Error states: API key missing → inline link to Settings, no spin.
  Quota exceeded → human-readable line ("Your ElevenLabs plan ran
  out of cloning slots — upgrade to Pro or delete an unused voice").

## Architecture

### Pipeline addition: a 9th LLM stage

Channel-clone today has 8 LLM stages (intake-summary through
publish-pack). We add a 9th: **voice-profile**. It runs once after
intake, in parallel with the existing analyze stage so it doesn't
block the operator's path to topics → hooks → script.

```
intake (sandbox) ─┬─→ analyze ─→ topics ─→ hooks ─→ script ─→ rowify ─→ publish-pack ─→ handoff
                  └─→ voice-profile ─→ (clone-on-demand)
```

Failure semantics: voice-profile is **best-effort**. If it fails
(e.g. all reference videos were silent), the rest of the pipeline
continues normally and the panel surfaces a one-line "voice profile
unavailable — re-run on a different video" message.

### Data model changes

`ChannelCloneJobState` (in [src/lib/channel-clone/types.ts](src/lib/channel-clone/types.ts)) gains:

```ts
voiceSample?: {
  /** R2 key of the 30-60s audio sample (mono 16kHz MP3). */
  r2Key: string;
  /** Source video id this came from (matches sampleVideos[].videoId). */
  sourceVideoId: string;
  /** Start offset within the source video, in seconds. */
  startSec: number;
  durationSec: number;
  bytes: number;
  extractedAt: string;
};
voiceProfile?: {
  /** Structured description the LLM produced. Renders as a table. */
  gender: 'male' | 'female' | 'androgynous';
  ageBracket: 'young-adult' | 'adult' | 'middle-aged' | 'senior';
  /** "moderate", "fast", "slow" — qualitative, not WPM. */
  pace: 'slow' | 'moderate' | 'fast' | 'variable';
  timbre: string;              // "warm baritone", "bright tenor", etc.
  accent: string;              // "general american", "rp british", etc.
  energy: 'low' | 'measured' | 'high';
  emotionalRegister: string;   // "wry, knowing, slightly detached"
  signatureMoves: string[];    // ["pauses for emphasis", "rising terminal"]
  /** Paste-ready ElevenLabs Voice Design prompt. */
  voiceDesignPrompt: string;
  modelUsed: string;
  analyzedAt: string;
};
clonedVoice?: {
  /** ElevenLabs voice_id returned by /v1/voices/add. */
  voiceId: string;
  name: string;
  /** Subscription tier in effect at clone time (Starter, Creator, etc.) —
   *  used to nudge the operator on capability headroom. */
  subscriptionTier: string;
  clonedAt: string;
  clonedBy: string;            // userId
};
```

### New AppFeature

`channel-clone-voice-profile` added to [src/lib/ai-models.ts](src/lib/ai-models.ts)
`APP_FEATURES` with `defaultModelId: KIE_GEMINI_FLASH`
(`kie-gemini-2.5-flash`). User-confirmed in chat 2026-06-07.

Why 2.5 Flash and not 3.5 Flash, despite 3.5 being newer:
- Google Gemini 3.5 Flash itself is audio-capable (text + image +
  video + audio + PDF input — verified via Google's docs).
- BUT our Kie wiring routes `kie-gemini-3-5-flash` through Kie's
  OpenAI-compatible alias `gemini-3-5-flash-openai` (see
  [src/lib/ai-models.ts:300-304](src/lib/ai-models.ts#L300-L304)).
  The OpenAI chat-completions content-part shape doesn't document
  audio input on Kie. Kie's Google-native docs for 3.5 Flash list
  only text + image + generic `file_data` — audio isn't called out.
- `kie-gemini-2.5-flash` is documented to handle audio via Google's
  native multimodal contract, AND it's 6× cheaper ($0.075/$0.30 vs
  3.5 Flash's $0.45/$2.70 per MTok). For an always-on stage this
  is the right default until 3.5 Flash audio is empirically verified.

### Verification spike (during implementation)

**RESULT 2026-06-07** — `kie-gemini-3-5-flash` accepts audio in TWO
of the three probed shapes:

- **A (Google-native `:generateContent` + `inline_data` with
  `mime_type: audio/mpeg`)** — 200 OK, `"The voice is female,
  speaking"`. This is what `voice-profile-runner.ts` uses.
- **B (Kie OpenAI-compat alias + `image_url` data URI carrying the
  audio mime)** — 200 OK, `"The voice is female, speaking at a
  moderate pace with a calm and professional energy"` — actually
  richer than A. The OpenAI alias supports audio undocumented.
- **C (Kie OpenAI alias + OpenAI `input_audio` content part)** —
  200 OK BUT the model replied "no audio file was attached." The
  wire shape was accepted but the bytes were silently dropped. NOT
  a working shape.

Decision: flip `channel-clone-voice-profile` default from
`kie-gemini-2.5-flash` to `kie-gemini-3-5-flash`. Cost climbs 6×
($0.075/$0.30 → $0.45/$2.70 per MTok) but the per-profile spend is
still under $0.01. The descriptions are visibly better.

Possible future cleanup: route the voice-profile call through
`ai.ts` using Variant B (image_url smuggle) so we don't have a
bespoke HTTP path in `voice-profile-runner.ts`. Out of scope for
this plan; tracked as a follow-up.

Spike script preserved at `scripts/diag-kie-3-5-flash-audio.ts` for
future regressions if Kie changes the wire shape.

### Files added

- `src/lib/channel-clone/extract-audio.ts` — pure ffmpeg wrapper:
  given a sandbox + ffmpeg path + input video path + start/duration,
  produces an MP3 buffer ready for R2 + ElevenLabs.
- `src/lib/channel-clone/voice-profile-runner.ts` — LLM stage:
  reads the audio sample from R2, calls the configured model with a
  structured-output schema, persists `voiceProfile` to the job state.
- `src/lib/channel-clone/elevenlabs.ts` — thin ElevenLabs REST
  wrapper. Three functions:
  - `cloneInstantVoice({ apiKey, name, mp3Buffer, labels })`
    → `{ voiceId }`.
  - `deleteVoice({ apiKey, voiceId })` → void.
  - `getSubscriptionTier(apiKey)` → `{ tier, charactersLeft }`.
- `src/app/api/channel-clone/voice/clone/route.ts` — POST handler
  for the clone button. Reads `jobId` + `voiceName` + `ownershipAck`
  from body, validates workspace ownership + ack, reads R2 audio
  into a buffer, calls `cloneInstantVoice`, persists `clonedVoice`.
- `src/app/api/channel-clone/voice/delete/route.ts` — POST handler
  for the delete link. Reads `jobId`, validates ownership, calls
  `deleteVoice`, clears `clonedVoice` from job state.
- `src/components/channel-clone/VoiceProfileCard.tsx` — UI surface.
  Three sub-states: profile only / clone-ready / cloned.
- `src/lib/channel-clone/voice-extract-during-intake.ts` — helper
  called inside both intake runners just before `destroyIntakeSandbox`
  / `destroyUploadSandbox`, picks a 30-60s window from the longest
  reference video, ffmpeg-extracts the MP3, uploads to R2 under
  `channel-clone-voice/<workspaceId>/<jobId>.mp3`.

### Files modified

- `src/lib/channel-clone/intake-runner.ts` + `intake-upload-runner.ts`
  — call `voice-extract-during-intake` after frame extraction, before
  destroy. Persist `voiceSample`.
- `src/lib/channel-clone/types.ts` — add the three new state fields.
- `src/lib/ai-models.ts` — add `channel-clone-voice-profile`
  AppFeature (pending user model-default confirmation).
- `src/components/channel-clone/ChannelClonePanel.tsx` — mount
  `<VoiceProfileCard />` between the analyze result and topics picker.
- `src/lib/migrations/index.ts` — no new SQL columns; the new fields
  live in the existing `state_jsonb`. JSONB is forgiving; existing
  jobs without the fields render the "voice profile unavailable"
  empty state.
- `src/app/api/channel-clone/jobs/[id]/cost/route.ts` — include
  voice-profile LLM spend; surface a separate `elevenlabsCharacters`
  counter (always 0 today because Instant Voice Cloning is free; non-
  zero once we wire TTS in a later plan).

### Sandbox lifetime

Audio extraction runs inside the existing intake sandbox after the
frame-extraction loop and before `destroyIntakeSandbox`/`destroyUploadSandbox`.
This adds ~5-10 seconds to intake wall-clock (one ffmpeg call). The
voice-profile LLM stage runs OUTSIDE the sandbox — by then the audio
is already on R2.

## Audio selection heuristic

Pick the source video with the longest transcript (proxy for spoken
narration). Within that video, pick a 30-second window starting at
10% of the duration — avoids the intro music + outro cards that
often blur the narrator. ffmpeg `-ss 10% -t 30` syntax handles the
percentage natively.

Edge case: if the picked window contains silence (memory:
`feedback_audio_verification.md` says don't infer audio from
alignment — actually probe it). Run `ffmpeg -af silencedetect=n=-30dB:d=2`
on the candidate window. If >50% silence, slide the window forward
by 30s and retry up to 3 times. Give up if no usable window found
(rare — long-form YouTube narration is dense).

## Settings (rule 15)

New section under Settings → Channel Clone:

- **ElevenLabs API key** — masked input (`sk_...` shown as `sk_••••••••`).
  Stored in `workspace_secrets` table, never echoed back to client.
- **Voice clone default name pattern** — text input, defaults to
  `Clone: {channelName}`. The `{channelName}` token is replaced at
  clone time from the job's `sourceChannelName`.
- **Auto-collapse voice profile card** — boolean, default true. Power
  user can flip it off if they want the profile visible by default.
- **Voice profile model** — picker that mirrors the Settings → Model
  Defaults panel pattern. Defaults to whatever the user picks; we do
  NOT hardcode a default in the registry without their say-so.

Intentionally NOT exposed:
- ElevenLabs cloning tier — we just read whatever the API key has
  access to. Surfacing a tier selector here would lie about what's
  available; the operator manages their tier on elevenlabs.io.

## Observability (rule 14)

New log namespaces:

- `[channel-clone voice-extract]` — `start`, `silence-detect`,
  `window-shifted`, `done`, `failed`.
- `[channel-clone voice-profile]` — `start`, `model-call`,
  `parsed`, `persisted`, `failed`.
- `[channel-clone voice-clone]` — `start`, `ownership-ack`,
  `elevenlabs-tier-probe`, `upload-start`, `done`, `failed`.
- `[channel-clone voice-delete]` — `start`, `done`, `failed`.

Each log includes `{ jobId, workspaceId, ... }`. The cloning logs
include the `voice_id` on success but NEVER the API key.

Frontend mirror: every state transition in `VoiceProfileCard.tsx`
emits `console.info('[channel-clone voice-card]', { state, jobId })`
per CLAUDE.md rule 14.

## Testing (rule 18)

Unit tests (Vitest, alongside existing channel-clone tests):

- `tests/voice-extract-audio.test.ts` — pure ffmpeg-arg construction
  + silence-detect parsing (no actual ffmpeg call; mock the runner).
- `tests/voice-profile-runner.test.ts` — JSON-schema parsing with
  hand-crafted model outputs; verifies the "voice profile unavailable"
  empty-state path triggers correctly on malformed output.
- `tests/elevenlabs-client.test.ts` — mocked `fetch` against
  `api.elevenlabs.io`; verifies multipart body construction, error
  mapping (401 → "API key invalid"; 429 → "rate limit"; 422 →
  "ownership ack required"), and that we never log the API key.
- `tests/voice-card-states.test.tsx` — React Testing Library:
  empty / clone-ready / cloning / cloned / error.

Integration: deferred until the user runs one channel-clone end-to-end
and confirms the audio sample is usable on a real reference video.
Per `feedback_audio_verification.md`, we don't claim the extraction
works until we've actually listened.

## Alternatives (rule 4)

### A — both stages (chosen, user-confirmed in chat)

Always-on description (cheap, always useful) + opt-in cloning (paid,
explicit operator action). Truthful about cost; fail-safe; the
operator can stop at the prompt and never touch ElevenLabs if they
don't want to.

### B — prompt only

Skip ElevenLabs integration entirely. Zero new env vars, zero API
spend, zero ownership-attestation UI. Cheapest path. **Rejected
because**: the user explicitly picked Both in chat. Documented here
so a future iteration can fall back if ElevenLabs becomes a problem.

### C — clone only

Skip the structured profile, go straight to cloning. Fastest path to
a usable voice_id. **Rejected because**: the structured profile is
free and offers a "tasting menu" before the operator commits cost.
Cloning without a description also leaves the operator guessing about
what they're getting — same complaint that drove rule 5 (don't ship
AI-generated outputs that look like a black box).

## Open questions for the user

1. **Voice profile model default** — RESOLVED 2026-06-07: default
   is `kie-gemini-3-5-flash` after the verification spike confirmed
   audio works (richer descriptions than 2.5 Flash; cost still
   negligible per run). User can override per-feature via Settings
   → Model Defaults.
2. **Voice naming pattern default** — `Clone: {channelName}` or
   something terser?
3. **R2 retention TTL for voice samples** — proposed 24 hours so the
   operator can re-clone if the first attempt was bad. Longer? Shorter?
   Indefinite (so the audio sample is part of the saved template in
   Plan 2)?
4. **Should the voice profile auto-run for legacy jobs** that ran before
   this plan ships? Proposal: no — surface a "Generate voice profile"
   button on legacy jobs so the user opts in per job (avoids surprise
   LLM spend on old jobs).

## Rollout

1. Schema additions to `types.ts` (no DB migration — JSONB).
2. Audio extraction helper + intake-runner / intake-upload-runner
   wire-up. Test against one local upload, verify the MP3 is real audio.
3. **Verification spike** — run `scripts/diag-kie-3-5-flash-audio.ts`
   against a 10s test clip; update plan with verdict; set the
   `channel-clone-voice-profile` feature's `defaultModelId` to either
   `kie-gemini-2.5-flash` (conservative) or `kie-gemini-3-5-flash`
   (if verified). Do NOT skip — landing the wrong default wastes
   either money (3.5 Flash @ 6× cost) or capability (2.5 Flash when
   3.5 is the better fit).
4. Voice-profile runner + LLM call + UI card (empty + profile states only).
5. ElevenLabs wrapper + clone/delete routes + UI clone button.
6. Settings → Channel Clone section.
7. Cost endpoint roll-up.
8. QA pass per rule 6 — golden path, no API key, expired key, quota
   exceeded, ownership ack unticked, silent reference video, all
   reference videos silent (give-up path).
