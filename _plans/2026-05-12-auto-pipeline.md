# 2026-05-12 — One-click auto-pipeline (idea → script → QA → narration → production doc)

## Goal

A single batch surface that takes a creator from "I want N new videos" to
"production-ready shot-by-shot breakdowns" with one click and one ranking
pass, with AI model fallback chains configurable in advance and a hard
human gate at the script stage so dud ideas don't burn token spend on the
expensive critic loop.

End-to-end flow:

1. **Configure preset** — ideas count, idea-gen context, script rules,
   target spoken-word count, critic min-score, max QA iterations,
   production-doc model, image-gen model chain, fallback chains per
   stage. Save as named template per workspace.
2. **Run batch of N** — generate N ideas, user drag-ranks them once.
3. **For each video, in priority order:**
   a. Generate idea (already saved).
   b. Generate script.
   c. **Script gate** — present script + spoken-word count; user keeps,
      kills, or regenerates. Default on, can be disabled per preset
      ("fully unattended" mode).
   d. Run critic panel ("AI script review" in user-facing copy).
   e. If score < threshold, apply suggested fixes, re-run script + panel.
      Max 3 iterations (configurable per preset).
   f. Mark `waiting_narration`. Stop.
4. **On narrator approval** (existing /narrator portal flow) — auto-sum
   approved take durations into `final_video_length_seconds`. User can
   override.
5. **Generate production doc** with the chosen image-gen chain per row.

## Out of scope (v2+)

- **Fine-tuning dataset / "rejected → accepted" pair corpus.** Council
  flagged this as a v3+ idea; deferred. The critic-loop pairs are biased
  by the same model family scoring itself, so the corpus is noisy gold
  at best.
- **Parallel script variants from different model families.** First
  Principles' suggestion to beat the bias problem. Real idea, but v2 —
  doubles per-video LLM cost and changes the data model.
- **Public preset marketplace, multi-channel agency tier, narrator
  marketplace.** Expansionist's "factory OS" framing. Defer until v1
  proves out.
- **i2i image variants in production doc.** The thumbnails page has 4
  i2i variants we could lift; production-doc rows generate from text
  prompts only today. Adding i2i requires per-row reference-image
  plumbing — v2.
- **Auto-applied fallback for content refusals.** Refusals are a content
  signal, not a transient error. Surface them; don't auto-retry into a
  different model that ships content the primary declined.
- **Image-gen cost tracking** in `ai-spend_log`. Kie.ai per-image pricing
  isn't in [src/lib/ai-pricing.ts](../src/lib/ai-pricing.ts) today.
  Adding it is its own ticket (look up Kie's current rate card, per
  CLAUDE.md rule 8). For v1, show LLM-cost estimate only; flag image
  cost as "not tracked in estimate" so the user isn't surprised.
- **Inngest / Temporal / Vercel Workflow.** Cron + Postgres advisory
  lock ships in 5 days and handles the user's volume. Revisit at 100+
  runs/day.

## Constraints

- **300s Vercel function timeout.** Architecture-defining. The
  orchestrator advances **exactly one stage per cron tick**. Never chain
  stages in a single invocation. (Council peer review caught this — no
  individual advisor named it; multiple reviewers did.)
- **Postgres only.** No Redis, no queue. Cron-driven state machine with
  `SELECT FOR UPDATE SKIP LOCKED` for per-row claiming and
  `pg_try_advisory_lock` as a cron-entry guard against overlapping ticks.
- **Reuse Phase 6.2 model resolver** — adds a "fallback chain" layer on
  top, doesn't replace `getEffectiveModelId`.
- **Reuse Phase 5.2 workflow events** — orchestrator emits existing
  events (`script_complete`, `critic_panel_completed`, etc.) so user's
  existing Slack/webhook rules keep firing.
