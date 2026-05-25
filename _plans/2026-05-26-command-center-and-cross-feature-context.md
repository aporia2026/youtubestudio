# Command Center + Cross-Feature Context (Hybrid C+A)

**Status:** Approved direction, plan ready for review before any code is written.
**Owner:** Yoav.
**Date:** 2026-05-26.
**Related context:** This plan follows a full audit of the app surface (45+ feature pages), the data model (projects + auto-pipeline + schedule + team), and the existing auto-pipeline state machine. The audit confirmed the data already ties features together via `projects.id`. The problem is the UX layer hides it.

---

## 1. Goals

1. **Make features feel like they talk to each other** without rebuilding any tool. A user moving from Generator to QA to Voiceover to Thumbnails to SEO should never lose their place or rebuild context.
2. **Make multi-video, multi-channel parallel work first-class.** The user produces ~20 videos per week per channel across multiple channels. The home should show what is in flight, what is stuck, what is next, at a glance.
3. **Promote the auto-pipeline mental model without forcing it.** Manual users walk the same stage chain that auto-pipeline walks. They see the same stages, the same "who is blocking," the same "next action."
4. **Do not break anything that already works well.** Listed as hard preservation constraints below.

## 2. Constraints

### Hard preservation (do not modify)

- **Production-doc editor and every production-doc feature.** This was recently built and is critical. The editor's internals, its components, its data, and the production-doc page surface stay exactly as they are. The plan only adds a context strip above the page; the page body is untouched.
- **Narrator portal** (`/narrator/[token]`) and **editor portal** (`/editor/[token]`). Magic-link dashboards stay as-is. No redesign in this plan.
- **Auto-pipeline detail page** (`/pipeline/[id]`). Keep as the canonical batch monitor. The new home cross-links to it, does not fold it in. Cost of merging is high, value is low; batch monitoring and per-video shepherding are different jobs.
- **Existing migrations and the data schema.** This plan touches one new column (`projects.current_stage`, cached) and one new table (`video_stage_transitions`, for telemetry). No destructive schema changes, no renames, no FK changes.
- **The Frame.io-style comment system** (timestamped comments, Inbox, activity feed).
- **QA gate for auto-managed videos.** The auto-pipeline's existing QA logic (per-preset `qa_min_score`, `qa_max_iterations`, critic `aggressiveness` of `standard | brutal | nuclear`) stays untouched. User's rule: a script in automated creation is approved only after multiple QA passes that reach a score of 100 in nuclear mode. The auto-pipeline already supports this via preset configuration (set `qa_min_score=100`, `aggressiveness=nuclear`, `qa_max_iterations>=N`). This plan does not change the gate logic; it only requires that `advanceVideo()` respects it (see Section 4 / R-AUTO below).

### Auto-managed vs manually-managed videos

Two paths coexist and the plan honors both:

- **Auto-managed video:** owned by an `auto_pipeline_run_videos` row. The cron is the primary driver of stage transitions. Human actions (mark done, regenerate, kill, extend narration) flow through the existing `/api/auto-pipeline/...` endpoints. For these videos, `advanceVideo()` is a thin adapter that either delegates to the existing pipeline action or, if the requested transition is gated (e.g. QA→Voiceover and score has not reached the preset threshold in nuclear mode across the configured passes), refuses the advance and surfaces a clear reason to the UI.
- **Manually-managed video:** not part of any auto-pipeline run, or in a run that has been cancelled. Stage transitions are user-driven. `advanceVideo()` writes the new stage and emits a `video_stage_transitions` row. No automatic gate; the user is in charge.

The strip's "Next stage" button and Wave 2 drag-to-advance must check the auto-managed flag before allowing the transition, and surface the gate's reason ("QA score 84 of 100 required, retry in nuclear mode") when blocked.

### Operational constraints

- The user ships ~100 videos per week right now across multiple channels. The redesign must roll out behind a feature flag with the existing Dashboard one click away for rollback at all times during Wave 1 and Wave 2.
- No paid-service additions in this plan. No new third-party costs to verify (per standing rule 8). If Wave 3 introduces a real-time presence cost (e.g. Pusher, Ably) we re-plan it then.

## 3. Requirements

