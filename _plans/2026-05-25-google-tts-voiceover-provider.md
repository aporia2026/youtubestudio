# Google Cloud Text-to-Speech as a second voiceover provider

**Date:** 2026-05-25
**Status:** Approved, ready for execution
**Owner:** Yoav (info@flexelent.com)
**Branch target:** `claude/video-creation-ui-pqXzS`

## Goals

Add Google Cloud Text-to-Speech alongside ElevenLabs everywhere the project currently generates voiceovers. The user-visible promise: pick a provider, pick a voice, get audio — same flow, more choice, dramatically lower cost on the cheap tiers.

Concrete success criteria:
1. User can generate a voiceover with Google TTS in all four current surfaces (voiceover studio, editor regenerate, shorts voiceover, auto-pipeline) without re-entering credentials per request.
2. Google voiceovers play correctly in the editor with word-level highlighting (the alignment-driven teleprompter must work).
3. All six exposed Google tiers (Standard, WaveNet, Neural2, Polyglot, Chirp 3 HD, Studio) are selectable, with current price visible to the user.
4. Existing ElevenLabs voiceovers continue to work unchanged. No regressions in existing flows.
5. Per-asset provider + voice version are persisted, so re-renders are deterministic even if a vendor deprecates a voice.

## Constraints

- **Tech stack:** Next.js 15 App Router, R2 storage, Postgres with auto-applied migrations on Vercel deploy. Existing alignment cache lives in `voiceover_alignments`.
- **No `_plans/*.md` placeholders:** every claim in this plan is verified against current code (per the explore-agent map) or live docs (pricing + SDK fetched 2026-05-25).
- **Hebrew matters:** the user ships Hebrew content. All Google tiers support `he-IL`. Hebrew synthesis quality has already been verified by the user (2026-05-25) — works perfectly. Word-timing alignment via Google STT on Hebrew output will be smoke-tested as part of the standard QA pass, but is no longer a blocking risk.
- **No service-account JSON on disk, ever.** Credentials come from env vars only.
- **No new top-level migration system needed:** `media_assets.metadata` is JSONB; new fields land without a migration. The `voiceover_alignments.cache_key` already hashes inputs, so adding `provider` into the hashed payload is enough — no schema change there either.

## Requirements

| # | Requirement | Why |
|---|---|---|
| R1 | Provider abstraction (`Synthesizer` + `Aligner` contracts) | Avoid 12 hardcoded call sites for the second integration; let alignment swap independently of synthesis. |
| R2 | Per-asset `provider` + `voiceId` + `voiceVersion` in `media_assets.metadata` | Deterministic re-renders even if a voice is deprecated. |
| R3 | Per-workspace default provider + voice for auto-pipeline | Auto-pipeline can't prompt the user mid-run; it needs a stored preference. |
| R4 | Cost shown in plain language (per minute, not per million chars) | UX bar from rule 16 + rule 10. |
| R5 | Per-generation `costUsd` persisted in `media_assets.metadata` | Foundation for usage analytics, billing, caps. |
| R6 | Studio tier gated behind explicit workspace opt-in | $160/1M chars × auto-pipeline batch = four-figure surprise bill. |
| R7 | All Google credentials via env vars (no JSON file) | Security. The pasted service-account JSON has already been compromised and must be rotated; the new key never touches the filesystem. |
| R8 | Same MP3 output flow as ElevenLabs (R2 storage, `media_assets` row) | Reuse the existing audio playback, library, dubbing, and editor wiring. |
| R9 | Voice picker stays usable for non-technical users | Picker is grouped by language → quality tier → voice character. Provider name is secondary metadata, not the primary axis. |

## Approach

### Architecture overview

