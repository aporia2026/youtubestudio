# B-roll clip ↔ production-doc link + DB hydration (Phase 2)

**Date**: 2026-05-17
**Branch**: phase-1-foundation
**Status**: approved by user, ready to implement
**Predecessor**: [_plans/2026-05-17-render-state-hardening.md](_plans/2026-05-17-render-state-hardening.md) (Phase 1)

## Goal

Make B-roll clips recoverable from the **database** on doc reload, not just
localStorage. Closes the gap Phase 1 deferred: cross-device, cleared-
localStorage, and incognito-mode users today have no way to recover paid
clips beyond what each `BrollCell`'s per-row localStorage map remembers.

Overlays are **not** in scope for Phase 2. They're content-addressable in
R2 (`overlays/{workspaceId}/{sha256-of-terms}.png`), so re-fetching with the
same `overlay_stock_terms` round-trips for free. Phase 1's history-entry
persistence is enough for them.

## User decisions captured

1. **Doc identifier**: use the page's existing `historyEntryId` (string).
2. **Unsaved docs**: allow clip generation; clip persists with
   `production_doc_id = NULL`. Per-cell localStorage is the only recovery
   path for those. No regression vs today; same code path as Phase 1.
3. **Backfill of existing clips**: leave as orphans. New clips going forward
   get tagged.

## Data model

### Migration `0072_broll_clips_production_doc_id`

```sql
ALTER TABLE IF EXISTS broll_clips
  ADD COLUMN IF NOT EXISTS production_doc_id TEXT;

CREATE INDEX IF NOT EXISTS idx_broll_clips_production_doc
  ON broll_clips(production_doc_id) WHERE production_doc_id IS NOT NULL;
```

`TEXT` because `historyEntryId` is a string in the existing code (see
`ProductionDocHistoryEntry.id` in [src/lib/history.ts](src/lib/history.ts)),
not a UUID. The partial index avoids indexing the NULL legacy rows.

## Library + route changes

### `src/lib/broll.ts`

- `StartBrollGenerationArgs` gains `productionDocId?: string | null`.
- `startBrollGeneration` `INSERT` writes `production_doc_id` from args.
- `listBrollForWorkspace` opts gain `productionDocId?: string`; when
  present, filter the existing workspace-scoped query by it.
- `BrollClipRow` (in [broll-types.ts](src/lib/broll-types.ts)) gains
  `production_doc_id: string | null` on the returned row shape; the
  SELECT lists in `listBrollForWorkspace` + `getBrollClip` add the column.

### `src/app/api/broll/route.ts`

- POST body validates optional `productionDocId` (string, max 64 chars).
- POST passes it through to `startBrollGeneration`.
- GET accepts `?productionDocId=…` query param, passes to
  `listBrollForWorkspace`.

### `src/app/api/broll/[id]/route.ts`

- Returns `production_doc_id` on the clip row (no behaviour change beyond
  type plumbing).

## Client changes

### `src/components/production-doc/BrollCell.tsx`

- `kickoffBrollGeneration` accepts `productionDocId: string | null`,
  forwards to POST body.
- `BrollCellProps` gains `productionDocId?: string | null`; the
  per-cell `handleGenerate` and `handleRegenerate` pass it through.

### `src/app/(app)/production-doc/page.tsx`

- Both `BrollCell` callsites pass `productionDocId={historyEntryId}`.
- The page's `animateAll` batch (`kickoffBrollGeneration` call at
  [~L2105](src/app/(app)/production-doc/page.tsx#L2105)) passes
  `productionDocId: historyEntryId`.
- **New mount-time DB hydration**: when `historyEntryId` becomes non-null
  (initial mount restore OR sidebar history-entry click), call
  `GET /api/broll?productionDocId={historyEntryId}` once and, for each
  returned clip, look up the row by `rowSignature` (same map as Phase 1)
  and fire `handleBrollClipChange(rowIndex, { status, video_url })`.
  Also re-populate `readBrollLsMap` so per-cell hydration on next visit
  still works.
- This effect is **idempotent** with the existing per-cell hydration
  (Phase 1) — if both paths bring the same clip into state,
  `handleBrollClipChange` is a no-op when the new entry equals the
  existing one (already enforced at [page.tsx:1919-1924](src/app/(app)/production-doc/page.tsx#L1919-L1924)).

## Observability (rule 14)

- `[broll db-hydrate]` per page mount that runs the new DB sweep:
  `{ historyEntryId, fetched, applied, skipped, missingRowSignature }`.
- `[broll create]` already exists in `lib/broll.ts`; extend it to include
  `production_doc_id` so the linkage is visible in server logs.

## Security / safety (rule 13)

- `production_doc_id` is a string the client supplies. Workspace scoping is
  already enforced on every read/write — `WHERE workspace_id = ${session.ws}`.
  An attacker can at worst tag their own clips with a chosen string;
  cross-workspace data is unreachable.
- Length cap (64 chars) prevents a malicious client from writing a
  multi-megabyte string into the column.

## Cost (rule 8)

- One small DDL on `broll_clips`: ALTER + partial index. Vercel Postgres
  pricing is per-storage / per-CPU-second — this is rounding error.
- New mount-time GET: one extra SQL query per page load when
  `historyEntryId` is set. Workspace-scoped + indexed; fast.
- No new third-party API calls. No new model spend.

## QA (rule 6)

Golden path (the new capability):
1. Generate a doc with clips on device A. Save (history entry).
2. Open the doc URL on device B (or clear localStorage on device A).
3. Click the history sidebar entry. Expect:
   `[broll db-hydrate]` log fires, every ready clip from device A's
   generation lands in `rowVideoClips` state, the renderer produces an
   MP4 with the animations.

Edge cases:
1. Doc with no history entry yet → no DB hydration, falls back to per-cell
   localStorage (today's behaviour). New clips this session persist with
   `production_doc_id = NULL` and become orphans relative to this feature.
2. Doc with history entry but no clips → GET returns empty, no-op.
3. Row signature in doc doesn't match a returned clip (e.g. user edited
   `visual_description`) → log the unmatched clip + skip. Same orphaning
   semantics as before.
4. Two clips with the same `rowSignature` for the same `production_doc_id`
   (user regenerated) → take the newest (DB orders by `created_at DESC`).

Regression checks:
- Existing flows (Animate single, Animate all, lock-as-still) still work
  for unsaved docs.
- The pre-render verification modal from Phase 1 still triggers correctly
  when per-cell localStorage has clips not yet in state — DB hydration is
  best-effort and doesn't replace the modal.

## Files touched

- `src/lib/migrations/0072_broll_clips_production_doc_id.ts` (new)
- `src/lib/migrations/index.ts`
- `src/lib/broll.ts`
- `src/lib/broll-types.ts`
- `src/app/api/broll/route.ts`
- `src/components/production-doc/BrollCell.tsx`
- `src/app/(app)/production-doc/page.tsx`
