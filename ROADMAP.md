# Roadmap

Source of truth for what's planned, in flight, and shipped. **Update this file in the same commit that ships a feature** — new sessions read it before starting work to avoid duplicating shipped items or renaming phases.

## Origin

This roadmap was written during the **May 1, 2026 system audit** (response to "extreme robust insane review" prompt). The four-phase structure was committed to then; sub-items inside each phase have evolved as work progressed.

A more detailed file-by-file plan exists for Phase 1 in [PHASE1_PLAN.md](PHASE1_PLAN.md). Phases 2–4 were planned in conversation and tracked here.

## Status legend

- ✅ Shipped (in production, migration applied to prod DB)
- 🚧 In flight
- ⏸ Not started
- ❌ Cancelled (with reason)

---

## Phase 1 — Foundation ✅

Auth + multi-tenancy + encryption at rest + CI + rate-limit + observability + test harness. See [PHASE1_PLAN.md](PHASE1_PLAN.md) for the detailed plan that drove this phase.

Migrations: **0001–0015** (rate limits) + **0016** (channels brand kit, started Phase 2).

## Phase 2 — Multi-channel ergonomics ✅

| PR | Topic | Status |
|---|---|---|
| #1 | Channel switcher in top bar | ✅ |
| #2 | Per-channel brand kit + auto-pipe into script gen + QA | ✅ |
| #3 | YouTube Analytics ingestion | ✅ |
| #4 | Dashboard rebuild — "what needs your attention today" | ✅ |
| #5 | Workspace scoping on top routes + CI lint gate | ✅ |
| Hardening | Post-Phase-2 code review fixes (P0 channel UNIQUE + P1s) | ✅ |

Migrations: **0016–0019**.

## Phase 3 — 2026 table-stakes features ✅

| PR | Topic | Migration | Status |
|---|---|---|---|
| #1 | Auto-dubbing pipeline (translation + ElevenLabs multilingual) | 0020 | ✅ |
| #2 | Shorts pipeline (script-to-Short extractor + voiceover) | 0021 | ✅ |
| #3 | Veo 3 / Sora 2 B-roll per shot (Production Doc per-row) | 0023 | ✅ |
| #4 | Native YouTube A/B title + thumbnail (videos.update + snapshots) | 0024 | ✅ |

Notes:
- Migration **0022** (production_doc_styles) shipped in parallel, not part of Phase 3.
- Shorts → MP4 render (Remotion 1080×1920) was **deferred** from PR #2 — see Beyond Phase 4 below.

## Phase 4 — Innovative differentiation ✅

