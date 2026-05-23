# Editor Generation History Log

**Date:** 2026-05-23
**Status:** Approved, in progress

## Goal

A per-project log of every animation (b-roll) generation event, viewable as a new "History" tab in the right Inspector. Each entry shows scene number, timestamp, model, status, and error (if any). Clicking an entry jumps to that scene.

## Requirements (confirmed)

- **Persistence:** per-project, persisted in DB (survives reloads/sessions).
- **Events tracked:** successful generations, re-generations, failures/errors, in-flight.
- **UI placement:** new tab in the right Inspector (next to Shot / Audio / Captions).
- **Entry fields:** scene number + title, relative timestamp (hover for absolute), model used, status + error message.
- **Retention:** forever (no pruning).
- **Auto-switch to History tab on first generate of session:** yes.
- **"Animate all" batch logs one entry per row:** yes, by design.

## Approach (chosen)

### 1. New table `generation_events` (append-only audit log)

Migration `0083_create_generation_events.ts`:

```sql
CREATE TABLE generation_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  row_index       INTEGER NOT NULL,
  broll_clip_id   UUID NOT NULL REFERENCES broll_clips(id) ON DELETE CASCADE,
  model_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN ('generate','regenerate')),
  status          TEXT NOT NULL CHECK (status IN ('generating','ready','failed')),
  error_message   TEXT,
  prompt_excerpt  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX idx_gen_events_project_created ON generation_events (project_id, created_at DESC);
CREATE INDEX idx_gen_events_clip ON generation_events (broll_clip_id);
```

### 2. Two write points (matches existing kickoff/polling split)

- **On kickoff** (`EditorClient.tsx` `handleGenerateClip`): after `POST /api/broll` succeeds, POST to `/api/edit/[projectId]/generation-events`. `event_type = 'regenerate'` if `rowVideoClips[i].brollClipId` was already set, else `'generate'`. Insert `status='generating'`.
- **On poll completion** (`EditorClient.tsx` polling block): PATCH the event by id with final `status`, `error_message`, `completed_at`.

### 3. New API routes (`src/app/api/edit/[projectId]/generation-events/`)

- `POST /` — insert kickoff event. Returns the new event id.
- `PATCH /[eventId]` — update on completion (status, error_message, completed_at).
- `GET /?limit=50` — list events for the project. Joins `broll_clips` for the canonical clip state, reconciles stuck `generating` events on read.

All routes scope by `project_id` and verify caller owns the project using the same auth helper used by other `/api/edit/[projectId]/*` routes.

### 4. New Inspector tab "History"

- Extend `InspectorTabId` in `EditorInspector.tsx` to include `'history'`.
- Add `{ id: 'history', label: 'History' }` to the `TABS` array.
- Pass `history: <GenerationHistoryPanel/>` slot from `EditorClient.tsx`.
- Panel: chronological list (newest first), grouped by scene optional. Click row → existing `selectShotFromUser(rowIndex, 'history-panel')`.
- Auto-switch to History tab on first generate of session (extend the existing auto-switch effect tied to `selectionKind`).

### 5. Stuck-generation reaper

If an event sits in `status='generating'` and its `broll_clips.status` is `ready`/`failed`, the GET endpoint reconciles on read. Cheap, no cron needed.

## Alternatives rejected

- **(B) Add columns to `broll_clips`** — conflates clip entity with attempt log; makes re-generate semantics ambiguous. Rejected.
- **(C) Derive log from project JSONB only** — loses durability on kickoff crashes; bloats project payload. Wrong tool for an audit log. Rejected.

## UX walkthrough (lazy user, rule 10)

1. Click Generate on scene 5 → first time this session, History tab auto-switches and shows the in-flight entry with a spinner.
2. Reload mid-generation → History tab still shows the entry, polling continues, completes as expected.
3. Click any row in History → playhead jumps to scene start, Inspector switches back to Shot tab, scene is selected.
4. Failed entries: red dot + error message inline. Hover for absolute timestamp.
5. Empty state: "No generations yet. Click Generate on any scene to start."

## Security (rule 13)

- All routes verify project ownership via the existing auth helper.
- `prompt_excerpt` truncated to 140 chars at insert.
- `error_message` inherited from `broll_clips` (already sanitized).
- Logging-table write failures must never throw or block the actual generation.

## Observability (rule 14)

- `console.info('[generation-events insert]', { projectId, rowIndex, eventType, brollClipId, eventId })` on kickoff.
- `console.info('[generation-events update]', { eventId, status, brollClipId })` on completion.
- `console.error('[generation-events insert failed]', { error, ... })` on failure — non-throwing.
- Backend route logs request/response with `[api generation-events]` tag.
- History panel logs `[history panel jump]`, `[history panel reconcile]` on user actions.

## Settings (rule 15)

None for v1. Log is always-on, no behavioral knobs.

## Cost (rule 8)

Zero new external services. Postgres only. Negligible.

## Implementation order

1. Migration `0083_create_generation_events.ts`.
2. API routes (`POST`, `PATCH`, `GET`).
3. Client helper to insert/update events (`src/lib/editor/generation-events.ts`).
4. Wire helper into `handleGenerateClip` (kickoff) and the polling completion path.
5. New `GenerationHistoryPanel` component.
6. Add `'history'` tab in `EditorInspector`.
7. Pass the slot from `EditorClient`, including auto-switch effect.
8. Manual QA: golden path, refresh mid-generate, failure path, batch "Animate all", jump-to-scene.