| # | Requirement | Reasoning |
|---|---|---|
| R1 | Every Create-hub tool page (Generator, QA, Voiceover, Production Doc, Thumbnails, SEO, Critics, Video Studio, Shorts, Dub) loads in the context of a specific video when arrived at with `?video_id=...`, and shows a persistent context strip at the top. | Kills the "every page opens blank" problem. |
| R2 | A single new home page ("Command Center") shows in-flight videos across all channels, filterable by channel and week, with stage as the primary spatial axis. | Solves the "I cannot see what is in flight" problem at multi-channel scale. |
| R3 | A "stuck" panel on the Command Center lists videos that have not moved stage in 48 hours, scoped by the same filters. | Catches silent failures in the funnel before they bite a publish slot. |
| R4 | All four creation entry points (Ideas, Niche Finder, Schedule drop-on-date, Command Center "+", Auto-pipeline preset) produce the same `projects` row and flow through the same stage chain. | One mental model regardless of how a video is born. |
| R5 | Channel is a first-class filter and chip on every card, every tool page header, and every creation flow. | Multi-channel reality. |
| R6 | Every stage transition is logged to `video_stage_transitions` with from/to/by/when/source. | Observability per standing rule 14. Powers Wave 3 unification and the "stuck" detection. |
| R7 | All writes that change a video's effective stage funnel through one `advanceVideo(videoId, toStage, source)` function. The function body may be ugly while three state machines coexist; the seam is what matters. | Lowest-regret path against the deferred schema unification. |
| R8 | The production-doc page (`/production-doc`), the narrator portal, the editor portal, and `/pipeline/[id]` are accessed from the new home and the context strip, never reimplemented. | Hard preservation. |

## 4. Approach: Three waves

### Wave 1: Persistent video context strip (week 1)

**What ships:**

- New shared component `VideoContextStrip` rendered at the top of every Create-hub tool page when `?video_id=...` is present.
- Strip content (left to right):
  - Channel chip with color, click to filter Command Center
  - Video title (link back to Command Center)
  - Current named stage with a small "Stage Y, X of 10" hint on hover (named first, count second; the Outsider was right that "Stage 4 of 10" alone is useless)
  - **Prev stage** button (jumps to the previous tool page in the chain with `?video_id=` preserved)
  - **Next stage** button (jumps to the next tool page in the chain)
  - **Who has it open** badge — *deferred from Wave 1 to a follow-up small PR.* Building this right needs a storage decision (in-memory per-instance vs a real ephemeral store like Upstash Redis), and a half-baked version that lies is worse than no badge. Wave 1 strip ships without it; the badge slots into the existing strip layout when ready.
  - Overflow menu: jump to Command Center, jump to `/pipeline/[id]` if part of a pipeline run, open production doc, open schedule item, open Inbox filtered to this video
- Each tool page, when it loads with `?video_id=`, auto-fetches the video's current state for its own purpose (script, voiceover assignment, etc.).
- When a tool page is loaded WITHOUT `?video_id=`, it shows a "pick a video to work on" empty state listing the user's in-flight videos at this stage, instead of opening blank.
- New endpoint `GET /api/videos/[id]` returns the unified shape: project row, computed stage (see Wave 2), channel, narrator assignment, editor assignment, schedule item, latest scripts, thumbnail URL.
- New endpoint `GET /api/videos/[id]/neighbors` returns the prev/next stage tool URLs.

**Out of scope in Wave 1:**

- Command Center home itself.
- Sidebar restructure (sidebar stays as-is for one week so users keep their muscle memory while the strip lands).
- Any change to the tool pages' bodies.

**Acceptance:**

- Every Create-hub tool page renders the strip when arrived at with `?video_id=`.
- Prev/Next moves between the correct pages.
- "Who has it open" shows correct avatars within 5 seconds of a teammate opening the page.
- Walk-through golden path: from Ideas, "Make video" creates the project + slot, opens Generator with strip + correct video. Click Next, you land on QA with the strip still there. Click Next, Voiceover. Click overflow > Production Doc, you land in the existing production-doc editor with the strip on top and the editor untouched below.

### Wave 2: Command Center home + multi-channel grid (weeks 2 to 3)

**What ships:**

- New page `/command-center` becomes the default route after sign-in.
- Layout:
  - Top bar: Channel multi-select (defaults to all channels owned by the workspace), Week selector (defaults to current ISO week), Stage filter, search.
  - Left rail: per-channel-week summary. One row per channel showing "16 of 20 in flight, 12 done, 3 blocked, 1 stuck." Click a row to filter the main panel.
  - Main panel: a column-per-stage kanban with stages from `idea` to `published`. Cards are videos. Each card shows: thumbnail (or placeholder), title, channel chip, scheduled publish date, current "who is blocking" (AI working, narrator name + due date, editor name, "needs your review"), and a primary next-action button. Drag a card across columns to advance it manually (writes via `advanceVideo()`).
  - Footer panel: **Stuck videos** strip. Lists every video that has not moved stage in 48 hours within the current filter scope. One click per card to open in the appropriate tool.
