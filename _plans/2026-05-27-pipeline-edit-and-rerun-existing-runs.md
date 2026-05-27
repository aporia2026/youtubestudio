# Edit existing pipelines + re-run from any stage

**Date**: 2026-05-27
**Branch**: `claude/video-creation-ui-pqXzS`

## Goals

Make every in-flight, completed, OR failed pipeline run *editable* and
*re-runnable* without starting a new batch. The current model is rigid:
each pipeline_runs row points to one preset_id; the only edit controls
per video are Retry (which auto-picks a target stage from a fixed map)
and Stop. Users want to iterate — change the style, re-run just the
script step, or apply a different preset to the whole batch — without
losing the rest of the work.

Layered overrides (highest priority wins; if a layer is null, fall
through to the next):

1. **Inline regenerate override** — passed to the script-gate's
   Regenerate action as a one-off, not persisted.
2. **Per-video override** — stored on `pipeline_run_videos`.
3. **Run preset's `script_style_preset_id`** — already shipped in
   migration 0093.
4. **Run preset's `production_doc_style_id`** — already shipped.
5. None — prompt byte-identical to the pre-style path.

## Constraints

- No new tables. One new nullable FK column on `pipeline_run_videos`.
- Migrations auto-run on Vercel deploys (per AGENTS.md).
- Workspace-scoped everywhere. All actions accept the workspace from
  the session, never from the client.
- Idempotent where reasonable. Re-runs bump `retry_count` so the spend
  log + UI can show the iteration history.
- No cost rollback. Tokens already spent on stages we're re-running
  are sunk — surfacing the cumulative cost is the right behavior.

## Requirements

Per-video controls (each VideoCard):

- **Style override** — small dropdown labeled "Script style for THIS
  video." Lists the same `/api/production-doc/styles` catalogue. Blank
  = inherit from the run preset's `script_style_preset_id`, then
  `production_doc_style_id`, then no style. Setting it persists to
  `pipeline_run_videos.script_style_preset_override_id`.
- **Re-run from stage** — small "Re-run from…" dropdown listing stages
  already completed for this video (e.g., Script, QA, Production Doc,
  Thumbnail, …). Picking one resets the row to just before that stage
  so the cron picks it up. Clears `claimed_at` if set (so a mid-flight
  video can be redirected). Bumps `retry_count`. Does NOT delete old
  artefacts (`scripts`, `production_doc_entries`, …) — they stay for
  audit but stop being the row's current FK.

Run-level controls (top of `/pipeline/[runId]`):

- **Change preset** — current preset name plus an "Edit" link that
  opens a dropdown of every preset in the workspace. Picking a new one
  PATCHes `pipeline_runs.preset_id`. Future stages on all videos in
  the run use the new preset's settings on their next tick.
  Already-completed stages don't auto-rerun; user explicitly clicks
  Re-run on the videos they want redone.

Inline gate control (ScriptGate component):

- A small dropdown next to **Regenerate script**: "Style: [Use saved
  override] [None] [Story-driven] [Doodle Explainer 2] …". When the
  user picks a different style and clicks Regenerate, the regenerate
  action runs the next script-gen pass with that style instead of the
  resolved-from-preset style — does NOT persist it. Implemented as an
  optional `style_override_id` on the `script_gate` action body.

States covered: mid-flight, completed (done), failed. All three.

## Chosen approach

### Schema (migration 0094)

```sql
ALTER TABLE pipeline_run_videos
  ADD COLUMN IF NOT EXISTS script_style_preset_override_id UUID
    REFERENCES production_doc_styles(id) ON DELETE SET NULL;
```

One column. No index — per-video reads are point lookups by id.

### Server: actions library (`src/lib/auto-pipeline/actions.ts`)

New functions:

- `setVideoStyleOverride({ workspaceId, videoId, styleId | null })`
  — UPDATE pipeline_run_videos … SET script_style_preset_override_id.
  Returns the new value.
- `rerunVideoFromStage({ workspaceId, videoId, targetStage })` —
  Validates the target is a known active stage AND is earlier than (or
  equal to) the current stage. Validates required FKs exist for the
  target (e.g., re-running `running_qa` needs script_id). Resets:
  stage = targetStage, failure_class/message NULL, claimed_at NULL,
  retry_count += 1. Logs `[pipeline rerun-from-stage]` with from/to.
- `swapRunPreset({ workspaceId, runId, newPresetId })` — Validates
  the new preset belongs to the workspace. UPDATE pipeline_runs SET
  preset_id. Logs `[pipeline swap-preset]`.

Extend existing:

- `applyScriptGateDecision({ workspaceId, videoId, decision,
  styleOverrideId })` — when decision='regenerate' AND a
  styleOverrideId is supplied, also SET the per-video override before
  resetting stage. This is the "inline" path; on subsequent regens
  without a styleOverrideId, the override sticks. (Simpler than
  carving out a one-off ephemeral storage; the user can clear it later
  if they want.)

### Server: API routes

`POST /api/auto-pipeline/videos/[id]/actions` — add three actions:

- `set_style_override` — body: `{ action: 'set_style_override',
  style_id: string | null }`.
- `rerun_from_stage` — body: `{ action: 'rerun_from_stage',
  target_stage: PipelineStage }`.
- `script_gate` (existing) — accept optional `style_override_id`.

`PATCH /api/auto-pipeline/runs/[id]` — new route accepting
`{ preset_id?: string }`. Workspace-scoped.

### generate-script.ts

Effective-style resolution chain:

```ts
const effectiveStyleId =
  video.script_style_preset_override_id    // new — per-video
    ?? preset.script_style_preset_id       // already wired
    ?? preset.production_doc_style_id;
```

The "inline regenerate override" path collapses into this via the
per-video column (Layer 3 is implemented as "set + regenerate" in one
action call, not as a separate code path).

### UI: VideoCard

Two new small controls below the title row, both hidden until the
card is expanded so we don't clutter the collapsed list:

- "Style for this video: [select]" — fires set_style_override on
  change, optimistic.
- "Re-run from…: [select stage]" — confirm modal, fires
  rerun_from_stage.

ScriptGate component:

- Add `Style override: [select]` left of the existing Regenerate
  button. Default to "Use the current setting" (sends null).
  On Regenerate, includes the picked value in the action body.

### UI: PipelineDetail header

- Show current preset name. "Change preset" reveals a `<select>` of
  every workspace preset. On change, PATCH pipeline_runs and toast.

## Alternatives rejected

1. **One-off style override stored in a separate ephemeral table**:
   over-engineered. The per-video column doubles as the one-off
   container because the user can unset it after a regen.
2. **Delete old artefacts (scripts/production_doc) when re-running**:
   destructive and loses audit. Old rows become orphaned but
   recoverable; the new run's FKs point at the new artefacts.
3. **Server-side clone-and-rerun the whole batch as a new pipeline_run
   row** (the option you didn't pick): out of scope. Per-video re-run
   covers the same intent with less data duplication.
4. **Allow re-running to a stage you haven't completed yet (skip
   ahead)**: refused. Would let a user jump to `generating_thumbnail`
   without a script — invariant violation, exactly what
   `resolveSafeRetryTarget` is fighting today.

## Security / safety

- Authorization: every action workspace-scoped via `apiRoute.authed`
  + a `workspace_id` filter in the SQL `WHERE`. Cross-workspace ids
  return 404 (not 403 — same pattern as Phase 8).
- Validation: `target_stage` validated via `isPipelineStage` AND a
  "reachable" check (target must be an active stage AND already
  completed by this video). `style_id` validated via UUID shape +
  `resolveStyle` returns null for cross-workspace ids.
- Concurrency: re-run clears `claimed_at` so a stuck mid-flight row
  can be redirected. The cron's `SELECT FOR UPDATE SKIP LOCKED` and
  the per-row claim mean we don't fight an in-progress handler — but
  if the handler is mid-tick and we clear the claim under it, on its
  next tick it'll see a stage change and bail. Acceptable.
- No new logging surface for PII. Stage transitions log the from/to
  pair without script content.

## Open questions

None — design fully specified after the 2026-05-27 round.

## Verification plan

1. Migration 0094 applies cleanly; `pipeline_run_videos` has the new
   column.
2. **Per-video style override**:
   - On a script-gated video, pick a different style from the dropdown,
     click Regenerate. Wait for the next cron tick. New script reflects
     the override.
3. **Re-run from a stage**:
   - On a `done` video, "Re-run from Script." Stage flips to
     `generating_script`. retry_count bumps. Cron picks it up; the
     gate fires again.
   - On a `qa_failed_after_max_retries` video, "Re-run from Script"
     also works (same path).
4. **Run-level preset swap**:
   - Pick a different preset on a mid-flight run. The next stage that
     fires on any video uses the new preset's settings.
5. **Inline gate override**:
   - At the script gate, pick a style next to Regenerate, click. The
     regen uses that style. The per-video override is now set.
6. **Edge cases**:
   - Re-run from a stage the video never reached — UI hides the option,
     server rejects with 400.
   - Preset swap to a foreign-workspace id — server returns 400 (UUID
     check) or 404 (workspace filter).