- **Reuse [src/lib/utils.ts:26-98](../src/lib/utils.ts#L26-L98)**
  `stripCues` + `countWords` for the script gate's spoken-word count.
  Single source of truth across generator, narrator, teleprompter — the
  gate must match.
- **Reuse [src/lib/ai-pricing.ts](../src/lib/ai-pricing.ts)** registry
  for pre-run dollar estimate. Sonnet at $3/$0.30/$15 per MTok already
  encoded.
- **Workspace tenancy**: every new table has `workspace_id` NOT NULL +
  WHERE clauses everywhere. Match the pattern from Phase 8.1's audit
  fixes — cross-workspace IDs return 404, not 403 (no existence leak).

## Approach

### Council-mandated hardening (locked, non-negotiable)

These came out of the LLM Council pass and are baked in below:

1. `pg_try_advisory_lock(42)` at cron entry; exit silently if another
   tick is in flight.
2. `SELECT ... FOR UPDATE SKIP LOCKED` on the per-video row claim.
3. **Idempotency key per stage write**: composite
   `(video_id, stage, attempt_number)` enforces UNIQUE on stage
   artefacts so cron retries don't double-charge.
4. **Refusal classification**: upstream failures classified into
   `transient_5xx | rate_limit | timeout | empty_or_malformed |
   content_refusal | unknown`. Only the first four trigger fallback;
   `content_refusal` surfaces as a per-video failure with the model's
   refusal text preserved.
5. **Explicit terminal states**: `qa_failed_after_max_retries`,
   `narration_abandoned`, `production_doc_failed`,
   `cancelled_by_user`. With per-state UX (notify + actions on
   `/pipeline`).
6. **One stage per cron tick.** Non-negotiable. Documented in the
   orchestrator contract.

### Spend cap — user-overridden

The council was unanimous that "estimate-only" is the highest risk in
the plan. The user knowingly accepted the risk after pushback. Plan
respects that decision but adds two soft mitigations that don't
contradict it:

- **Pre-run dollar estimate** computed from `ai-pricing.ts` × expected
  token counts per stage × max-iterations, shown before "Start batch."
- **Real-time running cost** displayed on `/pipeline` per video and per
  batch (refreshes every tick).
- **Image-gen cost not in estimate** (Kie.ai pricing not tracked).
  Estimate is labeled "LLM cost only; image-gen billed separately on
  Kie.ai dashboard."
- No hard kill-switch. If the user changes their mind, they can add a
  `MAX_PIPELINE_SPEND_USD_PER_BATCH` env var later — `generateText` will
  already record cost via the existing spend log (Phase 5.4/6.1), so the
  data is there to enforce against. v1 ships without it.

### Data model (migration 0051)

Three new tables, all workspace-scoped.

```
pipeline_presets
  id                          uuid PK
  workspace_id                uuid NOT NULL REFERENCES workspaces(id)
  name                        text NOT NULL
  niche                       text
  ideas_count_default         int NOT NULL DEFAULT 5
  idea_context_jsonb          jsonb   -- audience, focus, video type, ref ctx
  script_rules_jsonb          jsonb   -- tone, style, audience, custom rules
  target_spoken_words         int     -- nullable; gate displays count anyway
  qa_min_score                numeric NOT NULL DEFAULT 75
  qa_max_iterations           int     NOT NULL DEFAULT 3
  script_gate_enabled         bool    NOT NULL DEFAULT true
  production_doc_style_id     uuid    REFERENCES production_doc_styles(id)
  narration_deadline_days     int     NOT NULL DEFAULT 7
  fallback_chains_jsonb       jsonb   -- per-feature ordered model lists
  created_by                  uuid REFERENCES users(id)
  created_at                  timestamptz NOT NULL DEFAULT now()
  updated_at                  timestamptz NOT NULL DEFAULT now()
  UNIQUE (workspace_id, name)

pipeline_runs
  id                          uuid PK
  workspace_id                uuid NOT NULL REFERENCES workspaces(id)
  preset_id                   uuid NOT NULL REFERENCES pipeline_presets(id)
  channel_id                  uuid REFERENCES channels(id)
  ideas_count                 int NOT NULL
  status                      text NOT NULL  -- 'idea_ranking' | 'running' | 'paused' | 'done' | 'cancelled'
  estimated_cost_usd          numeric
  actual_cost_usd             numeric NOT NULL DEFAULT 0
  created_by                  uuid REFERENCES users(id)
  created_at                  timestamptz NOT NULL DEFAULT now()
  completed_at                timestamptz

pipeline_run_videos
  id                          uuid PK
  workspace_id                uuid NOT NULL  -- denormalised for direct WHERE filter
  pipeline_run_id             uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE
  priority                    int NOT NULL  -- 1-indexed; lowest runs first
  stage                       text NOT NULL  -- see state machine below
  retry_count                 int NOT NULL DEFAULT 0
  failure_class               text  -- content_refusal | transient_5xx | rate_limit | timeout | empty_or_malformed | unknown | null
  failure_message             text  -- short, user-facing
  cost_usd                    numeric NOT NULL DEFAULT 0
  idea_id                     uuid REFERENCES video_ideas(id)
  project_id                  uuid REFERENCES projects(id)
  script_id                   uuid REFERENCES scripts(id)
  critic_panel_id             uuid REFERENCES critic_panels(id)
  narrator_assignment_id      uuid REFERENCES narrator_assignments(id)
  production_doc_entry_id     uuid  -- nullable; current prod-doc lives in history
  narration_deadline_at       timestamptz  -- set when stage=waiting_narration
  claimed_at                  timestamptz
  claimed_by_tick             text  -- cron tick UUID; for debug
  created_at                  timestamptz NOT NULL DEFAULT now()
  updated_at                  timestamptz NOT NULL DEFAULT now()
  UNIQUE (pipeline_run_id, priority)
  INDEX (workspace_id, stage)  -- cron picks next pending row

pipeline_stage_artefacts
  -- idempotency table; prevents double-charge on cron retry
  pipeline_run_video_id       uuid NOT NULL REFERENCES pipeline_run_videos(id) ON DELETE CASCADE
  stage                       text NOT NULL
  attempt_number              int NOT NULL
  artefact_kind               text NOT NULL  -- 'script' | 'panel' | 'production_doc_row' | etc.
  artefact_id                 uuid           -- FK to scripts / critic_panels / etc.
  cost_usd                    numeric NOT NULL DEFAULT 0
  created_at                  timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (pipeline_run_video_id, stage, attempt_number, artefact_kind)
```

### State machine

```
queued
  → generating_idea          (cron picks up; calls /api/generate/ideas internals)
  → generating_script        (calls script gen lib)
  → awaiting_script_gate     (if preset.script_gate_enabled — pauses)
       ↳ user clicks "keep" → running_qa
       ↳ user clicks "regenerate" → generating_script (retry_count++)
       ↳ user clicks "kill" → cancelled_by_user (terminal)
  → running_qa               (calls critic panel runner)
  → qa_retry                 (score < min, retry_count < max; apply fixes, regenerate)
  → waiting_narration        (sets narration_deadline_at = now + preset.narration_deadline_days)
       ↳ narrator approves → narration_complete (callback flips it)
       ↳ deadline passes → narration_overdue (still recoverable; user can extend)
       ↳ user marks abandoned → narration_abandoned (terminal)
  → narration_complete
  → generating_production_doc
  → done                     (terminal)

failure terminals:
  qa_failed_after_max_retries
  narration_abandoned
  production_doc_failed
  cancelled_by_user
  cost_cap_exceeded          (reserved — wires up only when env var is set)
```

The cron advances exactly one of the live-transition edges per tick.
Terminal states are not re-claimed.

### Orchestrator

`src/lib/auto-pipeline.ts` exports `processNextVideo(): Promise<void>`.
Single function. Reads one row (`FOR UPDATE SKIP LOCKED`, ordered by
`pipeline_runs.created_at`, then `priority`), advances one stage in a
switch statement, writes back, returns. No state-machine library.

Per-stage handlers live in `src/lib/auto-pipeline/stages/`:

- `generateIdea.ts` — internally calls the same code path as
  `/api/generate/ideas` but with the preset's idea-gen context.
  Idempotent via `pipeline_stage_artefacts` lookup.
- `generateScript.ts` — calls existing script-gen pipeline. After write,
  computes spoken-word count via [src/lib/utils.ts](../src/lib/utils.ts)
  `stripCues` + `countWords`. Stores on `pipeline_stage_artefacts`.
- `runCriticPanel.ts` — wraps existing critic panel runner. Returns
  overall_score; orchestrator decides next state (`qa_retry` if score
  < min and retry_count < max, else `waiting_narration`).
- `markWaitingNarration.ts` — pure DB write; sets deadline.
- `generateProductionDoc.ts` — calls existing prod-doc route internals
  per row, with the preset's image chain.

### Cron

`/api/cron/run-pipeline` — every minute. Existing CRON_SECRET pattern
(see [src/app/api/cron/run-workflows](../src/app/api/cron/run-workflows/route.ts)).

```ts
// 1. Try advisory lock; bail if another tick is running.
const [{ locked }] = await sql`SELECT pg_try_advisory_lock(42) AS locked`;
if (!locked) return new Response('busy', { status: 200 });
try {
  // 2. Drain up to N rows per tick (N=5 default; tunable).
  for (let i = 0; i < 5; i++) {
    const advanced = await processNextVideo();
    if (!advanced) break;
  }
} finally {
  await sql`SELECT pg_advisory_unlock(42)`;
}
```

`processNextVideo` returns `true` if a row was claimed + advanced;
`false` if no eligible rows. The 5-per-tick drain handles the case
where stages finish faster than the 60-second cron cadence; the
advisory lock prevents two crons stepping on each other's drain.

### Fallback chain mechanic

Net-new helper `generateTextWithFallback(featureId, params)` in
[src/lib/ai.ts](../src/lib/ai.ts):

1. Resolve the chain for `featureId` from
   `pipeline_presets.fallback_chains_jsonb` (or
   `feature_default_fallback_chains` for non-pipeline callers).
2. Try primary. On result, return.
3. On failure, classify into the enum above.
4. If class ∈ {`transient_5xx`, `rate_limit`, `timeout`,
   `empty_or_malformed`} and chain has next member → retry with next.
5. If class ∈ {`content_refusal`, `unknown`} → throw classified error
   up; orchestrator surfaces it as `failure_class` + `failure_message`.

`generateText` keeps working as-is; the fallback wrapper is opt-in per
call. v1 wires it into the pipeline stages only. Per-feature rollout
across the other 30 AI features is a follow-up (Expansionist's idea
deferred — real value, but not v1).

### QA fix-list (visible in UI, not just sent to model)

User requirement (2026-05-12): when QA score is below threshold and the
loop is about to retry, the **fix list from the previous critic panel
verdict must be visible in the UI**, not silently passed into the next
script-gen call.

Implementation outline (Tuesday work):

- The critic-panel verdict already lives in
  `critic_panels.verdict` (JSONB) from migration 0025. It contains
  the chair's consensus + each critic's report. We parse out a
  flat `fixes: { critic: string; severity: 'high'|'med'|'low'; text:
  string; script_line_ref?: string }[]` list — single canonical shape
  the orchestrator + UI both consume.
- On `qa_retry` transition, the orchestrator:
  1. Reads the previous attempt's `critic_panel_id` from
     `pipeline_stage_artefacts`.
  2. Pulls the verdict; flattens to the fix list shape.
  3. Persists the flattened list onto the next attempt's artefact row
     (`metadata_jsonb.applied_fixes`) so the UI can render it without
     re-parsing JSON.
  4. Builds the script-gen prompt augment from the same flat list.
- UI on `/pipeline/[id]` per-video row in `qa_retry` or `running_qa`
  state shows the fix list under a collapsible "Fixes being applied"
  section. Same list at `qa_failed_after_max_retries` so the user
  reviewing a stalled video sees exactly what the critics asked for.
- Single source of truth: the flattened list. Orchestrator and UI both
  read from `pipeline_stage_artefacts.metadata_jsonb.applied_fixes`.
  No risk of UI showing one list and the model receiving another.

### Script gate (the highest-leverage addition)

After `generating_script`, the orchestrator transitions to
`awaiting_script_gate` if the preset has it enabled (default on).

The gate UI on `/pipeline/[run-id]` shows, for the current video:

- Idea title + niche.
- Full script body.
- **Spoken-word count** computed via `stripCues` + `countWords`. This
  is the count the narrator will actually say — bracketed cues, section
  headers, parameter notes are excluded. (Per user's explicit
  requirement.)
- Estimated narration duration at 140 wpm (existing `estimateDuration`).
- Three buttons: **Keep & continue** | **Regenerate** | **Kill video**.
- Decision recorded in `pipeline_stage_artefacts` so a user closing the
  browser and re-opening sees the same gate.

Preset toggle: `script_gate_enabled: false` → orchestrator transitions
straight to `running_qa`. The preset UI labels this as "Fully
unattended (skip script review)".

### Narrator SLA

`pipeline_run_videos.narration_deadline_at` set to `now() +
preset.narration_deadline_days` (default 7) on transition into
`waiting_narration`. A `/api/cron/run-pipeline` sub-pass scans for
overdue rows and flips them to `narration_overdue` (non-terminal —
the row is still recoverable; the user can extend the deadline,
reassign, or mark abandoned from `/pipeline`).

`narration_overdue` videos surface in `/pipeline` with a red badge.
Existing webhooks/Slack fire on the `narration_overdue` event (new
event registered in `WORKFLOW_TRIGGER_EVENTS` + `WEBHOOK_EVENT_TYPES`
per the Phase 5.2 / 7.3 producer pattern).

### Pipeline UI (`/pipeline`)

New top-level nav entry per the user's "lazy user" rule — they
shouldn't hunt for it.

Three sub-views:

- `/pipeline` — list of all batches, status, cost, who created.
- `/pipeline/new` — preset picker + ideas count + "Start batch."
- `/pipeline/[id]` — batch detail. Drag-rank queue at the top
  (only enabled while `status='idea_ranking'`). Per-video status
  table below: priority, idea title, current stage, retry count,
  cost, action buttons (View script, View panel verdict, Kill,
  Extend narration deadline, Mark abandoned).

The script gate renders inline in the per-video row when stage =
`awaiting_script_gate`.

User-facing copy reframes the jargon per Outsider's review:

- "Critic panel" → **"AI script review"**.
- "Production doc" → **"Shot-by-shot breakdown"**.
- "Fallback chain" → shown visually as **`Primary → Backup 1 → Backup 2`**.
- Cost shown in **dollars**, not tokens.
- Score shown with the threshold inline: **"82 / 100 (passes your 75 minimum)"**.

### Image-gen catalog expansion (side task)

[src/lib/image-models.ts](../src/lib/image-models.ts) today: 5 text-to-image
models hardcoded. The thumbnails page has 4 i2i variants in its own
registry. For v1:

- Move all 9 (5 t2i + 4 i2i) into the single
  [src/lib/image-models.ts](../src/lib/image-models.ts) registry with a
  `kind: 't2i' | 'i2i'` discriminator.
- Production-doc page filters to `t2i` only (no behavioural change for
  end users — i2i needs per-row reference image plumbing that's v2).
- Add **per-stage image fallback chain** to the preset: list of
  text-to-image model values. Production-doc image route consumes the
  chain via `generateImageWithFallback` (new helper analogous to the
  text version).

### Workflow event integration

Orchestrator fires existing events at the boundaries the user already
cares about, so Phase 5.2 rules keep working:

- `critic_panel_completed` (already exists) — fired by the critic
  runner; no new wiring needed.
- New events: `pipeline_video_script_ready`, `pipeline_video_done`,
  `pipeline_batch_done`, `narration_overdue`. Registered in
  `WORKFLOW_TRIGGER_EVENTS` + `WEBHOOK_EVENT_TYPES`.

Dispatch is fire-and-forget (lazy import) so workflow latency doesn't
block the cron tick.

## Security & safety (rule 13)

- **Tenancy.** Every new route is `apiRoute.authed`; every DB query
  filters by `workspace_id`. Cross-workspace IDs return 404 (no
  existence leak — match Phase 8.1's pattern).
- **Cron auth.** Existing `CRON_SECRET` Bearer check, same as
  `run-workflows`. The cron endpoint is the only caller that can
  drain rows.
- **AI input sanitization.** User-supplied preset fields
  (`niche`, `script_rules_jsonb`, etc.) flow into LLM prompts. Apply
  the existing `sanitizeForPrompt` helper (used by Phase 9.8 digest
  builder) before concatenation. No raw user text into system prompts.
- **Refusal handling.** A model refusing the prompt is a content
  decision, not a transient failure. Surface the refusal text to the
  user; never auto-retry into a different model that might ship the
  declined content.
- **Idempotency.** Cron retries are guaranteed by Vercel's at-least-once
  delivery. `pipeline_stage_artefacts` PK
  `(video_id, stage, attempt_number, artefact_kind)` blocks duplicate
  artefact writes; cost charges are conditional on the insert
  succeeding.
- **Locking.** `pg_try_advisory_lock(42)` at cron entry +
  `SELECT FOR UPDATE SKIP LOCKED` on the per-row claim. Both, not
  either-or.
- **Cost transparency.** Per-video and per-batch running cost shown in
  real time on `/pipeline`. No hard cap in v1 (user-accepted risk),
  but the spend log (Phase 5.4) records every call so the user can
  audit after the fact and add a cap later without a schema change.
- **No PII in logs.** Existing `logger.*` calls already mask PII;
  new orchestrator log lines include `pipeline_run_id` + `video_id`
  but no script bodies / idea titles.

## Alternatives rejected

- **Option B (workflow trigger system, no dedicated orchestrator).**
  Phase 5.2's workflow system is stateless event-action pairs. Modeling
  retry-until-threshold + per-pipeline preset state inside workflow
  rules would require counters smuggled in event payloads and ugly
  multi-rule chains. Rejected — wrong tool, picked Option C (hybrid).
- **Option A (dedicated orchestrator, no workflow event emission).**
  Cleanest, but loses the user's existing Slack/webhook rules at stage
  boundaries. Rejected — Option C costs ~4 lines of `dispatchWorkflowEvent`
  per stage and keeps existing rules firing.
- **Inngest / Temporal / Vercel Workflow.** Executor was unambiguous:
  cron + advisory lock + SKIP LOCKED ships in a week; durable workflow
  framework is over-investment for one-person volume. Revisit at 100+
  runs/day.
- **Spend hard cap, fail closed.** Council unanimous; user overrode
  knowingly. Spend log is captured anyway — the cap can be added later
  without a schema change.
- **Parallel script variants from different model families.** First
  Principles' suggestion. Real value vs. critic-loop bias, but doubles
  per-video LLM cost and changes the data model. v2.
- **Auto-fallback on content refusal.** Council unanimous: refusals
  are a content signal, not a transient error. Rejected.
- **i2i variants in production doc.** Real i2i requires reference-image
  plumbing per row. v2.

## Open questions

(None currently blocking — both flagged for confirmation during
implementation, not before.)

1. **Image-gen pricing.** Kie.ai per-image rates aren't in
   `ai-pricing.ts`. Pre-run estimate is LLM-only in v1. When wiring v2
   image cost tracking, look up Kie's current rate card live (CLAUDE.md
   rule 8) — don't trust memory.
2. **Critic-panel "apply fixes" loop.** The existing critic runner
   doesn't have a documented "apply fixes from previous verdict to next
   script gen" mode. Need to verify the runner's input shape supports
   this; if not, a thin adapter in `qa_retry` stage handler builds the
   fix-bundle prompt augment. Verify during the Tue handler implementation.

## Build order (Executor's 5-day plan, hardened)

Each day ships something verifiable; no day creates code that the next
day rewrites.

- **Mon AM** — Migration 0051 (the three tables above + indexes).
  `pg_try_advisory_lock` wrapper helper. Hardcoded fallback chain
  constants for the four pipeline features (refine in week 2).
- **Mon PM** — `generateTextWithFallback` in `src/lib/ai.ts`. Failure
  classifier with the six-enum split. 8-10 tests covering each branch.
- **Tue** — Orchestrator skeleton (`processNextVideo`) + the five stage
  handlers. Switch on stage. Idempotency lookup. No critic-loop
  retry-with-fixes yet — straight pass-through, score recorded.
- **Wed** — Cron route (`/api/cron/run-pipeline`) with advisory lock +
  N=5 drain. `narration_overdue` sub-pass. Smoke test against a
  hand-seeded `pipeline_run` in dev.
- **Thu** — Pipeline UI: `/pipeline` list, `/pipeline/new` preset
  picker, `/pipeline/[id]` detail with drag-rank + script gate inline.
  Ugly-but-functional first; polish in v1.1.
- **Fri** — qa_retry loop with "apply fixes" prompt-augment. Real batch
  of 3 videos through the full flow on a dev workspace. QA the golden
  path + the five terminal states. Fix what breaks.

**v1 ship gate:** a single batch of 3 ideas runs end-to-end on the dev
workspace, hits the script gate, passes QA (or fails cleanly into a
terminal state), pauses at `waiting_narration`, resumes on narrator
approval, generates the production doc. All five terminal states
reachable from the UI.

**v1.1 (next 5 days):** image-gen catalog expansion + per-row image
fallback chain (the side task in the user's original request). Polished
UI. Cost-estimate refinements. Webhook event wiring across all four
new events.

## Why this plan (council-mandated)

- **Spend cap risk noted, user-overridden.** Council was unanimous;
  user knowingly accepted. Spend log captures everything so a cap can
  be retrofitted without schema change.
- **Script gate (default on)** is the highest-leverage architectural
  change from the council. Catches dud ideas after they're written out,
  before the expensive 3× critic loop runs.
- **300s timeout is load-bearing.** One stage per cron tick. Documented.
- **Race conditions handled** by advisory lock + SKIP LOCKED. Both.
- **Refusals classified separately** from transient errors. No
  auto-retry across model families on content refusal.
- **Five explicit terminal states** with per-state UX — no stuck rows.
- **Scope cut hard for v1**: idea → script → gate → QA → narration
  wait → production doc. Image catalog expansion + per-row fallback +
  webhook wiring shipped in v1.1.