```
                              ┌──────────────────────────┐
                              │   tts/dispatch.ts        │
                              │                          │
   API routes / pipeline ────►│   synthesize(req): Audio │──────► R2 + media_assets
                              │   align(req): Timings    │──────► voiceover_alignments
                              └────────┬─────────────────┘
                                       │ providerId
                          ┌────────────┴────────────┐
                          ▼                         ▼
            ┌──────────────────────┐    ┌──────────────────────┐
            │ providers/elevenlabs │    │ providers/google     │
            │  - Synthesizer ✓     │    │  - Synthesizer ✓     │
            │  - Aligner ✓         │    │  - Aligner ✗         │
            └──────────────────────┘    └──────────────────────┘
                                              │
                          align() falls through to ───►  aligners/google-stt.ts
                                                         (later: aligners/whisperx.ts)
```

Two separate contracts, not one fused `generate`. ElevenLabs implements both; Google implements only `Synthesizer`. When `align()` is called for a Google voiceover, the dispatcher routes to a separate aligner module (Google Speech-to-Text in v1; a free local aligner like whisperX is a follow-up option).

### Interface shape

```ts
// src/lib/tts/types.ts

export type TtsProviderId = 'elevenlabs' | 'google';

export interface VoiceRef {
  providerId: TtsProviderId;
  voiceId: string;          // provider-native id, e.g. 'en-US-Chirp3-HD-Charon'
  voiceVersion?: string;    // provider-supplied version/etag if any; pinned for re-renders
  languageCode: string;     // BCP-47, e.g. 'he-IL' or 'en-US'
}

export interface SynthesizeRequest {
  voice: VoiceRef;
  text: string;
  ssml?: string;            // when set, takes precedence over text (provider-permitting)
  options?: ProviderSpecificOptions;  // tagged union by providerId
}

export interface SynthesizeResult {
  audioBytes: Uint8Array;
  mimeType: 'audio/mpeg';   // pipeline always wants MP3; providers convert internally
  durationSeconds: number;  // from the audio header, not provider metadata (consistency)
  charCount: number;
  costUsd: number;
  providerMetadata: Record<string, unknown>;  // raw vendor response bits, for debugging
}

export interface Synthesizer {
  readonly id: TtsProviderId;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
  listVoices(filter?: { languageCode?: string; tier?: string }): Promise<VoiceCatalogEntry[]>;
  estimateCost(req: Pick<SynthesizeRequest, 'voice' | 'text' | 'ssml'>): number;
}

export interface AlignRequest {
  voice: VoiceRef;          // alignment may pick best aligner based on the source provider
  audio: Uint8Array;
  mimeType: 'audio/mpeg';
  text: string;             // forced-alignment hint, NOT free-form ASR
  languageCode: string;
}

export interface AlignResult {
  words: Array<{ text: string; startSec: number; endSec: number }>;
  costUsd: number;
  alignerUsed: 'elevenlabs' | 'google-stt' | 'whisperx';
}

export interface Aligner {
  readonly id: 'elevenlabs' | 'google-stt' | 'whisperx';
  align(req: AlignRequest): Promise<AlignResult>;
  supportsLanguage(code: string): boolean;
}
```

Tagged union for `ProviderSpecificOptions`:

```ts
export type ProviderSpecificOptions =
  | { providerId: 'elevenlabs'; modelId: string; stability: number; similarity: number; style: number; useSpeakerBoost: boolean }
  | { providerId: 'google'; pitchSemitones?: number; speakingRate?: number; audioProfile?: 'small-speaker' | 'wearable' | 'handset' | 'headphone' | 'large-home' | 'large-auto' | 'telephony' };
```

`tts-dispatch.ts` knows which `Aligner` to use given a `VoiceRef`:

- `voice.providerId === 'elevenlabs'` → `ElevenLabsAligner` (existing forced-alignment endpoint)
- `voice.providerId === 'google'` → `GoogleSttAligner` (Google Cloud STT word-timings)

### Credential handling (security)

Three env vars at runtime:

- `GOOGLE_TTS_PROJECT_ID`
- `GOOGLE_TTS_CLIENT_EMAIL`
- `GOOGLE_TTS_PRIVATE_KEY` (containing the `-----BEGIN PRIVATE KEY-----\n...` block with `\n` literally, escaped by Vercel)

At module load (`src/lib/tts/providers/google.ts`):