- The kanban shows up to ~150 cards per filtered view. Above that we automatically collapse to a virtualized list because a kanban with 400 visible cards is unreadable. The view toggle is visible in the top bar.
- "+ New video" button: opens a small dialog to pick a channel + scheduled date + optional starting idea; creates the project + schedule item + initial stage and drops the card on the board.
- "+ New batch" button: routes to the existing `/pipeline/new` page (preserves auto-pipeline batch creation).
- Sidebar restructure (no longer deferred):
  - **Top:** Command Center (new home), Inbox, Messages
  - **Workspace:** Channels, Schedule, Team
  - **Tools** (collapsible): Generator, QA, Voiceover, Production Doc, Thumbnails, SEO, Critics, Video Studio, Shorts, Dub
  - **Growth** (collapsible): Channel hub, Niche Finder, Competitors, Retention, Video Analyzer, A/B Tests, Comments, Fix the Dip, Cannibalization, Spend, Workflows, Ask Studio
  - **Bottom:** Settings
  - Old Dashboard remains reachable for the entire Wave 2 window as a fallback link under Settings, so the user can roll back at any time.

**Out of scope in Wave 2:**

- Merging auto-pipeline into the home.
- Channel Hub redesign (the new sidebar links to the existing Channel page).
- Per-stage WIP limits (deferred to Wave 3 if pain appears).

**Acceptance walk-through (per standing rule 10):**

1. User opens app. Lands on Command Center. Sees a row per channel they own, this week, with fill counts. Sees the kanban below with cards from every channel filtered to this week.
2. User clicks "Channel A" in the left rail. Kanban filters to Channel A's 20 cards for this week.
3. User sees 3 cards in the "Stuck" footer. Clicks the first. Lands on the tool page for the stage that is blocked, with the context strip already loaded.
4. User fixes the issue, clicks Next. Card moves on the kanban behind them.
5. User wants to start a new video for Channel B. Hits "+ New video," picks a date, drops a title. Card appears in the kanban at "Idea" stage. Click it to go to Ideas with the slot context loaded.

### Wave 3: Data unification behind the advanceVideo seam (weeks 4 to 5)

**What ships:**

- New column `projects.current_stage TEXT` cached and kept fresh by `advanceVideo()`.
- New table `video_stage_transitions` (videoId, fromStage, toStage, by, at, source). Populated from day one of Wave 1.
- Migrate every stage-changing code path to call `advanceVideo()`:
  - Pipeline cron stage advances
  - Narrator portal mark-done
  - Editor portal mark-done
  - Schedule status updates
  - Drag-to-advance from the kanban
- One backfill script writes `projects.current_stage` for every existing video using the same join logic the API was using.
- The Command Center kanban switches its data source from "joined-in-API" to `projects.current_stage`. No visible UX change. Latency drops; correctness rises.
- Add `WIP limit` setting per channel per stage (soft warning, not hard block) only if Wave 2 surfaces the pain. Otherwise this is a settings-only no-op until needed.

**Out of scope in Wave 3:**

- Renaming or removing the three existing state-machine columns (`projects.status`, `pipeline_run_videos.stage`, `schedule_items.status`). They stay as projections. The unification is logical, not destructive.
- Real-time presence beyond the 5-minute heartbeat.

## 5. Alternatives considered and rejected

- **Option A only (light touch):** persistent context strip without a new home. Rejected because the user explicitly needs the multi-channel × multi-video parallel view, and the existing Schedule + Projects + Pipeline list trio does not deliver it.
- **Option B (collapse Command Center into auto-pipeline):** every video is a pipeline run. Rejected because it forces every manual user into a state-machine mindset and disrupts the user's current habits more than the win justifies right now. We keep the seam open for this in `advanceVideo()` so we can revisit later.
- **Option C only (kanban without context strip):** rejected because the user's main pain ("features do not talk to each other") is felt on the tool pages, not on a missing home. The strip is the higher-leverage half of the hybrid.
- **Slot-as-unit reframe:** strong insight from earlier discussion, but the user's choice is "stay with video as the unit." The slot reframe is recorded here for future revisitation; it would mean making `schedule_items` the primary entity with videos as fills against slots. We are not doing it now.

## 6. Open questions

1. **Where does "Channel Naming" and "Recover Lost Images" live in the new sidebar?** Currently orphaned. Suggest: under "Growth > Channel" as a submenu.
2. **Does the Command Center default Week selector show "this week" Mon-to-Sun, or a rolling 7 days?** Recommend "this ISO week."
3. **Should the "+ New video" dialog let the user pick a stage to start at (idea / script / etc.) or always start at "idea"?** Recommend always start at "idea" for consistency; advanced users can use `/pipeline/new` for batch-with-presets.
4. **What is the stage chain order?** Propose: idea → script → qa → voiceover → production-doc → thumbnail → edit → seo → scheduled → published. Confirm before Wave 1 ships, because Prev/Next buttons depend on it.

