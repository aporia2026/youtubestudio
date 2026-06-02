# Plan: prevent duplicate narrator assignments per project

**Date:** 2026-06-02
**Driver:** Narrations "disappeared" from project `444519e2-7c08-4b6f-954b-866efcc2d5e7`. Investigation showed a second assignment row was created today over the existing one; the NarrationTab UI only renders the most-recently-updated assignment per project, so the older one (which holds the actual 8-minute full-audio take) is hidden.

## Problem

`POST /api/narrator/assignments` always INSERTs a new row — it never checks for an existing active assignment on the same `project_id`. Every "Send to narrator" click (or any caller that hits this endpoint) silently creates a duplicate.

The owner-side `NarrationTab` uses `assignments.find(a => a.project_id === projectId)` over a list ordered by `updated_at DESC`. So a freshly inserted empty row will mask an older populated row.

Current state in DB (verified via `scripts/diag-narration-disappear.ts`):

| project_id | duplicates | safe to auto-resolve? |
|---|---|---|
| `82ed8e90-7844-4523-a0d1-90043d0267fd` | 4 rows (1 with takes + full audio, 3 empty) | yes — keep the one with takes |
| `444519e2-7c08-4b6f-954b-866efcc2d5e7` | 2 rows (1 with full audio, 1 empty) | yes |
| `f4be434c-de54-4e23-a714-8b090e36a1b7` | 2 rows (both empty, same script, same narrator) | yes — keep most recent |

No duplicate set has multiple "active" assignments where more than one has takes, so no judgment-call data loss.

## Approach

Defence in depth, two layers:

1. **DB constraint**: `CREATE UNIQUE INDEX narrator_assignments_one_active_per_project ON narrator_assignments(project_id) WHERE status IN ('assigned','received','recording','submitted','revisions')`. Terminal statuses (`approved`, `completed`) are intentionally excluded — once a narration is done, the owner can legitimately start a new round.
2. **App-level check**: `POST /api/narrator/assignments` queries for an existing active assignment first. If found, returns `409 Conflict` with the existing row's `share_token` + `id` so the AssignDialog can route the owner to the existing assignment instead of failing opaquely.

### Migration 0112

- For each project_id with multiple active assignments:
  - Pick the **winner** by `(take_count DESC, full_audio_take_id IS NOT NULL DESC, updated_at DESC)`. Ties broken by `created_at DESC`.
  - DELETE the losers. CASCADE handles their sections / takes / comments — but losers always have take_count=0 in current data, so this is a no-op for audio/comments. **Migration aborts (throws)** if any loser has take_count > 0. That's a data-loss safety net for any future DB state we didn't survey.
- Create the unique partial index.

### POST route

Pre-INSERT, run:

```sql
SELECT id, share_token FROM narrator_assignments
 WHERE project_id = $1 AND status IN ('assigned','received','recording','submitted','revisions')
 LIMIT 1
```

If a row exists, return 409 with `{ error, existing: { id, share_token } }`. No insert, no side effects, no schedule_items mutation.

### AssignDialog

On `res.status === 409` with `existing.share_token`, treat as "already assigned" — copy the existing link to clipboard and toast: "Already assigned to this project — link copied". Close the dialog. The owner sees the existing narration without ever creating a duplicate.

## Alternatives rejected

- **Allow multiple assignments and merge in UI**: more complex, doesn't fix the underlying model (one active narration job per project). Defers the cleanup.
- **Hard unique on project_id (no partial filter)**: blocks legitimate re-recordings after a previous one is completed. Wrong.
- **Skip migration cleanup, only add the app check**: index creation would fail on existing duplicates, breaking the deploy.

## Security

- The POST route is already wrapped by the workspace-scoped auth shim used elsewhere — no new attack surface.
- The 409 response leaks only the share_token, which is already accessible to anyone in the workspace who can list assignments. No new disclosure.

## Observability

- POST route logs `[narrator assign duplicate-blocked]` with `{ projectId, existingAssignmentId }` so we can see how often the dedup fires after deploy. If it fires a lot, that's a signal the UI is letting users re-click "Send to narrator" too freely and we should add a frontend guard.
- Migration logs `[narrator dedup]` per project with the winner ID and the losers it removed.

## Testing

- Migration tested locally against the current DB before pushing — verifies the three duplicate sets resolve to single rows with no take loss, and the unique index installs.
- New unit test `tests/narrator-assignment-dedup.test.ts`:
  - happy path: POST creates row when none exists
  - 409 path: POST returns 409 + existing share_token when an active assignment exists
  - terminal-status path: POST succeeds when only `approved` / `completed` rows exist for the project
- `npm test` full run before commit.

## Settings audit

No new user-facing controls. The dedup is a correctness fix, not a feature toggle. If we ever want "Allow re-assignment with archival of the previous job", that becomes a separate feature.

## Out of scope

- UI to manage/archive completed assignments (separate feature)
- Backfilling the old "submitted but never approved" assignments through approval (operator action)
- Changing the assignment status flow itself
