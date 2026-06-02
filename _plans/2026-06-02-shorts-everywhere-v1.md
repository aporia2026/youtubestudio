# Shorts everywhere — v1 plan

**Status:** approved, awaiting Phase 1 kickoff
**Owner:** Yoav + Claude
**Drafted:** 2026-06-02
**Council pass:** 2026-06-02 (full 5-advisor + peer-review + chairman synthesis below)

---

## 1. Goals

Make Shorts a first-class artifact across Ideas / Scripts / QA / SEO so the user can spin up YouTube Shorts the same way they spin up long-form. Two entry points:

- **From an existing channel video** — pick a published video, AI surfaces the best 45s moments, user either jumps into YouTube Studio to cut it there (Mode A) or asks the app to generate a brand-new Short from that moment (Mode C).
- **From scratch** — full Shorts pipeline (idea → script → QA → SEO → render → publish) in the same sections the long-form pipeline lives in, behind a Long-form / Shorts toggle.

Success looks like: the user opens Ideas, flips to Shorts mode, gets hook-first ideas, writes a Short script in Scripts, QA-scores it on Shorts criteria, SEO-optimizes it for vertical-feed discovery, renders it in a picked style, publishes via the existing publishing pipeline. Same mental model as long-form, no second app.

## 2. Constraints

- **YouTube Data API does not allow video file downloads.** Verified Phase 0. Mode A returns timecodes + a deep link into YouTube Studio. Mode C generates a fresh Short. Mode B (user uploads source MP4 + ffmpeg-clip + reframe + caption) is **deferred to its own future plan** — council called it a 4–6 week video-editor product bolted onto the AI app; we ship A + C first, prove use, then revisit.
- **Vercel Fluid Compute 300s default function timeout.** Mode A's transcript scoring fits easily. Mode C's render reuses the existing Phase 5.5 pipeline that already respects this budget.
- **Existing infra reused, not reinvented:** `publishing.ts` (videos.insert via resumable upload), `shorts` table (migrations 0021 + 0108), `ShortVideo` Remotion composition (Phase 5.5), `youtube-transcript` lib, YouTube OAuth + Data API + Analytics, ElevenLabs voiceover.
- **No new top-level navigation entry for Shorts.** Per the menu-organization principle the user enforces on Phase 7.2 + Phase 8.5: Shorts surfaces inside the existing Ideas / Scripts / QA / SEO pages via a format toggle.

## 3. Requirements

- The user has both long-form and short-form ambitions on the same channels.
- Lazy-user UX bar (rule 10): the toggle has to be obvious. The "Find clips" surface has to look like a recommendation engine, not a configurator. Empty states + loading states + error states all need clear copy.
- Brutal-honesty disclosure of cost implications (rule 8) per phase.
- Observability namespaces per rule 14 — every new step emits `[shorts <subsystem> <step>]` logs.
- Settings audit per rule 15 — every new control gets an explicit yes/no decision documented in this plan.
- Security per rule 13 — Mode A reads public captions only, no new attack surface. Mode C reuses the existing extractor's security model.
- Unit tests per rule 18 — every pure helper has tests, full suite stays green.

## 4. Verified facts (Phase 0 — done)