## 7. Security (per standing rule 13)

- **Auth:** the Command Center and all new endpoints respect existing workspace scoping. A user can only see videos in workspaces they have access to. Re-use the existing middleware.
- **Inputs validated at boundaries:** `?video_id=` is UUID-validated server-side before any join, and the user must have access to that workspace. Same for `advanceVideo()`: parameter validation, allowed-transition checks, no client-trusted state.
- **Allowed transitions enforced server-side.** `advanceVideo()` checks that the proposed `toStage` is a legal transition from the current stage. The drag-to-advance UI is a hint, never authoritative.
- **Magic-link tokens unchanged.** Narrator and editor portals continue to use their own tokens with the existing checks.
- **Logging:** never log full script bodies, narrator audio URLs, or any other content. Log video IDs, stage transitions, user IDs only.
- **Rate limiting:** the Command Center's data endpoint and the `/api/videos/[id]` endpoint get the same rate limits as the existing list endpoints.
- **Rollback safety:** during Wave 2 the old Dashboard stays reachable, so a bad deploy can be backed out via routing without data loss.

## 8. Observability (per standing rule 14)

Every new code path logs with a namespaced prefix so the user can grep the console and tell me where things went wrong:

- `[command-center filter]` — filter changes (channel, week, stage)
- `[command-center fetch]` — data loads, with counts and latencies
- `[command-center stuck-detect]` — when the stuck-video query runs, with counts found
- `[video-context-strip load]` — strip loads with video id, stage, has-prev, has-next
- `[video-context-strip presence]` — who-has-it-open badge resolution
- `[advance-video]` — every stage transition with from, to, source (cron | drag | next-button | portal | narrator-done | editor-done), success/fail
- `[video-stage-transitions write]` — telemetry row inserts with success/fail

On the backend (Next.js route handlers): mirror the same prefixes via the project's existing `console.info` / `console.error` pattern, with structured values not strings.

Wave 1 introduces the `video_stage_transitions` table from day one. Even if we never look at it in Wave 1, we have the data when Wave 3 lands.

## 9. Settings audit (per standing rule 15)

New settings to introduce (in `/settings`, under a new "Workspace" or "Production" group):

- **Default landing page:** Command Center (new default) or Dashboard (legacy fallback). Backed by `workspace_settings.default_landing TEXT`.
- **Default week view:** "This ISO week" or "Rolling 7 days." Defaults to "This ISO week."
- **Default stage filter on Command Center:** "All in flight" or "Only my videos" (for multi-user later). Defaults to all.
- **Stuck threshold:** hours before a video shows in the Stuck panel. Defaults to 48.
- **WIP limit per channel per stage:** off by default. Soft warning when exceeded. Hard block off by default.
- **Show "who has it open" badge:** on by default. Privacy-conscious users can disable.
- **Sidebar collapsed groups remembered per user:** automatic, no toggle needed.

What we intentionally do NOT expose (with reason):

- Stage chain order: this is a workflow primitive, not a per-user preference. If a user needs a custom chain it is a different feature.
- Card visual density: deferred until a user asks. Default to compact at >150 cards, comfortable below.

## 10. UI / UX (per standing rules 5, 10, 16)

- **Naming.** "Command Center" is internal jargon and the Outsider called it out. Public label is **"This Week"** with "Command Center" as the route name only. Users see "This Week" in the sidebar; URL is `/command-center` for clarity in the code.
- **Stage labels.** Named stages, never bare numbers. "Voiceover" not "Stage 4." The count hint ("Stage 4 of 10") appears only on hover.
- **Color and typography.** Use the project's existing token system. Channel chips are colored from the channel's existing brand color. No gradients on cards. No glassmorphism. Restrained.
- **States explicit.** Every card shows exactly one of: AI working, waiting on a teammate (with name and due date), waiting on the user (with what action), done, blocked. The state line is plain language not jargon.
- **Empty states.** Tool page with no `?video_id=`: a friendly "pick a video below" with the in-flight list at that stage. Not blank.
- **Drag affordance.** Drag handle on the left edge of every card; hover reveals it. No accidental drags from clicking the card body.
- **Mobile.** The kanban defaults to a single-column list view on mobile, sorted by next-deadline. The context strip is sticky and collapses to channel chip + stage + Prev/Next.
- **Keyboard.** `j`/`k` to move between cards on the kanban, `enter` to open, `n` to go to next stage, `p` to go to previous stage, `/` to focus search. Documented in a `?` overlay.
- **Hebrew.** Out of scope for this plan. RTL handling already exists in the app where it is needed; new components inherit it via the existing logical-properties setup.

