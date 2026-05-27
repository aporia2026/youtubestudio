# Pipeline "Continue an existing video" mode

**Date**: 2026-05-27
**Branch**: `claude/video-creation-ui-pqXzS`

## Goals

Let a user start a pipeline run for a project that **already has a script
saved AND a narration recorded**, with the auto-pipeline picking up at
`narration_complete` and running production-doc → thumbnail → editor → SEO.

Today the four "start a batch" modes all force the run through script
generation, QA, and the narration wait — even when the user has done
those steps manually. This new mode skips them entirely.

## Constraints

- No new tables. Reuse `pipeline_run_videos` with a chosen start
  stage instead of the default `queued`.
- Workspace-scoped at every read.
- Migrations auto-run on Vercel deploys.
- No new paid-API calls in the create-run path — production-doc /
  thumbnail / SEO already cost what they cost, no change there.

## Requirements

- New tab on `/pipeline/new`: **Continue an existing video**.
- Project picker that lists projects in the workspace which have a
  saved script (`scripts.is_active = true` row joined). Search + select
  N projects, same as the existing idea / schedule pickers.
- Server creates a `pipeline_runs` row + one `pipeline_run_videos` row
  per picked project, with:
  - `stage = 'narration_complete'`
  - `project_id` = chosen project
  - `script_id` = chosen project's active script row
  - `idea_id` = the project's linked idea if any, otherwise a stub
    `video_ideas` row created from `projects.title` (mirrors the
    pattern used for scheduled items without an existing idea).
- Picker excludes projects without a saved script (would immediately
  fail the production-doc handler's invariant guard).
- `pipeline_runs.status = 'running'` (skip the idea_ranking phase —
  these rows are ready to drain).

## Chosen approach

### API

- **POST `/api/auto-pipeline/runs`** gains a fourth body shape:
  `{ presetId, existingProjectIds: string[] }`. Mutually exclusive with
  the existing fields (`countToGenerate`, `existingIdeaIds`,
  `existingScheduleItemIds`).
- **GET `/api/auto-pipeline/projects-picker`** (new) — minimal
  workspace-scoped list of projects with a saved script:
  `{ id, title, niche, idea_title, script_word_count,
    script_updated_at }`.

### `src/lib/auto-pipeline/create-run.ts`

Add a `continue` branch that:
1. For each `projectId`:
   - Load + workspace-scope project + active script.
   - 404 if missing or no active script.
2. Resolve or create the idea (stub from `projects.title` if absent).
3. Insert one `pipeline_run_videos` row per project with
   `stage='narration_complete'`, FKs pre-populated, priority = index+1.
4. Set `pipeline_runs.status='running'` immediately.

### `/pipeline/new` UI

Add a fourth `ModeCard` ("Continue an existing video") and a
`ContinuePicker` panel that loads from the new picker endpoint and
renders the same selection-list pattern as the idea / schedule pickers.

### `generate-production-doc.ts` invariant

Already guards on `script_id` and `project_id` — both populated by the
new create path. No change needed there.

## Alternatives rejected

- **Power-user "pick any start stage" mode**: future-shapeable but more
  UX surface than the 80%-case needs. The user picked the
  `narration_complete` default.
- **Auto-continue button per project on the Command Center**: also
  valid but the user picked the `/pipeline/new` location.
- **Bypass `pipeline_run_videos` entirely and run the post-production
  stages as one-off API calls**: would fragment the audit trail and
  duplicate logic that the orchestrator already owns. Rejected.

## Security / safety

- Workspace-scoping on every read: project + idea + script joins all
  filter on `workspace_id`.
- Reject cross-workspace project ids in the picker AND in
  `createPipelineRun`.
- Reject project ids with no `scripts.is_active = true` row at the
  API layer — the handler's invariant guard would catch it later but
  the user deserves an immediate 400 with a clear message.

## Verification plan

1. Pick a project with a saved script + narration (manually marked
   done elsewhere). Start a "Continue an existing video" run.
2. Inspect the `pipeline_run_videos` row — `stage = 'narration_complete'`,
   `script_id` and `project_id` set, `idea_id` set (real or stub).
3. Wait for the cron tick. Row advances to
   `generating_production_doc`, then on success to subsequent stages.
4. Re-run from stage works as before on these rows; per-video style +
   custom-instructions overrides work as before too.
