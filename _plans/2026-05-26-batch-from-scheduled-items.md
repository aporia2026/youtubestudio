# Batch from scheduled items

**Date**: 2026-05-26
**Branch**: fix/render-broll-stuck
**Status**: Approved, ready to implement

## Goal

On `/pipeline/new` (Start a batch), let the user pick from items already in the Schedule (not just from saved `video_ideas`). One click queues those items into the auto-pipeline and keeps the schedule in sync.

## Requirements (user-confirmed)

1. **Eligibility**: show *all* scheduled items in the picker — no status filter. The user accepted the risk that this surfaces items already in flight.
2. **Idea linkage**: when a scheduled item has no `idea_id`, auto-create a `video_ideas` row from its `title` (+ `notes` as the hook), then write the new id back to `schedule_items.idea_id`. When it already has one, reuse it.
3. **UX**: a third Mode card on the Start-a-batch page, alongside *Generate fresh ideas* and *Use existing idea(s)*.
4. **Sync**: when the batch starts, advance the schedule item to status `scripting` (only if currently `idea` — never regress a more advanced status) and store the new `pipeline_run_videos.id` on the item so the schedule can show pipeline progress later.

## Approach

### Schema (migration 0092)

`schedule_items` gets one new nullable column:

```sql
ALTER TABLE schedule_items
  ADD COLUMN pipeline_run_video_id UUID
  REFERENCES pipeline_run_videos(id) ON DELETE SET NULL;
CREATE INDEX idx_schedule_items_pipeline_run_video
  ON schedule_items (pipeline_run_video_id)
  WHERE pipeline_run_video_id IS NOT NULL;
```

`schedule_items` is already a ROOT tenant table — no change to `_workspace_scoped_tables.ts`. ON DELETE SET NULL preserves the schedule item if the run is deleted.

### Backend

**`createPipelineRun`** (`src/lib/auto-pipeline/create-run.ts`)

- Add `existingScheduleItemIds?: string[]` to `CreatePipelineRunInput`. Mutually exclusive with `countToGenerate` *and* `existingIdeaIds` (three-way mutex, same validation pattern as today).
- New mode `'scheduled'` inside `validateCreatePipelineRunInput`. Same limits: max 50, no duplicates.
- On execution:
  1. Load all schedule items in one query, workspace-scoped. Missing → `schedule_item_not_found` error (no existence leak across workspaces).
  2. For each item: if `idea_id` is set, reuse it. Otherwise INSERT a `video_ideas` row (workspace-scoped, `is_saved=true`, `title=item.title`, `hook=item.notes ?? ''`, `niche=preset.niche ?? ''`), then UPDATE `schedule_items.idea_id`.
  3. Fall through into the existing `'existing'` mode path so the rest of the pipeline (priority order, transaction, video row inserts) is unchanged.
  4. After video rows are inserted, UPDATE each schedule item: `status='scripting'` (only `WHERE status='idea'`, so we never regress), `stage_entered_at=NOW()`, `pipeline_run_video_id=<new video id>`.
- Logging: `auto-pipeline: run created from schedule { run_id, scheduled_count, auto_created_ideas, advanced_statuses }`.

**API route** (`/api/auto-pipeline/runs/route.ts`)

- Parse `existingScheduleItemIds` from the body, validate as a string array, pass through.
- All workspace checks happen inside `createPipelineRun`.

**Picker endpoint** (`/api/schedule/picker/route.ts`, new)

- The existing `GET /api/schedule` is not workspace-scoped (pre-existing tenancy gap I'm leaving alone). For the batch picker we add a dedicated, `apiRoute.authed`, workspace-scoped endpoint returning only `id, title, status, scheduled_for, idea_id, notes, pillar, position` so the picker has exactly what it needs without exposing every column.

### Frontend

**`src/app/(app)/pipeline/new/page.tsx`**

- Extend `Mode` union to `'fresh' | 'existing' | 'scheduled'`.
- Parallel-fetch the picker endpoint alongside presets + ideas.
- Add `<ModeCard />` titled "Use scheduled items" with subtitle "Pull items straight from your Schedule. We'll create the idea from the title and bump the schedule into scripting."
- When mode is `'scheduled'`, render a new pick list that mirrors the ideas picker but shows a status pill (color from `DEFAULT_SCHEDULE_STATUSES`) and the pillar tag.
- Empty state: "No scheduled items yet. Add some on the Schedule page first."
- Submit branch sends `{ presetId, existingScheduleItemIds }`.
- Logging: `console.info('[pipeline batch] picker_loaded', { ideas, scheduled })`, `[pipeline batch] mode_changed`, `[pipeline batch] submit`.

### Settings audit (Rule 15)

No new settings. The behavior is per-batch and already configurable through the preset (script gate, QA threshold, etc.). The auto-advance-to-scripting rule and auto-idea-creation are intentional defaults the user picked — exposing them as a toggle would be noise.

### Security (Rule 13)

- All schedule items resolved through `workspace_id` filter; foreign-workspace ids return the same not-found error as missing ids (no existence leak).
- Auto-created `video_ideas` rows are workspace-scoped via `session.ws`.
- Duplicate ids rejected (same validation as `existingIdeaIds`).
- Cap of 50 items per batch (same as ideas mode).
- No new external services, no new secrets, no new attack surface beyond reusing the existing pipeline.

### Observability (Rule 14)

Frontend (`[pipeline batch] …`):
- `picker_loaded { ideas, scheduled }`
- `mode_changed { from, to }`
- `submit { mode, count, presetId }`
- `submit_error { mode, message }`

Backend (`logger.info`):
- `auto-pipeline: run created from schedule { run_id, scheduled_count, auto_created_ideas, advanced_statuses }`
- Errors carry `schedule_item_id` when applicable so a failure points at the row.

## Alternatives rejected

- **Merge into the existing "Use existing idea(s)" card with a sub-toggle** — fewer cards but adds a non-obvious second control inside a mode card, which hurts the lazy-user bar (Rule 10).
- **Single combined picker (ideas + scheduled in one list)** — fewer clicks but mixes two data sources with different semantics (one is a library, the other has lifecycle state). Hard to communicate without a badge per row, and even with a badge the user has to mentally filter.
- **Stash `pipeline_run_video_id` in `custom_fields` JSONB instead of a column** — avoids a migration but makes the "which schedule items are in the pipeline" query a JSONB scan, and the link wouldn't survive a casual `custom_fields` overwrite.
- **Only show scheduled items that already have an `idea_id`** — much smaller list, much fewer corner cases, but hides the common case (items typed straight into the schedule).
- **Extend `createPipelineRun` to accept inline `{title, hook}` objects** — keeps `video_ideas` cleaner but creates a parallel data path; the auto-create approach keeps the idea library as the single source of truth.

## Open questions

None — answers locked via the AskUserQuestion round.

## Test plan

- `validateCreatePipelineRunInput` — covers three-way mutex, empty array, duplicates, >50.
- `createPipelineRun` integration — workspace cross-tenancy rejection, auto-create when no `idea_id`, reuse when present, `status='scripting'` applied only when starting from `idea`, `pipeline_run_video_id` set.
- Manual QA on the dev server: pick a scheduled item with no idea_id, confirm a new idea row appears in the Ideas page, confirm the schedule item moved to Scripting and shows a link to the new run, confirm a published item stays Published when accidentally batched.