```ts
const rawKey = process.env.GOOGLE_TTS_PRIVATE_KEY ?? '';
// Vercel stores env vars with literal '\n' that need converting to real newlines.
// This is the standard Google Cloud + Vercel footgun.
const privateKey = rawKey.replace(/\\n/g, '\n');
```

A boot-time `assertGoogleTtsEnv()` runs on first use, logs `[tts google] credentials loaded` with `{ projectId, clientEmailMasked, privateKeyValid: privateKey.includes('BEGIN PRIVATE KEY') }`, and throws a single clear error if any of the three are missing. No silent failures.

Same service account is reused for Google Speech-to-Text via a separate but parallel `GOOGLE_STT_*` env trio? **No** — same project, same service account, same three env vars. STT and TTS are roles on the same project. Single set of env vars, two SDK clients.

`.gitignore`: add `*-tts-*.json`, `*-credentials.json`, `*-keyfile.json` defensively, so even if a future contributor downloads a key file, it cannot be staged accidentally.

### Database changes

No migration needed for `media_assets` — JSONB.

**`media_assets.metadata` shape (extended):**

```jsonc
{
  // existing
  "voiceId": "string",
  "modelId": "string",          // elevenlabs only
  "generatedAt": "ISO timestamp",
  "charCount": 12345,

  // new
  "provider": "elevenlabs" | "google",
  "voiceVersion": "string | null",   // provider's voice etag/version when available
  "languageCode": "he-IL" | "en-US" | ...,
  "costUsd": 0.0123,
  "tier": "chirp3-hd" | "wavenet" | "neural2" | "polyglot" | "standard" | "studio" | "elevenlabs-multilingual-v2" | ...,
  "providerOptions": { ... }    // the same tagged-union options used at synthesis time
}
```

**Backfill:** on first read, treat any row without `provider` as `"elevenlabs"`. A one-shot migration (`0089_backfill_voiceover_provider.ts`) sets `metadata = jsonb_set(metadata, '{provider}', '"elevenlabs"')` for existing rows of `type='voiceover'`. Idempotent — re-running the migration does nothing.

**`voiceover_alignments.cache_key`:** include `provider` and `alignerUsed` in the hashed payload so an ElevenLabs voiceover and a Google voiceover with the same text don't collide. New cache_key format: `sha256(provider:voiceId:textHash:alignerUsed)`. Old rows continue to resolve under their old key — no rewrite needed because keys are content-addressed and old voiceovers won't have provider in their input anyway.

**Workspace settings:** add `default_tts_provider` and `default_tts_voice_id` to the workspace settings JSONB (no new column, no migration). Auto-pipeline reads these.

### Per-surface integration

| Surface | File | Change |
|---|---|---|
| Voiceover studio | `src/app/(app)/voiceover/page.tsx` | Add provider tab strip; per-provider voice picker; per-provider settings panel; cost display in "$ per minute" terms. |
| Editor regenerate | `src/app/api/edit/[projectId]/voiceover/regenerate/route.ts` | Accept `{ provider, voiceId, options }`; dispatch through `tts-dispatch`. Editor UI gets a provider switcher in the inspector. |
| Shorts voiceover | `src/app/api/shorts/[id]/voiceover/route.ts` | Accept `{ provider, voiceId }`; dispatch. UI gets the same switcher. |
| Auto-pipeline | `src/lib/auto-pipeline/stages/*` (voiceover stage) | Read workspace default; if absent, fall back to current ElevenLabs default. |

The voiceover studio page is large (~1200 LOC). To keep the diff readable, the provider tab + per-provider sub-panels go into new components under `src/components/voiceover/`:
- `ProviderTabs.tsx`
- `ElevenLabsVoicePicker.tsx` (extracted from the existing page)
- `GoogleVoicePicker.tsx` (new)
- `ProviderSettingsPanel.tsx` (provider-discriminated)

The page itself becomes a thin orchestrator.

### Voice catalog UX (rule 10 + 16)

The picker is reorganized around the user's decision, not the vendor's taxonomy:

1. **Language** (auto-default to workspace language, e.g. Hebrew).
2. **Quality / price band** (4 plain labels: *Draft*, *Standard*, *Premium*, *Top-tier*).
   - *Draft* = Google Standard ($4/1M, ~$0.02/min narration) — fastest cheap
   - *Standard* = Google WaveNet + Neural2 ($4–$16/1M)
   - *Premium* = Google Chirp 3 HD + ElevenLabs Multilingual v2 (~$30–$300/1M)
   - *Top-tier* = ElevenLabs Pro voices + Google Studio (gated by workspace opt-in)
3. **Voice character** (preview-on-click; show name, gender, sample line).
4. **Cost estimate** for the current script: "Estimated cost for this 2,300-character script: $0.07."

Provider name and Google tier name are shown as small secondary labels next to the voice, not as primary navigation. "Polyglot" and "Chirp 3 HD" never appear as user-facing categories — they're metadata in the voice card.

### Pricing — current as of 2026-05-25

Verified against `costbench.com` and the Chirp 3 HD docs page (Google's official pricing page kept returning truncated content). Sources cited at the end of this plan.

| Provider/tier | Free/mo | $/1M chars | $/2-min narration (~2,500 chars) | Notes |
|---|---|---|---|---|
| Google Standard | 4M | $4 | $0.01 (often free) | Robotic; fine for drafts |
| Google WaveNet | 1M | $4 | $0.01 | Recent price drop, great value |
| Google Neural2 | — | $16 | $0.04 | Solid mid-tier |
| Google Polyglot | — | $16 | $0.04 | One voice, many languages |
| Google Chirp 3 HD | 1M | $30 | $0.075 | LLM-based, ElevenLabs-class quality, **supports he-IL** |
| Google Studio | 1M | $160 | $0.40 | Premium; gated behind workspace opt-in |
| ElevenLabs (current) | — | ~$200–$300 | ~$0.50–$1.00 | Existing default |

**Headline:** Chirp 3 HD is 10–13× cheaper than ElevenLabs at comparable quality. This is the unlock.

**Alignment cost:** Google Speech-to-Text v2 standard model = $0.024/min audio. A 2-min narration alignment ≈ $0.05. We cache by `(provider, voiceId, textHash)` so the second alignment of identical text is free.

### Alternatives considered and rejected

**A. Bolt Google onto the existing code without abstraction.** Faster to land. Rejected because the user wants Google in all 4 surfaces, which means duplicating 6 hardcoded ElevenLabs call sites into 12. Refactor pain on the third provider is much worse than refactor pain now.

**B. Build a unified `media-dispatch` framework for all media types (TTS, image, music, captions).** Tempting per the Expansionist council take. Rejected because the proposal generalizes from a sample of two; the actual shared shape only becomes visible after the third multi-provider system ships. Premature generalization risk is real.

**C. Fuse `synthesize` and `align` into a single `generate` interface.** Rejected: providers ship them as separate products (Google: yes; Azure: yes; future free aligners: yes). Fusing locks us out of cheap forced-alignment alternatives. Two contracts is the right shape from day one.

**D. Lock each project to a single provider after first generation.** Rejected per Outsider council take: pushes a decision the user can't evaluate onto the user. Store provider per-asset; let users mix freely; flag mixed-provider projects with a soft warning if voice-character differs noticeably across clips (future).

**E. Use ElevenLabs' forced-alignment endpoint for Google voiceovers too.** Tempting — ElevenLabs accepts arbitrary audio + text. Rejected: pays ElevenLabs for the alignment of a voiceover we generated cheaply elsewhere, defeating the cost unlock; also leaks user-script content to a second vendor unnecessarily.

## Security (rule 13)

**Threats and mitigations:**

| Threat | Mitigation |
|---|---|
| Service-account JSON ends up in git | Never write to disk; env vars only; defensive `.gitignore` entries. |
| Private key with `\n` corrupts on Vercel deploy | `replace(/\\n/g, '\n')` at read; boot-time `assertGoogleTtsEnv` self-check with a log line. |
| Compromised key already exposed (the one pasted into chat) | **User must rotate the key in GCP Console before this plan ships.** Documented as a precondition. |
| Workspace user with no Google entitlement gets Studio voice and burns the bill | Per-workspace `allow_studio_tier` flag, default false. UI hides the band entirely when off. |
| Per-asset cost field becomes a billing source-of-truth that drifts from actual Google invoice | Treat `costUsd` as a *display estimate*, not the bill. Add a `[tts cost reconcile]` weekly job (future) that compares estimate sum vs invoice. |
| Script content leaks across providers | Synthesis only sends script to the chosen provider. Alignment for Google voiceovers only goes to Google STT — never to ElevenLabs. Provider toggle in the picker is informational so the user knows. |
| Workspace under NDA can't legally use one of the providers | Per-workspace allowlist setting: `enabled_tts_providers: ['elevenlabs', 'google']`. Default both on; UI hides the disabled one entirely. |
| Voice deprecation breaks a re-render | Persist `voiceVersion` alongside `voiceId` in `media_assets.metadata`. Re-render with the same `(voiceId, voiceVersion)` tuple; if the voice is gone, fail loud with a clear user-actionable error, not silently swap. |

## Observability (rule 14)

Namespaced logs at every step. Every log includes relevant values (not just "X happened"):

| Namespace | When | Sample payload |
|---|---|---|
| `[tts dispatch]` | Entry to `synthesize()` | `{ provider, voiceId, chars, languageCode }` |
| `[tts google synth]` | Before/after Google API call | `{ voiceId, tier, sampleRate, durationMs, costUsd }` |
| `[tts google synth err]` | On failure | `{ voiceId, code, message, retryable }` |
| `[tts elevenlabs synth]` | Same shape, ElevenLabs branch | mirrors above |
| `[tts align dispatch]` | Entry to `align()` | `{ alignerSelected, voiceProvider, languageCode, audioBytes }` |
| `[tts align google-stt]` | Before/after STT call | `{ audioBytes, durationSec, wordCount, costUsd }` |
| `[tts align cache hit]` | When cache resolves | `{ cacheKey, alignerUsed }` |
| `[tts r2 upload]` | After R2 store | `{ key, bytes, durationMs }` |
| `[tts cost]` | After each generation | `{ provider, voiceId, chars, durationSec, costUsd, runningWorkspaceTotalUsd }` |
| `[tts boot]` | Module init | `{ googleConfigured: bool, elevenLabsConfigured: bool }` |

Console output goes through the existing `logger.ts` shim so format stays consistent with the rest of the codebase. Errors surface a sanitized message to the API response and a full message in the logs.

## Settings audit (rule 15)

New user-facing settings (in workspace settings page):

1. **Default voiceover provider** — dropdown: ElevenLabs / Google. Default: workspace's current state (existing workspaces → ElevenLabs).
2. **Default voice** — voice picker scoped to selected provider. Used by auto-pipeline.
3. **Enable Studio tier** — toggle, default off. Surfaces Google Studio voices in the picker; otherwise the band is hidden.
4. **Enabled providers** — multiselect: ElevenLabs / Google. Default: both. Used to suppress an entire provider for NDA workspaces.
5. **Show provider/tier metadata in picker** — toggle, default off. Power users who want to see "Chirp 3 HD" and "Multilingual v2" as primary labels can flip it on.

Settings group: a new "Voiceover" group in `/settings`, separating these from the existing API key fields (which stay where they are). Plain-language descriptions for each — no "use this if you know what you're doing" — every label has to be readable by a lazy user.

## Cost analysis (rule 8)

Live pricing verified 2026-05-25, sources at bottom.

**Per-narration cost (typical 2,500-char, 2-minute YouTube script):**

| Path | Synthesis | Alignment | Total |
|---|---|---|---|
| ElevenLabs (current) | $0.50–$1.00 | included | $0.50–$1.00 |
| Google Chirp 3 HD + Google STT | $0.075 | $0.05 | **$0.125** |
| Google WaveNet + Google STT | $0.01 | $0.05 | **$0.06** |
| Google Standard + Google STT | $0.01 (often free) | $0.05 | **$0.05–$0.06** |

Even with alignment overhead, Google is 4–20× cheaper. Cache hits on alignment drop the second-run cost to just synthesis.

**Auto-pipeline batch risk (Studio tier, no cap):** a workspace running auto-pipeline on 10 videos × 5 sections × 1,500 chars = 75,000 chars per batch. At Studio's $160/1M = $12 per batch. At Chirp 3 HD's $30/1M = $2.25. Studio tier gated behind opt-in (R6) blunts this risk.

## Risks and open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Google STT word-timing accuracy on Hebrew (synthesis quality already verified by user 2026-05-25) | Medium — alignment errors are visible if they happen | Smoke test as part of standard QA pass. If alignment quality is poor on Hebrew, fall back to whisperX in a follow-up; synthesis itself is solid. |
| Chirp 3 HD has only 28 voice "personas" — limited compared to ElevenLabs catalog | Low — still > most users need | Surface all 28 in the picker; document the cap. |
| Chirp 3 HD's limited SSML (no `<mark>`, restricted prosody) could break advanced ElevenLabs scripts | Medium — only if scripts use those features | Translate ElevenLabs SSML to Google-compatible SSML at the dispatch boundary; warn the user when a tag is dropped. |
| Audio sample-rate mismatch (Google MP3 vs LINEAR16) silently corrupts alignment timings | High — would manifest as drifted captions | Standardize on MP3 16kHz mono for both providers in v1. Add a duration-sanity log line that compares header duration vs expected duration based on word count. |
| Google long-form synthesis (> 5000 chars) is async with operation polling | Medium — typical scripts are < 2500 chars but Hebrew is verbose | The contract treats both sync and async paths; for long-form, the dispatcher polls with backoff and returns the same `SynthesizeResult` shape. |
| Workspace `costUsd` rollup drifts from real GCP invoice | Low — estimate is for display only | Documented as estimate; reconciliation job is a follow-up. |
| Per-project QPS quotas throttle auto-pipeline invisibly | Medium — looks like a hang | Already mitigated by existing auto-pipeline queue. Add a retry-with-backoff in `GoogleTtsProvider.synthesize` for `RESOURCE_EXHAUSTED`. |

## Work sequence

This is a single coordinated change, not a sequenced PR train (user override of council recommendation). Internal order to keep the diff bisectable mentally:

1. **Infrastructure first:** `src/lib/tts/types.ts`, `src/lib/tts/dispatch.ts`, `src/lib/tts/providers/elevenlabs.ts` (extract from existing `elevenlabs.ts`), `src/lib/tts/providers/google.ts`, `src/lib/tts/aligners/elevenlabs.ts`, `src/lib/tts/aligners/google-stt.ts`.
2. **Tests for both providers + aligners** (mocked vendor responses).
3. **Wire dispatch into the 6 existing call sites** with zero user-visible change (`provider` defaults to `'elevenlabs'`).
4. **DB metadata extension** + idempotent backfill migration `0089_backfill_voiceover_provider.ts`.
5. **Workspace settings UI** for default provider / enabled providers / Studio gate.
6. **Voiceover studio page** refactor: provider tabs, voice pickers, settings panels, cost display.
7. **Editor inspector** provider switcher.
8. **Shorts voiceover** provider parameter.
9. **Auto-pipeline** reads workspace default; falls back to ElevenLabs.
10. **End-to-end smoke test** on each surface: English + Hebrew, ElevenLabs + Google, with alignment.

## Implementation status (updated 2026-05-25)

**Landed in this commit:**
- ✅ `src/lib/tts/` — types, cost table, google-env loader, dispatch, providers (elevenlabs, google), aligners (elevenlabs, google-stt), voices/google-catalog
- ✅ `POST /api/tts/generate` — dispatch-aware synthesis endpoint
- ✅ `GET /api/tts/voices` — dispatch-aware catalog endpoint
- ✅ `/api/elevenlabs/generate` refactored to call dispatch internally (same external shape)
- ✅ `/voiceover` studio page: provider tab strip, Google voice picker (language + tier filters), conditional voice library, provider-aware generation
- ✅ `/api/edit/[projectId]/voiceover/regenerate` accepts `{ provider, tier, languageCode }`, dispatches
- ✅ `src/lib/shorts.ts` `generateShortVoiceover` accepts `{ provider, tier, languageCode }`, dispatches
- ✅ `media_assets.metadata` extended with `provider`, `tier`, `languageCode`, `costUsd`, `voiceVersion`, `providerOptions`
- ✅ Unit tests for pricing + env loader (16 tests passing, 0 regressions)

**Deferred to follow-up commits:**
- ⏳ `src/lib/voiceover-alignment-cache.ts` — provider-aware (Google STT for Google audio). Today, Google voiceovers store + play correctly but alignment-driven word highlighting only works for ElevenLabs voiceovers. Adding `provider` parameter to `ensureAlignmentForVoiceover` is the next step.
- ⏳ Workspace settings UI: default provider, enabled providers allowlist, Studio tier gate
- ⏳ Per-workspace `costUsd` rollup dashboard
- ⏳ Long-form Google synthesis (>5000 byte input) — currently rejected with a clear error
- ⏳ Voice catalog UX redesign around quality bands (Draft/Standard/Premium/Top-tier) — current picker still uses raw tier names

## Acceptance checklist (rule 6 — extreme QA)

Before merging:

- [ ] All 6 existing voiceover routes still work with ElevenLabs unchanged.
- [ ] Each surface (studio, editor regen, shorts, auto-pipeline) generates a working Google Chirp 3 HD voiceover in English.
- [ ] Each surface generates a working Google voiceover in Hebrew.
- [ ] Word-level highlighting works for: ElevenLabs English, ElevenLabs Hebrew, Google English (Chirp 3 HD), Google Hebrew (Chirp 3 HD).
- [ ] Voiceover library shows mixed-provider rows correctly.
- [ ] Re-render of an existing project still uses the original voice (deterministic, voiceVersion respected).
- [ ] Cost displayed in picker matches actual `costUsd` written to `media_assets.metadata` after generation.
- [ ] Studio tier hidden when workspace toggle is off; visible when on.
- [ ] Vercel preview deploy boots cleanly and synthesizes Google audio (validates the `\n` env handling end-to-end).
- [ ] Removing all three `GOOGLE_TTS_*` env vars: Google provider absent from picker UI; ElevenLabs still works; no crash.
- [ ] All `[tts ...]` log lines emit at expected points with expected payloads.
- [ ] No `amit-tts-*.json` or similar file in the repo. `.gitignore` blocks it.

## Pre-flight (must happen before code merge)

1. **User rotates the exposed service-account key** in GCP Console (key ID `cae16b72fd6560cf41a4babcd123ca96731dde91`).
2. **New key fields added to Vercel env** (`GOOGLE_TTS_PROJECT_ID`, `GOOGLE_TTS_CLIENT_EMAIL`, `GOOGLE_TTS_PRIVATE_KEY`) on Production, Preview, and Development.
3. **Service account roles in GCP:** `roles/cloudtts.user` (synthesis) + `roles/speech.client` (STT alignment). Verify on the service account page before first deploy.
4. **Local `.env.local` updated** with the same three vars for local dev.

## Sources cited

- Google Cloud Text-to-Speech pricing summary: https://costbench.com/software/ai-voice-tools/google-cloud-text-to-speech/ (verified 2026-05-25)
- Chirp 3 HD voices + language list (incl. he-IL): https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
- Google Cloud TTS Node SDK (inline-credentials pattern + `synthesizeSpeech` shape): Context7 `/googleapis/google-cloud-node`, queried 2026-05-25
- Google Cloud Speech-to-Text v2 pricing: https://cloud.google.com/speech-to-text/pricing (standard model $0.024/min)
- LLM Council verdict 2026-05-25 (architecture pressure test; user elected to ignore council's three-PR split but technical landmines from peer review are incorporated above)