## 11. QA pass (per standing rule 6)

Before declaring Wave 1 or Wave 2 done, walk all of these:

**Golden paths:**
- Create a video from Ideas. Land on Generator with strip. Walk Next-Next-Next through QA, Voiceover, Production Doc, Thumbnails, SEO. Every page has the strip. Every page is the correct page.
- Create a video from Schedule (drop on date). Same walk.
- Create a video from Command Center "+ New." Same walk.
- Kick a 20-video batch from `/pipeline/new`. See the 20 cards appear on Command Center, advancing as the cron ticks.

**Edge cases:**
- Tool page arrived at without `?video_id=`. Empty state, not blank.
- `?video_id=` for a video the user does not have access to. 403, not 500.
- `?video_id=` for a video that was just deleted. Friendly "this video was deleted" with a back link.
- A pipeline run still using the old auto-pipeline `/pipeline/[id]` page. Cross-link present, page itself untouched.
- Production-doc page opened from the strip. Editor renders identically to today, strip on top, no changes to the editor body.
- Two browser tabs open on the same video, one in Generator and one in QA. Who-has-it-open badge shows both as the same user (de-duped).
- Two teammates on the same video at the same time. Both see each other in the badge.
- Drag a card to a stage it cannot legally transition to. UI rejects, no DB write.
- Mobile view of Command Center with 100 cards. Renders fast (virtualized).
- Stuck panel when nothing is stuck. Friendly "all moving" state, not empty list.

**Regressions to check:**
- Existing Schedule page still works exactly as it did.
- Existing `/pipeline/[id]` still works exactly as it did.
- Existing narrator and editor portals untouched.
- Production-doc editor and all its features untouched.
- Existing Inbox and Messages untouched.
- All existing query params and localStorage handoff keys still work; we are adding `?video_id=` next to them, not replacing them.

## 12. Rollout

- **Feature flag** `command_center_enabled` per workspace. Default off in production for one week after Wave 1 ships so we can see the strip in the wild without forcing the home change.
- **Wave 1** ships behind the flag for the user's own workspace only on day one. Other workspaces opt in by request until Wave 2 ships.
- **Wave 2** flips Command Center to default landing for the user's own workspace first, with the old Dashboard one click away under Settings > Workspace > Default landing page.
- **Wave 3** ships migration in three steps: backfill `projects.current_stage`, dual-write through `advanceVideo()`, then switch the Command Center query to read from the cached column.
- **Rollback path** at every wave: flip the flag, the old surface returns.

## 13. Effort estimate

- Wave 1: 3 to 5 working days.
- Wave 2: 5 to 8 working days.
- Wave 3: 4 to 6 working days.

Total: roughly 2 to 3 working weeks of focused build, plus QA passes between waves.

## 14. Next plan after this one

After Wave 1 lands, write `_plans/YYYY-MM-DD-qa-hardening.md` covering:

- Critic prompts and rubric tightening (concrete examples of a 100-score script, less ambiguity, stricter evaluation criteria)
- Pre-QA self-check pass by the generator (the generator validates its own output against the rubric before any critic sees it; self-corrects once)
- Stronger initial generator prompt (higher-quality first draft)
- Critic model upgrade and panel diversification (verify pricing per standing rule 8 before recommending changes)

Goal: raise first-pass scores so fewer QA loops are needed to reach 100 in nuclear mode. Do not lower the bar. Make the engine that meets the bar more capable.

## 15. What this plan deliberately does not solve

- Real-time multi-user editing within a single tool. The "who has it open" badge is a soft signal, not a hard lock. If two users edit the same script body at once, last write wins. Real-time merge is a future plan.
- Format-archetype as a first-class axis. Defer until the user says "I make 4 archetypes per channel."
- Public-facing status pages. Defer.
- Renaming or merging the three existing state-machine columns. Wave 3 unifies behind a function; physical merge is later.
- Any change to the production-doc editor or its features. Explicitly preserved.
- Any change to narrator or editor portals. Explicitly preserved.

---

## Approval checklist

- [ ] Scope and waves accepted
- [ ] Hard preservation list accepted (production-doc editor, narrator/editor portals, auto-pipeline page)
- [ ] Stage chain order confirmed
- [ ] Public label "This Week" vs "Command Center" confirmed
- [ ] Feature-flag rollout plan accepted
- [ ] Ready to start Wave 1
