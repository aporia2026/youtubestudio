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

## Beyond Phase 4 (not in original audit, parking lot)

Surfaced in conversation but **not** in the original May 1 audit. Pick one of these only after Phase 4 ships, and only if it's still useful then:

- Comment & community management — pull YouTube comments, AI-triage, reply, pinned-comment automation
- Competitor intelligence dashboard — `competitor_channels` + `competitor_videos` already exist, no consumer UI yet
- Shorts → MP4 render (Remotion 1080×1920) — explicitly deferred from Phase 3 PR #2
- End-to-end workflow triggers — "when video publishes, auto-create A/B test", "when CTR drops below X, suggest swap"
- Spend tracker — per-API per-project AI cost log

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