| Sub | Topic | Status | Notes |
|---|---|---|---|
| 4.1 | **Court of Critics live** — stream the existing 4-phase panel as it runs + persist full deliberation transcript + real-time courtroom UI | ✅ | Migration 0025. AsyncGenerator wrapper at [src/lib/script-critics/runner-live.ts](src/lib/script-critics/runner-live.ts) reuses the original normalizers; SSE route streams + persists each event; `/critics` page renders critic cards filling in as drafts complete. |
| 4.2 | **Retention-curve predictor** — predict viewer drop-off shape from a script before publish | ✅ | Migration 0026. RAG over `video_analytics.retention_curve` (workspace's own past videos), scopes by channel when possible. Outputs predicted curve + per-segment drop forecast + cross-segment fixes. AVP recomputed from curve (LLMs misintegrate). UI at `/retention`. |
| 4.3 | **Fix-the-dip** — detect retention drops in published videos + suggest specific script/edit fixes at the timecodes that drop | ✅ | Migration 0027. Two-stage: deterministic dip detection (sliding window over `video_analytics.retention_curve`, no LLM) → AI alignment of each dip to script section + per-dip fix + cross-cutting patterns. UI at `/fix-the-dip` with curve overlay marking each dip. |
| 4.4 | **Cross-channel cannibalization detector** — same niche + same audience + competing uploads warning | ✅ | Migration 0028. Pulls scheduled + recently-published uploads across the workspace, finds cross-channel pairs in a ±7-day window, scores Jaccard similarity over significant title tokens, top-10 above threshold get an AI explanation + concrete fix. UI at `/cannibalization` with dismiss. |
| 4.5 | **"Ask Studio" agent over your own DB** — natural-language query of analytics + project state | ✅ | Migration 0029. Anthropic native tool-use loop over a curated 9-tool read-only catalog (channels, recent/top/underperforming videos, scheduled items, projects, A/B tests, per-channel upload counts, single-video deep-dive). Every executor auto-scopes to workspace_id. Hard caps: 6 iterations, 50 rows/tool. UI at `/ask-studio` with suggested prompts + collapsible tool trace. |
| 4.6 | **Mobile narrator PWA** — installable, offline-capable narrator portal | ✅ | Service worker scoped to `/narrator/` (cache-first static, stale-while-revalidate HTML, network-first API, never caches non-GET so uploads always hit network). Manifest + iOS web-app meta + safe-area inset support + install pill (Android beforeinstallprompt) + iOS A2HS hint with localStorage dismissal. Offline fallback page. |
| 4.7 | **Slack/Discord webhooks** — send events (A/B winner, cannibalization, panel completed, retention dip) to an ops channel | ✅ | Migration 0030. Per-workspace subscriptions (Slack/Discord/generic) with per-event filters; URLs encrypted at rest, only `url_preview` exposed; URL validation gates host (hooks.slack.com / discord.com / discordapp.com) + blocks loopback/private addrs. Fire-and-forget dispatcher with full delivery audit log. Wired producers: A/B test conclude + high-risk cannibalization. Test-webhook button. |

## Phase 5 — Operational depth ✅

Promoted from "Beyond Phase 4" parking lot on 2026-05-02 after Phase 4 fully shipped. Theme: features that deepen day-to-day operability of the system Phase 1–4 built.

| Sub | Topic | Status | Notes |
|---|---|---|---|
| 5.1 | **Comment & community management** — pull YouTube comments per channel, AI-triage by intent, reply + moderate from inside the app | ✅ | Migration 0031. Sync via public Data API (cheap), AI triage via Haiku into 8-intent enum (question/support/fan/feedback/troll/spam/self_promo/other) with suggested-reply per comment, reply + hold/reject via channel OAuth. UI at `/comments` with intent-pill counts, video filter, unreplied filter, restore-AI-suggestion button. Pinning skipped (not in YouTube public API as of May 2026). |
| 5.2 | **Workflow triggers** — "when CTR drops below X, auto-create a fix-the-dip"; "when A/B concludes, auto-snapshot 7 days later" | ✅ | Migration 0032. Rules = (event, condition, action, delay). Producers fire on ab_test_concluded / cannibalization_high_risk / video_analytics_synced. Conditions are a small DSL (lt/gte/equals/in/exists/all/any) over event payload. Hourly Vercel cron drains the queue (CRON_SECRET-gated). 4 actions: sync_video_analytics, run_dip_analysis, run_cannibalization_scan, send_webhook_event. UI at `/workflows` with rule builder + recent action runs. |
| 5.3 | **Competitor intelligence dashboard** — cross-channel signals on top of the existing per-competitor `/competitors` page | ✅ | No new migration. New aggregator at [src/lib/competitor-summary.ts](src/lib/competitor-summary.ts) (PERCENTILE_CONT for 30d view-count median, single-query per-channel cadence + momentum). New page `/competitors/dashboard` with KPI strip, recent breakouts (≥ 2.5× channel median, last 14d), per-channel momentum table, accelerating/stalled callouts. Compact `CompetitorSignalsCard` lifted into the main `/dashboard`. |
| 5.4 | **Spend tracker** — per-API per-project AI cost log | ✅ | Migration 0033. Pricing registry in `src/lib/ai-pricing.ts` (Anthropic + OpenAI + Google direct + Kie market routes; cached-input discount). `generateText` accepts an optional `spend` context — Anthropic/OpenAI/Google branches capture token usage from SDK responses + fire-and-forget log. Wired callers: retention_predictor / fix_the_dip / comment_triage. UI at `/spend` with KPI strip, daily bar chart, by-feature/by-model/by-project breakdowns, top-10 most-expensive calls. |
| 5.5 | **Shorts → MP4 render (Remotion 1080×1920)** — closes the Shorts loop (extract → voiceover → render → publish) | ✅ | No new migration (reuses existing `render_jobs` table + `shorts.rendered_video_url` column from migration 0021). New Remotion composition `ShortVideo` registered in [src/remotion/Root.tsx](src/remotion/Root.tsx) — 1080×1920, gradient bg, title chip, large center captions with last-word accent, optional channel pill, ElevenLabs voiceover. Pure helpers in [src/lib/shorts-render.ts](src/lib/shorts-render.ts) (sentence-aware caption splitter, config builder). New route `/api/render/short` mirrors the existing `/api/render/video` orchestration (Remotion bundle + renderMedia + Vercel Blob upload + persist `rendered_video_url`). UI integration on `/shorts` with self-contained progress bar + inline player. |

## Phase 6 — Polish ✅

Promoted from "Beyond Phase 5" parking lot on 2026-05-03. Theme: harden the surfaces shipped in Phases 4-5 — observability, configurability, and error handling — without adding new user-facing features.

| Sub | Topic | Status | Notes |
|---|---|---|---|
| 6.1 | **Spend instrumentation sweep** — wire `spend` context through every server-side `generateText` call so `ai_spend_log` captures all 30+ AI calls, not just the 3 starter ones | ✅ | No new migration. Threaded `AiSpendContext` through 20+ routes and lib functions (script-critics charter/draft/deliberation/chair, video composer stages, cannibalization, dubbing, shorts, comment triage, etc.). New helper `makeSpendContext()` in [src/lib/ai-spend.ts](src/lib/ai-spend.ts) for raw POST routes that lack a session in scope. Per-stage `featureArea` labels (e.g. `critic_panel_live_deliberation_hook-coach`) so the spend dashboard can attribute cost to the exact phase that ran it. Commit `e7ba3c7`. |
| 6.2 | **Per-workspace AI model defaults** — workspace/section/feature override system replacing localStorage flat map | ✅ | Migration 0034. Three resolver tiers (workspace → section → feature → hardcoded fallback) with 5s per-workspace cache. `APP_FEATURES` expanded from 9 to 28 entries — every Phase 4/5 surface now declares its section + hardcoded default. Settings UI at `/settings?section=models` rebuilt as three stacked cards (Workspace default / By section / Per-feature accordion grouped by section), each picker reuses the search-enabled `ModelSelector`. Server side: `getEffectiveModelId(workspaceId, feature)` wired into all 7 lib functions (cannibalization, ask-studio, comment-triage, fix-the-dip, retention-predictor, shorts, dubbing) + 4 routes that previously hardcoded model literals. Background jobs honour the user's overrides — not just foreground UIs. 14 tests cover scope codec round-trip + four-tier precedence + catalogue invariants. Commits `45e11c3` / `12a95ae` / `62a33af`. |
| 6.3 | **Error-path hardening sweep** — replace 16 copy-pasted catch-and-leak blocks with a single typed helper | ✅ | No new migration. New `domainErrorResponse(err, opts)` helper in [src/lib/route-helpers.ts](src/lib/route-helpers.ts) with two-tier classification: known patterns → log at WARN + pass-through (4xx, user-facing); unknown → log at ERROR with full detail + return generic message (5xx). Applied across 16 Phase 4/5 action routes (ab-tests×4, ask-studio, cannibalization, comments×4, retention×2, shorts/voiceover, webhooks, workflows×2). Net wins: no more `err.message` leaks in 5xx, every error path is logged for operability, status codes are now consistent (404 not-found, 400 validation, 502 upstream/AI). 5 new tests cover the helper. Commits `0e27538` / `46369e4`. |

## Phase 7 — Publishing pipeline ✅

Promoted on 2026-05-03 after Phase 6 shipped. Theme: close the production loop — let the user upload a finished video to YouTube directly from the app, without leaving for YouTube Studio.

| Sub | Topic | Status | Notes |
|---|---|---|---|
| 7.1 | **Publishing pipeline — migration + lib** — `published_videos` table tracking upload lifecycle (queued / uploading / processing / live / failed), thumbnail upload, playlist add. Lib wraps the YouTube `videos.insert` + `thumbnails.set` + `playlistItems.insert` flow with per-step error handling | ✅ | Migration 0035. Pure helpers in [src/lib/publishing-types.ts](src/lib/publishing-types.ts) (validatePublishRequest with YouTube limits, snippet/status builders, state machine, URL builder) — 33 tests. Orchestrator in [src/lib/publishing.ts](src/lib/publishing.ts) reuses `getValidAccessToken` and `uploadThumbnailOAuth` rather than re-implementing OAuth refresh + thumbnail upload. videos.insert wired via `multipart/related` (single-request — fits ≤256MB; resumable can come later if users hit the cap). Thumbnail + playlist add are best-effort: failures get appended to error_message but don't fail the publish. `pollPublishStatus(id, workspaceId)` flips processing → live by polling videos.list. `pollAllPendingPublishes()` drains all 'processing' rows for the cron + fails rows stuck > 1h. |
| 7.2 | **Publishing API routes + UI on schedule item / project detail** — POST `/api/publishing/upload` (kicks off upload), GET `/api/publishing/status/[id]` (polls for live status), DELETE for cancel. UI on `/schedule/[id]` and `/projects/[id]` with a "Publish to YouTube" button that opens a modal: title / description / tags / category / privacy / playlist / publishAt timestamp / thumbnail. Live status badge once upload starts | ✅ | POST/GET `/api/publishing` and GET `/api/publishing/[id]` (auto-polls YouTube once when status='processing' so a single fetch always returns the freshest signal). Hourly cron at `/api/cron/poll-publishing` drains pending rows + fails > 1h-stuck (wired in vercel.json with same CRON_SECRET pattern as run-workflows). [PublishToYoutubeModal](src/components/publishing/PublishToYoutubeModal.tsx) — full form with channel auto-pick when one OAuth-connected channel exists, status panel polls every 5s once submitted. Surfaced from `ItemDetail` (schedule) next to "Prepare for YouTube" with all metadata pre-filled, and from `/projects/[id]` action row. **Per the menu-organization rule: no new top-level nav entry — Publish is an action surfaced from the contexts where you already have a finished video.** |
| 7.3 | **Wire `video_published` event into workflow trigger system** — fires when 7.1 sets status = live, lets workflows react ("when video published, post to Slack", "when video published, schedule a 7-day analytics snapshot") | ✅ | `video_published` added to both `WORKFLOW_TRIGGER_EVENTS` (with payload_fields: publish_id, youtube_video_id, youtube_url, channel_db_id, project_id, schedule_item_id, title, privacy_status) and `WEBHOOK_EVENT_TYPES`. `emitVideoPublishedEvent(id, workspaceId)` fired fire-and-forget from `pollPublishStatus` when status flips to 'live' — lazy imports for webhooks + workflows to keep deps out of consumers. Mirrors the ab-tests / cannibalization producer pattern. Two new tests assert both registries include the event so a future regression is caught. |

---

## How to update this file

When you **start** a sub-item: flip ⏸ → 🚧.
When you **finish** a sub-item:
1. Flip 🚧 → ✅
2. Add the migration number(s) it required
3. Commit the change to ROADMAP.md in the **same** PR that ships the feature.

When you **cancel** a sub-item: flip → ❌ with a one-line reason.

If a phase grows past ~10 sub-items or the file past ~200 lines, split it into its own `PHASE<N>_PLAN.md` (like Phase 1 did) and keep this file as the index.

**Don't invent new phase numbers or rename sub-items mid-flight.** New work goes under "Beyond Phase 4" until promoted by an explicit decision.