| Fact | Source | Implication |
|---|---|---|
| YouTube auto-classifies a vertical 9:16 video ≤180s as a Short. No special Shorts API endpoint exists. | YouTube Help docs + 2026 industry sources verified via WebSearch | `publishing.ts` works as-is for rendered Shorts. No publishing changes needed. |
| `#Shorts` hashtag is **optional** in 2026, not required for Shorts shelf eligibility. | Same as above | We won't auto-inject `#Shorts` into the title (saves precious title chars). Description-level hashtag rules apply (3–5 max, first 3 surface as clickable). |
| `publishing.ts` `videos.insert` uses parts `snippet,status` only. Already streams via resumable upload. | [src/lib/publishing.ts:49-50](src/lib/publishing.ts#L49-L50) | No Shorts-specific publish path needed. |
| `shorts` table `kind` is currently `'extracted' | 'external_seo'`. CHECK constraint via `shorts_kind_check`. | [src/lib/migrations/0108_add_short_seo_columns.ts](src/lib/migrations/0108_add_short_seo_columns.ts) | New migration drops + re-adds the CHECK to allow `'channel_clip_recommendation'`. |
| `youtube-transcript` returns `[{text, offset_ms, duration_ms}]`. No API key. | [src/lib/youtube-transcript.ts](src/lib/youtube-transcript.ts) | Mode A scoring is a pure transform over this array. |
| `ShortVideo` Remotion composition is 1080×1920 with caption + voiceover + optional title chip. | [src/remotion/compositions/ShortVideo.tsx](src/remotion/compositions/ShortVideo.tsx) | Mode C render path = unchanged from Phase 5.5. |

## 5. Architecture — the medium primitive

The council's load-bearing call: **a Short is not a format toggle on a long-form artifact. It is a different artifact with a different lifecycle.** Treating it as `format: 'long' | 'short'` on existing prompts/scorers/renderers will rot into `if (medium === 'short')` branching everywhere within a month.

We introduce `medium: 'long_form' | 'short_clip' | 'short_native'` as a primitive that every section reads:

- `long_form` — the existing long-form pipeline. Default. No behavior change.
- `short_clip` — Mode A. A clip *recommendation* attached to an existing YouTube video. Has timecodes + a transcript excerpt + a hook line + a payoff line + a deep link into YT Studio's clip editor. Never renders to MP4 (the user does the cut in Studio).
- `short_native` — Mode C. A fresh Short generated by the app. Has a `short_script`, can be voiced + rendered via the existing Phase 5.5 pipeline, has a style picker, can be published via the existing `publishing.ts`.

### Where the primitive lives

- **DB:** new column `shorts.medium TEXT NOT NULL DEFAULT 'short_native'` (migration 0XXX). Existing rows backfilled by mapping `kind`: `'extracted' → 'short_native'`, `'external_seo'` stays untouched (separate concern). New `kind = 'channel_clip_recommendation'` for Mode A rows. Both `kind` and `medium` survive — `kind` keeps the existing CHECK semantics, `medium` is the new strategy dispatcher.
- **TS:** `src/lib/content-medium.ts` exports the enum + a `MediumStrategy` interface (one per medium) with `promptFor()`, `qaScorerFor()`, `seoRulesFor()`, `renderTargetFor()`. Long-form gets a strategy too — wraps existing behavior, zero new branches in caller code.
- **UI:** `<MediumToggle>` component in `src/components/medium-toggle/`. URL state via `?medium=`. Each of the 4 section pages reads it from `useSearchParams()` and dispatches into the strategy.

### Where sections fit in

Section = lens, not format owner. Each section page (`/ideas`, `/generator`, `/qa`, `/seo`) gets:

```tsx
const medium = useMedium();  // reads ?medium= with 'long_form' fallback
const strategy = getMediumStrategy(medium);  // returns the right object
// renders <strategy.IdeaSurface /> (or ScriptSurface / QaSurface / SeoSurface)
```

Strategies own their prompts, scorers, SEO rules, and rendering targets. Sections own their layout.

### Hook as a first-class object

Council caught: Shorts live or die in the first 1.5s. We bake `hook` as a primitive on `short_native` and `short_clip`:

- Mode A's scorer scores each candidate moment's first 1.5s caption-line as a `hookScore` (0–100) — that's a major component of the ranking.
- Mode C's QA strategy has a dedicated `hookCriterion` (0–100) that runs over the first 1.5s of the generated script.
- `src/lib/hook-scoring.ts` is the pure helper. Tested in isolation.

## 6. Alternatives rejected

| # | Alternative | Why rejected |
|---|---|---|
| A1 | Format toggle per section, no medium primitive — just `?format=short` flag threaded into existing prompts | Council: rots into `if (format === 'shorts')` branching in every prompt builder, scorer, and renderer within a month. Long-form assumptions leak. Phase 2 spends time ripping them back out. |
| A2 | Dedicated `/shorts/*` sub-routes (/shorts/ideas, /shorts/qa, /shorts/seo) | Doubles surface area. User has to remember two homes for everything. Council Outsider: "going to make people pick the wrong one constantly." Fails the lazy-user bar. |
| A3 | Unified "Shorts Studio" hub keeping other sections long-form only | Doesn't satisfy the user's stated goal ("be an option for all sections"). And duplicates ideation + scripting + QA + SEO logic just for shorts. |
| A4 | Build all three modes (A + B + C) in v1 | Council Contrarian: Mode B's `ffmpeg + smart-reframe + auto-caption` is 4–6 weeks of video-editor infra, not 1 week. Face tracking unscoped, caption-burn-in quality below CapCut bar, 300s budget blown by 30-min sources, malware/size caps + Blob bill spike risk + Content ID landmine. Defer until A+C prove use. |
| A5 | Mode B v1-lite with dumb center-crop, no face tracking | Council Executor: "center-crop cuts heads off, users hate it." Footgun. |
| A6 | Shorts style registry separate from production-doc styles | Council split 3-2. Decision: **share** the registry. Aspect-ratio is a render parameter, not a style identity. Forking creates drift. Vertical safe-zone + caption burn-in + hook-frame rules become *style variants* (`paint_explainer_v1_short` / `doodle_explainer_2_short` siblings to their long-form entries), not a separate system. |
| A8 | Build all 3 vertical styles in Phase 2 (single 3–4 week phase) | Council Contrarian's "ships broken because we tried too much" failure mode. User picked the layered alternative: Phase 2 ships picker contract + Minimal only; Phase 2.5 ships Doodle vertical; Phase 2.75 ships Paint vertical. Each phase is independently QA-able. |
| A7 | Pull `yt-dlp` to download the source video for Mode A | Against YouTube ToS. Risks the user's channel. Not built. |

## 7. Phase breakdown

### Phase 0 — Verification ✅ DONE

Verified all six facts in §4. Council's load-bearing concern (does `publishing.ts` handle Shorts?) closed: yes, vertical 9:16 ≤180s is auto-detected by YouTube.

### Phase 1 — Medium primitive + Mode A + auto-fan-out + hook scorer (week 1)

**What ships:**

1. Migration 0XXX: `ALTER TABLE shorts ADD COLUMN medium TEXT NOT NULL DEFAULT 'short_native'`; backfill from `kind`; add `'channel_clip_recommendation'` to `shorts_kind_check`; add `source_youtube_video_id TEXT` column (FK-less, references YouTube's ID); add `clip_start_ms / clip_end_ms INTEGER` for Mode A timecodes; add `dismissed_at TIMESTAMPTZ` for the global Shorts inbox sweep; add `hook_score REAL` for both display + ORDER BY in the inbox.
2. `src/lib/content-medium.ts` — the enum, `MediumStrategy` interface, `getMediumStrategy(medium)` dispatcher, three strategy implementations (long_form, short_clip, short_native). Long-form strategy wraps existing prompts/QA/SEO with zero behavior change.
3. `<MediumToggle>` component + `useMedium()` hook reading `?medium=` from the URL with `long_form` fallback. Mounted in the headers of `/ideas`, `/generator`, `/qa`, `/seo`. Per the user's existing nav pattern.
4. Each of the four sections gains a strategy-dispatched surface. For Phase 1, `short_clip` strategy only fully implements the Scripts and Ideas surfaces (these are the highest-value entry points); QA + SEO get a "coming next week" empty state for `short_clip` rows. `short_native` defers to Phase 2.
5. **Mode A — Find clips from a channel video**: `/api/channel-videos` (lists user's published videos via YouTube Data API), transcript fetch, transcript scorer in `src/lib/clip-scorer.ts` (pure helper, scores moments by hook strength + payoff strength + standalone-ness + density), top-N candidates with timecodes, deep link `https://studio.youtube.com/video/{id}/edit?t={start}` returned. Persisted as `kind='channel_clip_recommendation'`, `medium='short_clip'` rows in `shorts`.
6. **Hook scorer** — `src/lib/hook-scoring.ts` pure helper. Used by Mode A's clip scorer AND by Phase 2's `short_native` QA criterion. Lands in Phase 1 even though `short_native` QA doesn't ship until Phase 2 — the helper has to exist for both downstream paths to share it cleanly.
7. **Auto-fan-out tray (dual surface):** when a long-form render completes (existing `/api/render/video` flow), fire an internal "long_form_rendered" signal. New `src/lib/auto-fan-out.ts` reads the long-form script + transcript, runs the clip scorer over the script timeline (no AI cost — it's a deterministic-ish scorer with one cheap AI call for hook scoring), creates 3 `short_clip` candidate rows attached to the project. Surfaces in **two places** per the user's pick:
   - **Project detail (`/projects/[id]`):** "3 Short candidates ready from this video" tray next to the rendered video — context-bound.
   - **Global Shorts inbox (`/shorts?tab=inbox`):** aggregates all pending `short_clip` candidates across projects for batch workflow. Adds a `dismissed_at TIMESTAMPTZ` column to `shorts` (migrated in step 1 above) so the user can sweep stale candidates without deleting rows.
   Cross-project query is workspace-scoped, paginated 50/page, ORDER BY hook_score DESC NULLS LAST.

**Observability namespaces (rule 14):**

- `[shorts medium toggle]` — every `?medium=` change emits a log on each section page with `{ from, to, section }`.
- `[shorts mode-a list]` — channel-videos list fetch, with `{ workspaceId, channelDbId, count }`.
- `[shorts mode-a transcript]` — transcript fetch, with `{ youtubeVideoId, segments, durationSeconds, source: 'auto-gen' | 'manual' }`.
- `[shorts mode-a score]` — once per scoring run with `{ youtubeVideoId, candidateCount, topScore }`.
- `[shorts hook-score]` — every hook-scoring call with `{ source: 'mode-a' | 'mode-c-qa', textPreview, score }`.
- `[shorts auto-fan-out]` — `{ projectId, longFormScriptId, candidatesCreated, candidatesSkipped, reason? }`.
- `[shorts strategy dispatch]` — every section's strategy lookup with `{ section, medium, surface }`.

**Settings audit (rule 15):**

| Setting | Default | Surface | Why |
|---|---|---|---|
| `shorts.auto_fan_out_enabled` (per workspace) | `true` | `/settings?section=shorts` (new tab in existing settings) | Some users will hate surprise AI work. Cheap to flip. |
| `shorts.auto_fan_out_count` (3, 5, 0) | `3` | same tab | "How many candidates per long-form render" — 0 effectively disables. |
| `shorts.default_target_seconds_mode_a` | `45` | same tab | The transcript scorer's window. Existing `TARGET_DURATION_SECONDS_DEFAULT` constant moves here. |
| `shorts.hook_score_threshold` (40, 60, 80) | `60` | same tab | Below this, candidate gets a "weak hook" tag in the UI so the user filters. |
| Per-section medium default (long_form / short_native / remember-last) | `remember-last` | same tab | Power-user knob — some users want Ideas to always open in Shorts mode. |
| Style picker default for `short_native` | unset, prompts on first render | not in v1 settings — Phase 2 surface | Picker lives in the render dialog. Per the council's "user should pick the style they want." |

**Security section (rule 13):**

- Mode A reads public captions via `youtube-transcript`. No new auth surface. Existing rate limiting on the channel-videos endpoint covers it.
- Mode A's deep link to YT Studio is a static URL pattern — no injection surface beyond the existing `youtubeVideoId` validation.
- Auto-fan-out reads the user's own long-form scripts in their own workspace. Workspace scoping enforced via `apiRoute.authed` + `workspace_id` filter on every read.
- No user-uploaded files in v1 (Mode B is deferred). No malware scan / size cap concerns this phase.
- Cost-burning surface: the auto-fan-out fires one Haiku call per long-form render (3 hook scorings — batched into one call). Capped at one fan-out per long-form render via the idempotency of the project_id + source_script_id pair. Settings toggle lets users disable.

**Testing (rule 18):**

- `tests/clip-scorer.test.ts` — golden path (typical transcript), edge cases (1-segment transcript, all-silence, missing offset, very-long-segment, multi-language), error paths (empty input, non-finite values).
- `tests/hook-scoring.test.ts` — known-strong hooks score >80, known-weak hooks score <40, empty input returns 0, length boundary (≤1.5s).
- `tests/content-medium.test.ts` — strategy dispatch returns the right object for each medium, falls back to long_form on unknown input, every strategy implements the full interface.
- `tests/auto-fan-out.test.ts` — given a long-form script + transcript, produces N candidates ordered by score, skips when settings disable, idempotent across replays.
- `tests/medium-toggle.test.tsx` — toggle component renders with current medium, switching updates the URL, `useMedium()` reads with fallback.
- Existing `tests/shorts.test.ts` and `tests/shorts-render.test.ts` stay green.

**Cost implications (rule 8):**

- One Haiku call per auto-fan-out (3 candidate hook scorings batched). Per current Anthropic pricing (verified at planning time): Haiku $0.80 / M input + $4 / M output. Per call: ~3K input + ~500 output = ~$0.005. At 30 long-form renders/mo per active workspace = ~$0.15/mo per active workspace. Negligible. Logged via the existing `ai_spend_log`.
- One Haiku call per Mode A explicit "Find clips" invocation (full transcript scoring + hook pass). ~5K input + ~1K output = ~$0.008.
- No new third-party costs.

**Definition of done:**

- Full test suite green (currently 791/791).
- Manual QA pass (rule 6): golden path — flip Ideas / Scripts / QA / SEO to Shorts mode, observe strategy dispatch logs, run Mode A on a real channel video, click the YT Studio deep link, see the candidate row in the `shorts` table, trigger an auto-fan-out by rendering a long-form video.
- Settings audit complete — every new setting from the table above is in the UI.
- Roadmap updated in the same commit (Phase 11.1).

### Phase 2 — Mode C + style picker contract + QA/SEO/Ideas Shorts strategies + Minimal-only style (week 2, ~1.5 weeks)

**What ships:**

1. **Mode C** — channel-video picker → top-N clip candidates (reuses Phase 1's clip scorer) → "Generate Short from this moment" button → feeds the moment's transcript excerpt into the existing extractor at `src/lib/shorts.ts` → spins a `kind='extracted'`, `medium='short_native'` row → voiceover + render flow already exists from Phase 5.5.
2. **Style picker contract at render time.** New `<ShortStylePicker>` component in the render dialog. Reads from a `SHORT_STYLES` registry (`src/lib/short-styles.ts`) modeled on `production-doc-styles.ts`. **Phase 2 entries:** `minimal_gradient_v1` only (the existing composition). The registry contract supports `paint_explainer_v1_short` and `doodle_explainer_2_short` as future entries from day one — adding each style in 2.5 / 2.75 is a contract-conforming PR, not a refactor.
3. **QA strategy for `short_native`** — `src/lib/shorts-qa.ts` lean panel with criteria: hook strength (uses Phase 1's hook scorer), 3-second rule, payoff clarity, caption readability, loop potential, vertical-safe-zone (does the script's emotional arc complete in ≤60s). Single AI call, ~$0.02 per Short. Rendered in `/qa` when `medium=short_native`. Long-form `/critics` panel untouched.
4. **SEO strategy for `short_native`** — `src/lib/shorts-seo.ts` (already exists for `external_seo`) is extended to take an in-app `short_native` row and grade it. Rules: 3–5 hashtags max, description ≤150 chars (the part that shows above the fold on mobile Shorts), no chapters, no `#Shorts` injection (verified Phase 0).
5. **Ideas strategy for `short_native`** — `src/lib/shorts-ideas.ts` prompt-builder that asks for hook-first vertical-friendly topics with explicit 60s-payoff structure. Existing ideas-generator route accepts a `medium` parameter and routes through the strategy.

### Phase 2.5 — Doodle Explainer 2 vertical style (~2–3 days)

**What ships:**

- `doodle_explainer_2_short` entry in the `SHORT_STYLES` registry (contract from Phase 2). Reuses doodle_explainer_2's near-static + Atlas Edit sibling-frame mechanism (per the user's memory: "near-static animation = Atlas Edit variants from a base; NEVER Remotion motion on a static image").
- Base-frame regeneration or smart-crop pipeline for 9:16 aspect (Atlas Image gen if regenerated; vertical-safe-zone crop if reusing existing assets).
- On-screen text positioning recalibrated for vertical safe-zone (top + bottom 10% reserved for YouTube UI chrome; subtitle band lives in the middle 60%).
- Per the user's Doodle architecture, no Remotion motion is introduced on static frames — keep the Atlas-Edit-variant contract intact.
- Tests: golden-path render at 1080×1920 with N variants, vertical-safe-zone math.

### Phase 2.75 — Paint Explainer V1 vertical style (~5–8 days)

**What ships:**

- `paint_explainer_v1_short` entry in the `SHORT_STYLES` registry. Reuses Paint Explainer V1's motion-driven hand-drawn pipeline (mouth-swap, polaroid frames, label-pops, scribble-draw, micro-wiggle, prop-slide-in).
- Vertical reframe math for every motion-beat kind:
  - `MouthSwap` — recenter the character body within 9:16 with safe-zone for caption band.
  - `RealPhotoPunchIn` / polaroid frames — switch to portrait polaroid aspect, recompute Ken-Burns bounds.
  - `LabelPopOn` — caption band lives in the middle 60%; label pops sit above or below the caption, never overlap.
  - `ScribbleDraw`, `MicroWiggle`, `PropSlideIn` — repositioning math in component props (`src/remotion/components/*`), no logic rewrite.
- Shot pacing recalibration: long-form Paint Explainer V1 uses 2.5–3.0s shots over a 5–10 min runtime. Shorts are ≤60s. Decision: keep 2.5–3.0s shots (proven snappy pacing), shorten the total beat count, drop intros/outros that are vestigial at this scale. Document the picker's "short-form shot count target" in `src/lib/production-doc-styles.ts`.
- `PaintExplainerV1SettingsPanel` extended with a vertical-output toggle (or a separate vertical-only panel — decide during build).
- New character mouth-removed cache + anchor vision pass still apply (same pipeline). Cache hits across long-form ↔ short.
- Tests: motion-beat positioning math (pure helpers), one end-to-end render at 1080×1920.

**Phase 2.5 + 2.75 observability:**
- `[shorts style-build doodle-vertical]`, `[shorts style-build paint-vertical]` namespaces for the build-time + first-render logs.
- Each style entry's first render emits `{ styleId, shotCount, sceneCount, durationMs, assets: { mouthRemoved, polaroidCount, propCount } }`.

**Observability:**

- `[shorts mode-c spin]` — `{ youtubeVideoId, clipMomentMs, projectId, scriptCharCount }`.
- `[shorts qa-strategy]` — per-criterion score with `{ criterion, score, weight }`.
- `[shorts seo-strategy native]` — `{ shortId, suggestionCount, topScore }`.
- `[shorts style-picker]` — `{ shortId, styleId, fallback? }`.

**Settings audit:**

| Setting | Default | Surface |
|---|---|---|
| `shorts.default_style_id` | first-style-in-registry | `/settings?section=shorts` |
| `shorts.qa_weights` (hook / payoff / caption / loop / safe-zone) | balanced preset | same tab — power-user accordion |
| `shorts.seo_hashtag_target_count` (3–5) | `4` | same tab |
| `shorts.short_native_target_seconds` | `45` | same tab — feeds the extractor |

**Security:**

- No new attack surface beyond Phase 1. Reuses workspace-scoped reads + the existing render orchestration's safety model.
- Render orchestration cost-gates: existing `cost-gate.ts` pattern applied — Phase 2 must not silently spin a $0.50 render on every page click.

**Testing:**

- `tests/shorts-qa.test.ts` — each criterion in isolation + weighted aggregate + edge cases.
- `tests/shorts-seo.test.ts` already exists for `external_seo`; extend for `short_native`.
- `tests/shorts-ideas.test.ts` — prompt builder produces format-correct Shorts ideas for known topics.
- Mode C integration test: from a synthetic transcript moment, full path to a renderable `short_script`.

**Cost:**

- Each Mode C spin: extractor call (Sonnet, ~$0.05) + voiceover (ElevenLabs ~$0.02 for 45s) + render (Remotion + Vercel Blob storage, negligible) = ~$0.07 per Short. The user pays for this explicitly (button click), not background.

**Definition of done:**

- All Phase 1 criteria still hold.
- Mode C produces a renderable Short from a real channel-video moment.
- Style picker shows ≥2 styles, user can pick, render reflects the choice.
- All four section pages have a `short_native` strategy implementation.
- Roadmap updated (Phase 11.2).

### Phase 3 (deferred) — Mode B (Clip my upload)

Out of scope for this plan. When/if revisited:

- Standalone plan file `_plans/YYYY-MM-DD-shorts-mode-b-upload.md`.
- Scope: Vercel Blob upload route with malware scan + size cap (e.g. 1 GB / 30 min), Whisper transcription, ffmpeg via Vercel Sandbox or serverless ffmpeg layer, face-tracked smart-reframe (CV model required — autoflip or vision-API equivalent), background-job orchestration (300s budget will be blown otherwise), Content ID disclaimer at upload.
- Cost: Whisper $0.36/hr source, Vercel Blob storage + bandwidth, vision/CV per-frame cost. Real numbers go in the Mode B plan.

### Phase 4 (deferred) — Series engine + style depth

Out of scope. When revisited:

- "Series" concept in the `shorts` table (`series_id`, `series_name`, `locked_style`, `intro_outro`, `posting_cadence`).
- Paint Explainer V1 + Doodle Explainer 2 as full 9:16 style variants (motion-beats, mouth-swap, polaroid frames adapted to vertical).
- Scheduled publishing of series cadence.

## 8. Resolved decisions (2026-06-02)

1. **Vertical styles — all 3, sequenced.** Phase 2 ships the style-picker contract + Minimal only. Phase 2.5 ships Doodle Explainer 2 vertical (lighter, 2–3 days). Phase 2.75 ships Paint Explainer V1 vertical (heavier, 5–8 days). Picker registry contract supports all 3 from day one — adding each style is a contract-conforming PR. Rationale: working Shorts pipeline in 1.5 weeks, visual depth layered on as we learn which styles get reached for.
2. **Source scope for Mode A — own connected channels only.** The channel-video picker lists videos from channels the user has connected via OAuth. Pasting an arbitrary YouTube URL is blocked. Safer scoping, fits the existing per-channel workflow. Revisit if competitor-clip analysis becomes a real ask.
3. **Auto-fan-out tray — project detail page + global Shorts inbox.** Both surfaces in v1. Project detail (`/projects/[id]`) shows candidates next to the source video for context. Global Shorts inbox (`/shorts?tab=inbox`) aggregates pending candidates across projects for batch-publishing workflow. Adds ~2 days to Phase 1 scope (new tab + dismiss-state column + cross-project query).
4. **QA strategy for `short_native` — lean Shorts-only panel.** New lightweight QA at `/qa` for `short_native` rows: hook strength, 3-second rule, payoff clarity, caption readability, loop potential, vertical safe-zone. Single AI call (~$0.02). Long-form `/critics` panel untouched. Rationale: 60-second scripts don't justify the 5+ critic-call cost (~$0.30 each) of the long-form panel.

## 9. Open at Phase 2 kickoff

- Which style to build *first* of Phase 2.5 / Phase 2.75 sequence is settled (Doodle then Paint), but the QA bar on each vertical render should be reviewed against real generated content before locking the style-registry entry as production-ready.

## 10. Roadmap update

After Phase 1 ships: add to ROADMAP.md as Phase 15 — "Shorts everywhere v1". (Phase 11 is already used for the editor upload hardening; Phase 12–14 are taken too.) Sub-items 15.1 (Phase 1 — medium primitive + Mode A + auto-fan-out + dual surface inbox), 15.2 (Phase 2 — Mode C + style picker contract + QA/SEO/Ideas strategies + Minimal style), 15.3 (Phase 2.5 — Doodle Explainer 2 vertical), 15.4 (Phase 2.75 — Paint Explainer V1 vertical). Phase 3 (Mode B) + Phase 4 (series engine) land as "Beyond Phase 15" placeholders.

## 11. Council verdict reference

Full transcript is in this turn's conversation. Headlines:

- Strongest argument (3/5 reviewers): the medium-primitive reframe (First Principles).
- Most concrete structural call (2/5 reviewers): the strategy-object + observability + settings + security findings (Contrarian).
- Most undervalued opportunity baked in: auto-fan-out as the compounding wedge (Expansionist).
- Biggest reframe ignored at first: the toggle-per-section was the wrong abstraction (rolled into the medium primitive).
- Biggest collective miss the peer review caught: YouTube Shorts publishing contract verification. Closed in Phase 0 above.
