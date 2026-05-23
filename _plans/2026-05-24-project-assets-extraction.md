# Project assets extraction — move rowImages/Overlays/VideoClips out of payload JSONB

**Date**: 2026-05-24
**Author**: Yoav + Claude
**Status**: Approved (pending build)

## Goal

Move per-row asset URLs (`rowImages`, `rowOverlays`, `rowVideoClips`)
out of `user_history.payload` JSONB into a dedicated
`project_assets` table. Keeps the payload size bounded by shot
count's TEXT data only, no longer by the URL strings.

## Why now

User's 184-shot NotPetya project hit the row-asset POST 413
"Payload too large" cap. The 2 MB → 10 MB band-aid in commit
`030e6ff` unblocks today; this plan eliminates the cap class.

Bonus: also fixes the **insert/delete reindex bug** I traced
earlier — currently, client-side reindex of `rowImages` keys
(after INSERT_BLANK_SHOT / DELETE_SHOT) never propagates to the
server (the editor PATCH ignores incoming asset maps by design at
[persist.ts:264-269](src/lib/project/persist.ts#L264-L269)). The
new dedicated reindex endpoint runs the SQL shift atomically.

## Verified constraints

- Migration runner: `scripts/migrate.ts` with `src/lib/migrations/NNNN_name.ts`. Next ID **0084**. `vercel-build` runs migrations on every deploy.
- `user_history.id` IS the project id from the editor's perspective. FK target.
- Existing precedent for asset side-tables: `broll_clips` (migration 0023) — uses `project_id` + `row_index` + dedicated URL columns.
- Asset writes today funnel through **exactly two paths**:
  1. `src/lib/project/persist.ts` saveProjectPatch — only PRESERVES (copies current asset maps verbatim, never mutates)
  2. `src/app/api/edit/[projectId]/row-asset/route.ts` POST — atomic jsonb_set, only mutator
- 16 read sites of `payload.rowImages` etc. — must continue to see the same Record<number, …> shape (compat).
- SQL pattern: `@vercel/postgres` tagged-template literals; no explicit transactions per-query (the migration runner wraps each migration in one transaction; this code path doesn't need explicit txns because each call is a single statement).

## Chosen approach

### Schema (migration 0084)

```sql
CREATE TABLE project_assets (
  project_id UUID NOT NULL REFERENCES user_history(id) ON DELETE CASCADE,
  row_index  INT  NOT NULL CHECK (row_index >= 0),
  slot       TEXT NOT NULL CHECK (slot IN ('image', 'overlay', 'clip')),
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, row_index, slot)
);
CREATE INDEX idx_project_assets_project ON project_assets(project_id);
```

`data` shape per slot:
- `image`: string (URL)
- `overlay`: `{ status: string, url?: string }`
- `clip`: `{ status: string, videoUrl?: string, durationSeconds?: number, brollClipId?: string }`

Exactly mirrors what the editor expects in `payload.rowImages`, etc.

### Lazy backfill (no big-bang migration)

A schema migration that runs `INSERT INTO project_assets SELECT ...
FROM user_history` for 100K+ existing projects would be slow,
risky, and require downtime. Instead:

- On every GET `/api/edit/[projectId]`, server checks `project_assets`.
- If the project has NO rows in `project_assets` AND the payload has
  non-empty asset maps, run a one-shot backfill INSERT for that
  single project (cheap — a few hundred rows max), then proceed.
- Idempotent: future GETs see rows in `project_assets`, skip the
  backfill.
- Over time, every accessed project migrates automatically. Stale
  projects (never opened) stay in the payload until accessed.

### Write path

- `POST /api/edit/[projectId]/row-asset` body unchanged. Server
  switches from `jsonb_set` on user_history.payload to
  `INSERT ... ON CONFLICT DO UPDATE` on project_assets. Bumps
  user_history.version (preserves the existing optimistic-sync
  contract for the editor).
- Old `jsonb_set` path is REMOVED in the same commit — assets are
  no longer in the payload at all once a project has been touched.

### Read path

- `GET /api/edit/[projectId]` returns the same wire shape (the
  16 read-sites in EditorClient / production-doc / Remotion don't
  change).
- Server: load payload → load project_assets → assemble
  `payload.rowImages / .rowOverlays / .rowVideoClips` from the
  table, then return. Existing payload's asset maps are **ignored**
  on read (after backfill they're stale anyway).

### Reindex on row insert / delete

New endpoint `POST /api/edit/[projectId]/row-reindex` with body:
```
{ op: 'insert' | 'delete', atIndex: number }
```

Server runs (atomic single statement per op):
- **insert at N**: `UPDATE project_assets SET row_index = row_index + 1 WHERE project_id = $1 AND row_index >= $2`
- **delete at N**: a CTE that DELETEs the row at N AND shifts subsequent rows down by 1:
  ```sql
  WITH _ AS (DELETE FROM project_assets WHERE project_id = $1 AND row_index = $2)
  UPDATE project_assets SET row_index = row_index - 1 WHERE project_id = $1 AND row_index > $2
  ```

EditorClient wires:
- After `INSERT_BLANK_SHOT` dispatch → fire row-reindex `{op:'insert', atIndex}`
- After `DELETE_SHOT` (ripple mode) → fire row-reindex `{op:'delete', atIndex}`
- After `REMOVE_INSERTED_SHOT` (inverse of insert) → fire row-reindex `{op:'delete', atIndex}`
- After redo-insert (inverse of REMOVE_INSERTED_SHOT) → fire `{op:'insert', atIndex}`

Failure to reindex (network error, server 5xx) is surfaced via toast
(same pattern as the row-asset toast I added in commit `61f7e92`).

### Migration safety

- **Atomic per-project backfill**: wrapped in a transaction so a
  partial backfill (server crash mid-INSERT) can't leave the project
  half-migrated. Either all assets land in the new table or none.
- **No data loss path**: if the new table is empty AND the payload
  has assets, we backfill from the payload — payload still has the
  authoritative copy until backfill runs.
- **Rollback story**: if the new endpoint or table has a critical
  bug, the migration's `down()` drops the table cleanly; the editor
  reads can fall back to the payload's asset maps (which are still
  present for projects that haven't written via the new endpoint
  yet). For projects that HAVE written via the new endpoint between
  the broken-deploy and the rollback, those writes would be lost on
  rollback — acceptable risk given the small window.

## Phased execution

**Phase 1 — Migration + helpers** (~30 min)
- Migration 0084 creates the table + index.
- New helper module `src/lib/project/assets.ts`:
  - `loadProjectAssets(projectId): Promise<{rowImages, rowOverlays, rowVideoClips}>`
  - `writeProjectAsset(projectId, rowIndex, slot, value): Promise<void>` (UPSERT)
  - `reindexProjectAssets(projectId, op, atIndex): Promise<void>`
  - `backfillFromPayload(projectId, payload): Promise<void>` (transactional)
- Unit tests for each helper against a test DB row.

**Phase 2 — Read path** (~20 min)
- `loadProject` in persist.ts joins project_assets after the SELECT.
- Triggers `backfillFromPayload` when project_assets is empty but
  payload has assets.
- Returns the same `ProjectPayload` shape.

**Phase 3 — Write path** (~20 min)
- Rewrite `/api/edit/[projectId]/row-asset` to UPSERT into
  project_assets instead of jsonb_set. Bumps user_history.version.
- Existing client (EditorClient writeRowAsset) doesn't change.

**Phase 4 — Reindex endpoint + client wiring** (~30 min)
- New `/api/edit/[projectId]/row-reindex` endpoint.
- EditorClient watches reducer dispatches via a wrapper around
  `apply()`. For INSERT_BLANK_SHOT / DELETE_SHOT /
  REMOVE_INSERTED_SHOT, fires the reindex call after the local
  dispatch.

**Phase 5 — Verification** (~20 min)
- Unit tests for the asset helpers.
- Integration test: full round-trip (save asset → GET back).
- Manual: hard-refresh the editor, open a 184-shot project, upload
  an image, refresh, verify it persists.
- Manual: insert a blank scene at index 50, upload image to it,
  delete a scene at index 20, verify the inserted blank's image
  still lands on the right shot.

**Phase 6 — Commit + push** (~10 min)
- Single commit covering migration + helpers + 3 endpoint changes
  + client wrapper. Detailed commit message tracing the full path
  from user-visible bug to architectural fix.

**Total estimate**: ~2 working hours.

## Security (rule 13)

- Project-id ownership enforced at every endpoint via the existing
  `apiRoute.authed` + workspace_id/collaborator_id binds.
  project_assets has FK ON DELETE CASCADE to user_history so an
  orphaned asset is impossible.
- Row-asset validate URL same as today (https only, max 8 KB).
- Reindex endpoint accepts only `op: 'insert' | 'delete'` and a
  non-negative integer `atIndex` ≤ 1000. SQL is parameterized.
- Rate-limit: row-asset 240/min stays; new reindex endpoint gets
  the same (per IP).

## Observability (rule 14)

- `[project-assets backfill] start/done` with project_id + asset
  count.
- `[project-assets write] committed` with project_id + row_index +
  slot + new_version.
- `[project-assets reindex] {op,atIndex,affected_rows}`.
- Toast surfaces every failure (same pattern as the existing
  writeRowAsset toast in EditorClient).

## Settings audit (rule 15)

No new settings. The extraction is opaque to users.

## Alternatives rejected

**Big-bang migration** (run `INSERT INTO project_assets SELECT ...
FROM user_history` for ALL projects at deploy time). Rejected:
risky on a large prod table, requires downtime, hard to roll back.

**Dual-write during a transition window** (write to both payload
AND table, then cut over). Rejected: more code, more state, two
sources of truth, race conditions. Lazy backfill is simpler.

**Per-slot tables** (project_images, project_overlays,
project_video_clips). Rejected: three tables to maintain, three
endpoints to write, identical schema otherwise. Single table with
`slot` discriminator matches the existing client-side discriminator.

**Keep payload as canonical AND mirror to table** (write to both,
prefer table on read). Rejected: doubles write traffic, doubles
storage, race conditions between the two writes.
