# Heal row-asset desync — recover projects broken by the insert/delete reindex bug

**Date**: 2026-05-24
**Author**: Yoav + Claude
**Status**: Approved (sub-plan of `2026-05-24-project-assets-extraction.md`)

## Goal

Recover existing projects whose `rowImages` / `rowOverlays` /
`rowVideoClips` keys are out of sync with `doc.rows` because of the
client-side reindex never propagating to the server (see
[persist.ts:329-334](src/lib/project/persist.ts#L329-L334) — the PATCH
endpoint deliberately strips incoming asset maps and keeps the server's
copy). Every `INSERT_BLANK_SHOT` / `DELETE_SHOT` / `DUPLICATE_SHOT` /
`REMOVE_INSERTED_SHOT` since the project's creation has left an
unmerged drift.

The structural fix (the parent plan's Phase 4 reindex endpoint) stops
the drift from this point forward; this sub-plan repairs the drift
that's already on disk.

## Symptom

User reports "preview image is wrong for some shots" and "timeline
thumbnails are wrong." Concrete repro (the NotPetya project,
`fb467198-5b80-4483-bffc-1827d6ec447e`):
- Inspector shows row N's text content (script, AI image prompt,
  section title).
- Preview canvas + timeline thumbnail at row N show the IMAGE that
  belonged to row N-K, where K is the number of blank shots inserted
  at indices ≤ N since the last fully-correct save.

## Constraints — what we *can't* do

- There is **no per-row anchor** that pins an image URL to a row's
  content. The row carries `image_rmbg_url` (background-removed cutout,
  derived from the original) and `image_saliency` (cached map of the
  image), but the canonical image URL lives in the sidecar `rowImages`
  map only.
- There is **no payload history table**. `user_history` carries only
  the current snapshot — no prior versions to roll back to.
- `generation_events` tracks B-roll (video) generations, not images.

So the heal can only use the SHAPE of the desync, not content
matching.

## Two-mode heal

### Mode A — auto-heal (inserts-only common case)

Works when the only structural edits since the desync started were
`INSERT_BLANK_SHOT` operations. Holds for the NotPetya project per
user recall and is the dominant edit pattern.

**Algorithm**:

1. Walk `doc.rows` in order. Mark each row as either "blank-inserted"
   or "original":
   - Blank-inserted ⇒ `visual_type === 'blank'` AND `script_text` is
     empty/whitespace AND no `image_url` ever generated. These are
     the inserted-via-`INSERT_BLANK_SHOT` rows.
   - Original ⇒ everything else.
2. The j-th "original" row in the final array corresponds to the j-th
   `rowImages` key in ascending order (in the server's un-reindexed
   map).
3. Build the remap: `{ originalRowIdx_j → finalIdx_of_jth_original_row }`.
4. Apply atomically: `UPDATE project_assets SET row_index = remap[row_index]`
   for every affected row in a single statement (or a CTE with
   `VALUES (...)` if Postgres balks at the case-when).

**Refuse to act when**:
- Count of `rowImages` keys ≠ count of "original" rows in `doc.rows`.
  Means the user did a delete / duplicate / regenerate that broke the
  inserts-only assumption — auto-heal would mis-map.
- `rowImages` keys are not dense `0..N-1`. Sparse keys are normal (a
  row never generated an image) and OK; gaps in the middle that don't
  align with the expected pattern are not.
- Doc has fewer than 2 inserted blanks. Below that threshold the user
  could just re-upload manually; the heal's risk isn't worth it.

Dry-run mode returns the proposed remap as JSON without applying.
Apply mode requires `confirm: true` in the body so a stray fetch
doesn't mutate anything.

### Mode B — manual remap UI

Fallback when auto refuses (mixed edit history) or when the user
prefers eyes-on verification.

**UI shape**: a full-screen modal opened from a "Repair images" entry
point in the editor toolbar's overflow menu.

- Left column: a vertical list of all `doc.rows` with their script
  excerpt + section title + visual_type badge. Each row shows the
  image currently displayed (`rowImages[i]`) at thumbnail size.
- Right column: a flat grid of every `rowImages` URL as small
  thumbnails, labeled with their current key.
- User drags an image from the right grid onto a row on the left to
  re-attach it. The previously-attached image moves to a holding tray
  at the top so it isn't lost mid-remap.
- "Save changes" button writes the full remap via the same heal
  endpoint as Mode A. Idempotent — re-running with the same input is a
  no-op.

184 shots = a lot of clicks, but the auto-heal handles the common case;
the manual UI is for the long tail. Worst case the user remaps the
~30 visibly-wrong shots and ignores the rest.

## API surface

```
GET  /api/edit/[projectId]/heal-row-assets
  → 200 {
      diagnosis: 'aligned' | 'inserts-only-drift' | 'mixed-edits' | 'no-assets',
      assetCount: number,
      rowCount: number,
      blankRowCount: number,
      originalRowCount: number,
      proposedRemap?: Array<{ from: number; to: number }>,
      orphans?: number[],   // keys we couldn't place
      reason?: string,      // why auto refuses (when not auto-healable)
    }
  Diagnostic only. Read-only. Cheap.

POST /api/edit/[projectId]/heal-row-assets
  body: { mode: 'auto', confirm: true }
    → apply the auto-heal computed server-side; reject if state
      changed since the last GET (compare expected counts).
  body: { mode: 'manual', remap: Array<{from: number, to: number}>, confirm: true }
    → apply an explicit client-provided remap. Validates: no duplicate
      `to`, every `from` exists, every `to` < doc.rows.length.
  → 200 { ok: true, applied: number, version: number }
  → 409 { error: 'state-changed', code: 'CONFLICT' }   // re-GET and retry
  → 400 invalid remap
```

