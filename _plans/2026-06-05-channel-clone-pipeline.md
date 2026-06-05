# Channel-Clone Pipeline — Plan

**Date:** 2026-06-05
**Status:** Approved, M1 in progress
**Source video:** [How to Make Stickman Animations and Go Viral in 7 Days with AI](https://www.youtube.com/watch?v=UOmGx8pmf_I) by AI Cash Tom (2026-06-04). The "ULTIMATE AI YOUTUBE CONTENT ENGINE V2.1" prompt doc demoed in the video lives at `refs/ULTIMATE AI YOUTUBE CONTENT ENGINE V2.0.docx` (filename says V2.0; doc contents are V2.1).

## Goals

Build an internal "clone any explainer-style YouTube channel" pipeline inside `youtubestudio-live`. Paste a competitor URL → get a fully-populated production-doc (script + scene rows + assets + publishing pack) ready for human review and render.

## Constraints

- Internal tool, single user. No auth/billing/SaaS overhead.
- Lives inside this repo, reuses existing infra (production-doc, auto-pipeline, Remotion render, Lambda).
- Human-in-loop: pipeline produces drafts; user approves before render.
- Opus 4.8 default for all LLM stages, **per-stage model picker** in settings so the user can swap any individual stage's model (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 / future) without code changes.
- yt-dlp + youtube-transcript-api for intake. Auto-pipeline tick model for orchestration.
- Generic — works for any explainer channel, not Stickman-only.
- Stays within Vercel 300s tick budget by chunking work across ticks (same pattern as `generate-production-doc-images.ts` `MAX_*_PER_TICK = 3`).

## User flow

1. Open production-doc page → click **"Clone a channel"** → paste competitor URL.
2. Pipeline ticks through: fetch channel metadata + sample videos → extract transcripts + frames → analyze niche/style/audience → produce Style DNA + visual style profile.
3. Pipeline returns 10 topic ideas with hooks and difficulty scores. User picks one (or types own).
4. Pipeline runs hook engineering (5 hooks) → user picks → script generation → audit → fix-loop until score ≥ configurable threshold (default 90).
5. Pipeline converts the script into `ProductionRow[]` matched to the chosen style preset, then the existing `generate-production-doc-images` stage runs unchanged.
6. Pipeline produces the publish pack (titles, description, SEO tags, pinned comment, 30-day calendar).
7. User reviews the production-doc, edits anything, hits render.

## Architecture

### Schema additions on `ProductionDoc` (JSONB-backed, per AGENTS.md pattern)

All new fields follow the same naming convention as `paint_explainer_v1_*` so the page-level inline `ProductionDoc` mirror in `src/app/(app)/production-doc/page.tsx` stays in sync.

```ts
channel_clone_intake?: {
  source_channel_url: string;
  source_channel_handle?: string;
  sample_video_urls: string[];                                          // 3–5 long-form videos chosen
  sample_video_paths: string[];                                          // local cached video files
  sample_transcripts: { videoUrl: string; text: string; wordCount: number }[];
  sample_frames: { videoUrl: string; framePaths: string[] }[];
  fetched_at: string;
};

channel_clone_analysis?: {
  niche: string;
  sub_niche: string;
  target_audience: { demographics: string; psychographics: string };
  content_format: 'essay' | 'listicle' | 'story' | 'tutorial' | 'hybrid';
  hook_architecture: string;
  script_flow_blueprint: string;
  wps_estimate: number;
  avg_video_word_count: number;
  signature_phrases: string[];
  style_dna: {
    sentence_rhythm: string;
    tonal_fingerprint: string;
    transition_mechanics: string;
    metaphor_patterns: string;
    opening_patterns: string;
    closing_patterns: string;
  };
  audience_psychology: { pain_points: string[]; identity_promise: string; channels_enemy: string };
  model_used: string;                                                    // e.g. 'claude-opus-4-8'
  analyzed_at: string;
};

channel_clone_visual_profile?: {
  art_style: string;
  palette_hex: string[];
  lighting_style: string;
  composition_patterns: string;
  detail_level: string;
  mood: string;
  derived_style_preset_id?: string;                                      // pointer into production-doc-styles registry
};

channel_clone_audit?: {
  score: number;
  breakdown: Record<string, number>;
  revisions_applied: number;
  final_word_count: number;
};

channel_clone_publish_pack?: {
  titles: string[];
  description: string;
  tags: string[];
  pinned_comment_options: string[];
  content_calendar?: { day: number; topic: string; angle: string }[];
};

channel_clone_settings?: ChannelCloneSettings;                           // see Settings section
```

### New pipeline stages (`src/lib/auto-pipeline/stages/`)

Each follows the existing pattern: per-tick cap, success/skip/fail counters, namespaced logs.

1. **`channel-clone-intake.ts`** — `MAX_VIDEO_DOWNLOADS_PER_TICK = 1`. Spawns `yt-dlp` (validated URL, `shell: false`, arg-array) to fetch channel metadata + 3–5 sample videos at 480p, runs ffmpeg for frame extraction every 10s, pulls captions via `youtube-transcript-api`. Caches everything to a doc-scoped temp folder.
2. **`channel-clone-analyze.ts`** — `MAX_ANALYSES_PER_TICK = 1`. One Opus 4.8 call combining transcripts + sampled frames → fills `channel_clone_analysis` + `channel_clone_visual_profile`. Optionally derives a new style preset if no existing one matches.
3. **`channel-clone-topic.ts`** — `MAX_TOPIC_RUNS_PER_TICK = 1`. Emits 10 ranked topic ideas with hooks. Surfaces in UI as picker.
4. **`channel-clone-script.ts`** — `MAX_SCRIPT_RUNS_PER_TICK = 1`. Generates script, runs audit, applies fix-and-rescore loop until threshold or max iterations.
5. **`channel-clone-rowify.ts`** — converts the approved script into `ProductionRow[]`, matched to the chosen style preset's `mixing_rules`. Hands off to the existing `generate-production-doc-images` stage with no further intervention.
6. **`channel-clone-publish-pack.ts`** — final stage, titles + SEO + 30-day calendar.

### UI surface

- `src/components/production-doc/ChannelClonePanel.tsx` — top-level panel mounted on the production-doc page, conditional on a new `channel_clone_intake` doc field.
- `src/components/production-doc/ChannelCloneSettingsPanel.tsx` — settings panel for per-stage model picker, audit threshold, intake parameters, voice cloning toggle, disclaimer acknowledgment.

## Alternatives considered + rejected

- **Vercel Workflow DevKit (WDK)** — durable workflow for the 22 stages. Rejected: overkill for a single-user internal tool. The auto-pipeline tick model already gives crash-safe progress because everything is persisted on the JSONB doc between ticks.
- **Sidecar service** — separate microservice for intake + analysis. Rejected: adds deployment surface; nothing about analysis genuinely needs to be its own service.
- **Standalone CapCut-style clone of his exact stack** — rejected: throws away the Remotion + Lambda infra that is the actual value of this repo.
- **Headless API + CLI** — rejected per the "internal tool" choice. Can add later.
- **YouTube Data API v3** — rejected for transcripts (doesn't return them); could revisit for stats if free quota becomes useful.

## Cost analysis (rule 8)

Per channel-clone run, ballpark:

| Item | Estimate | Notes |
|---|---|---|
| Opus 4.8 analysis (≈80K input + 30K output) | ~$1.15 | Verified $5/$25 per Mtok on [Anthropic Opus 4.8 page](https://www.anthropic.com/news/claude-opus-4-8) |
| Opus 4.8 script + audit-fix loop (≈40K + 30K output × 2 iterations) | ~$1.70 | The fix loop doubles output |
| Image generation for ~40 scenes | $1.50–6.00 | Depends on which existing image gen is routed through |
| ElevenLabs voiceover (~6K chars) | ~$1.80 | Or covered by existing plan |
| yt-dlp + ffmpeg + storage | $0 | Local |
| **Total per video** | **~$6–11** | Before YouTube revenue offsets |

YouTube monetization at $2–5 CPM means ≥3K views per video to break even on a $10 cost. Worth knowing before scaling.

## Security (rule 13)

- **YouTube URL validation** — strict regex match on `youtube.com/@handle` / `youtube.com/channel/UCxxx` / `youtube.com/watch?v=xxx`; reject everything else before passing to `yt-dlp`. No shell injection surface.
- **Subprocess hardening** — spawn `yt-dlp` and `ffmpeg` with `shell: false` and explicit arg arrays, no string interpolation.
- **Secrets** — Anthropic + ElevenLabs keys from env, never logged.
- **File system isolation** — all downloads go to a per-doc temp folder under `${VERCEL_TMP}/channel-clone/{docId}`, cleaned up when the doc is deleted.
- **PII / logging** — channel name + URL logged; transcripts and analysis output not logged (could contain creator's name, location references). Audit `console.info` calls before merge.
- **Legal gray area** — one-time confirmation dialog in Settings: "Channel cloning analyzes others' content for stylistic inspiration. You are responsible for ensuring your derivative work is original and complies with platform terms."
- **Voice cloning** — ElevenLabs Voice Library matching only by default. No IVC (instant voice clone) on competitor audio unless explicitly opted in per channel.

## Observability (rule 14)

Namespaced logs at every stage transition + on every external call. Each log includes actual values, not just "X happened":

```
[channel-clone intake]      yt-dlp start (url, sampleCount), transcript fetch (videoId, wordCount), frame extract (videoId, frameCount), errors with stderr
[channel-clone analyze]     model, promptTokens, responseTokens, auditScore, analysisDurationMs
[channel-clone script]      iteration, auditScore, wordsTarget, wordsActual, deltaPct, model
[channel-clone rowify]      rowCount, stylePresetApplied, motionBeatsGenerated
[channel-clone publish]     titlesCount, calendarDays
[channel-clone error]       stage, error message, recoverable (boolean)
```

## Settings (rule 15)

`ChannelCloneSettingsPanel.tsx`, stored as `channel_clone_settings` JSONB on the doc (with global defaults read from app-level settings if doc-level is empty).

### Per-stage model picker (new — user request)

Single grouped section "**Model per stage**" with one dropdown per stage so any individual stage can be swapped without code changes:

```ts
type ChannelCloneSettings = {
  models: {
    intake_summary: AiModelId;       // light summarization during intake — default Haiku 4.5
    analysis: AiModelId;             // deep style + audience analysis — default Opus 4.8
    topic_generation: AiModelId;     // 10 topic ideas — default Opus 4.8
    hook_engineering: AiModelId;     // 5 hooks per topic — default Opus 4.8
    script_generation: AiModelId;    // full script — default Opus 4.8
    script_audit: AiModelId;         // 10-point audit + fix loop — default Opus 4.8
    rowify: AiModelId;               // script → production rows — default Sonnet 4.6
    publish_pack: AiModelId;         // titles, SEO, calendar — default Sonnet 4.6
  };
  audit: { threshold: 80 | 90 | 95 | 100; maxIterations: 1 | 3 | 5 };
  intake: { sampleVideoCount: 3 | 5 | 8; frameIntervalSec: 5 | 10 | 15; cacheTtlDays: 1 | 7 | 0 /* forever */ };
  output: {
    defaultStylePresetId: string | 'auto-derive';
    autoTriggerImageGenAfterRowify: 'yes' | 'ask' | 'no';
    voiceCloning: 'library-match' | 'off';
  };
  disclaimerAccepted: boolean;
  disclaimerAcceptedAt?: string;
};
```

The `AiModelId` union is sourced from the existing `src/lib/ai-models.ts` so any newly added model becomes available in every picker without per-feature wiring. Global defaults persist in app settings (or `localStorage` for v1); per-doc overrides land on `channel_clone_settings`.

### Per-stage picker UI

Compact table — left column is stage label, right column is dropdown. Each row has a tooltip explaining what that stage does, so the user knows what they're swapping. A "Reset all to defaults" button at the bottom.

## Testing (rule 18)

**Unit tests** (Vitest):
- `validateYoutubeUrl()` — accepts channel/@handle/watch URLs, rejects everything else (including data URIs, file URIs, javascript URIs, shell metacharacters)
- `cleanRollingCaptions()` — dedup logic for SRT/VTT auto-captions
- `parseAuditResponse()` — extracts 10-point score grid from structured Opus output
- `scriptToProductionRows()` — script segmentation, beat assignment
- `estimateRunCost()` — token-cost estimator for the "before you start" warning
- `derivStylePresetFromAnalysis()` — analysis output → valid `production-doc-styles.ts` entry
- `resolveStageModel()` — given settings + stage name, returns the correct model ID with fallback to defaults

**Integration tests:**
- Fixture-based: saved analysis JSON + transcripts → assert deterministic script-gen output shape
- Smoke test: full pipeline against one canned channel URL (gated behind env flag because it makes real LLM calls)

**Manual QA per milestone:**
- Run on Zenn and Franz to validate output quality on the source niche
- Run on one channel in a different niche to validate generic-ness

## Open questions

1. **Style derivation vs. mapping** — when analyzer determines visual style, do we (a) always create a new style preset on the fly, (b) prefer to map onto an existing preset and only create new if no match, or (c) require the user to pick? Default proposal: (b), with picker as escape hatch.
2. **Shorts support** — long-form only for v1, or include Shorts? Default proposal: long-form only.
3. **What we do when the channel has fewer than 3 long-form videos** — fail with a clear error, or proceed with fewer samples and flag lower confidence? Default proposal: proceed with warning.

## Rollout

| Milestone | Estimate | Deliverable |
|---|---|---|
| M1 — Intake + analyze | 1–2 days | URL paste → analysis JSON populated on doc, logs visible |
| M2 — Topic + hook + script with audit loop | 1–2 days | Pick a topic → audited script saved on doc |
| M3 — Script → production rows | 1 day | Existing `generate-production-doc-images` kicks in unchanged |
| M4 — Publish pack | half day | Titles, SEO, calendar generated |
| M5 — UI panel + settings + observability polish | 1 day | Full workflow surfaced in production-doc page |
| **Total** | **~5–6 days of focused work** | Internal tool ready for first real-channel test |

## Out of scope (v1)

- Auto-upload to YouTube
- IVC voice cloning on competitor audio
- A/B test variant rotation on live YouTube
- Multi-language (could be M6)
- Channels with members-only / unlisted videos