## Server implementation notes

- Heal runs against `project_assets` AFTER the parent plan's Phase 2
  read path lands (so backfilled rows are the source of truth).
- Atomic via `BEGIN ... COMMIT`. The remap is a single statement using
  a `VALUES` list joined back to the table:
  ```sql
  WITH remap (old_idx, new_idx) AS (
    VALUES (0, 0), (1, 2), (2, 3), ...
  )
  UPDATE project_assets pa
     SET row_index = r.new_idx,
         updated_at = NOW()
    FROM remap r
   WHERE pa.project_id = $1::uuid
     AND pa.row_index  = r.old_idx
  ```
  Unique constraint on `(project_id, row_index, slot)` could collide
  if old and new ranges overlap — Postgres applies updates atomically
  at statement end (constraint deferred via `INITIALLY DEFERRED` on
  the PK isn't an option since PKs aren't deferrable by default). To
  avoid mid-statement collision, the heal first moves everything to a
  high-offset range (e.g. `+10_000`), then to the final range:
  ```sql
  UPDATE project_assets SET row_index = row_index + 10_000 WHERE project_id = $1;
  -- then apply the actual remap with the VALUES list against +10_000 source.
  ```
  All in one transaction so a partial heal can't leave the table
  half-shifted.

- Bumps `user_history.version` after success so any other open editor
  tabs notice the change on their next sync.

## Client implementation notes

- "Repair images" entry: toolbar overflow menu (`⋯` button), single
  list item that calls GET on click.
- Diagnostic result rendered as a small banner: "✅ All images are
  correctly mapped" / "⚠ Detected K shifted images — Repair" / etc.
- Repair confirm dialog shows a preview of the proposed remap
  (first/last 5 shots with their old→new index pairs) so the user
  sees what's about to change.
- After successful apply, full project reload (existing `useProject`
  refresh path) so the new state lands without local cache drift.

## Security (rule 13)

- Same `apiRoute.authed` + workspace/collaborator scope binds as every
  other `/api/edit/[projectId]/*` endpoint.
- Body validation:
  - `mode` must be `'auto'` or `'manual'`.
  - `confirm` must be `true` — a missing/false confirm short-circuits
    with 400.
  - `remap` (manual mode): max 5000 entries; each `{from, to}` are
    integers in `[0, doc.rows.length)`; no duplicate `to` values.
- Rate-limit: 6 / minute per project (heal is a heavy mutation; this
  is generous for retries but tight enough to block abuse).
- Logs every heal apply with `project_id`, mode, asset count moved,
  resulting version. Surfaces in the ops dashboard so we can audit
  who repaired what.

## Observability (rule 14)

- `[heal-row-assets diagnose]` with diagnosis + counts.
- `[heal-row-assets apply start]` with mode + planned remap size.
- `[heal-row-assets apply committed]` with applied count + new version.
- `[heal-row-assets refused]` with reason (state-changed, invalid,
  rate-limited).

## Settings audit (rule 15)

No new settings. Heal is a one-shot maintenance action accessed via
the editor toolbar's overflow menu.

## Alternatives rejected

**Content-based remap via image saliency**. For each row, the
`image_saliency` map cached on the row was computed against the
ORIGINAL image at gen time. Match each `rowImages[k]` URL by fetching
the image, computing its saliency, and pairing with the row whose
cached saliency matches. Rejected: slow (one fetch + analyze per
image), expensive (compute + bandwidth), unreliable (saliency
recompute may drift slightly vs cached).

**Re-generate everything**. For broken projects, just wipe `rowImages`
and let the user regenerate from scratch. Rejected: a 184-shot project
at ~$0.05/image is $9.20 + 15+ minutes of user wait — not acceptable
when most of the data is recoverable.

**Manual SQL patch per affected project**. Pragmatic for one project
but the bug exists across the user base — any project that's been
through a structural edit since the bug shipped has the drift. A
per-project ad-hoc fix doesn't scale.

## Phased execution

**Phase A — diagnostic endpoint** (~20 min). The GET endpoint +
analysis. No mutations, just reporting. Returns the proposed remap
so the apply path is a separate concern.

**Phase B — apply endpoint** (~30 min). The POST endpoint + the
two-step UPDATE (offset, then remap). Transactional. Both `auto` and
`manual` modes.

**Phase C — toolbar entry + diagnostic banner** (~20 min). The
"Repair images" menu item + the on-click GET that renders the banner.

**Phase D — manual remap UI** (~60 min). The full-screen modal with
left list + right grid + drag/drop. Lazy-loaded so it doesn't bloat
the editor bundle.

**Phase E — verification** (~30 min). Unit tests for the diagnosis +
remap math. Integration test: synthesize a project with the desync
pattern, run heal, assert correct rowImages keys.

**Total estimate**: ~2.5 working hours, ordered AFTER the parent
plan's Phases 1-4 land.
