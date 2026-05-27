# Plan: Port variants, title cards, per-row notes into the shot-graph editor

**Date:** 2026-05-27
**Status:** Approved by user 2026-05-27
**Related plans:**
- [2026-05-18-shot-graph-editor.md](2026-05-18-shot-graph-editor.md) — the editor surface at `/edit/[projectId]` (original design intent: a different paradigm from production-doc, not a parity port).
- [2026-05-25-near-static-variants.md](2026-05-25-near-static-variants.md) — variants as separate rows sharing `group_id`. Already shipped to production-doc grid.
- [2026-05-25-editor-view-variant-inspector.md](2026-05-25-editor-view-variant-inspector.md) — variant panel for the *production-doc Editor view*, NOT this editor. Untracked components.

## Why

User clicked "Open in editor →" on production-doc, landed in the shot-graph
editor at `/edit/[projectId]`, and discovered three real gaps:

1. Variant rows render in the timeline but the editor has zero variant
   affordance — no chip, no edit-prompt textarea, no regenerate-from-base
   button. To manage variants the user has to go back to the production-doc
   grid.
2. Title cards have no visual indicator and no way to make/promote/split a
   row into one.
3. Per-row notes (visible in the production-doc grid) are not surfaced
   per-row in the editor; only the timeline-level NotesDock is mounted.

User-chosen direction (2026-05-27): **port these into the shot-graph editor
itself** rather than rerouting "Open in editor" elsewhere or hiding it.
Accepts the maintenance cost of two near-parity editor surfaces.

## Non-goals

- The Remotion render pipeline. Variants already render as independent
  shots (each row has its own timecode + duration + image). No renderer
  change needed.
- The `/api/generate/production-doc/image/edit` endpoint. It already
  handles variant edits; this work calls it from the editor.
- The `project_assets` storage layer. Variant images persist via the same
  `/api/edit/[projectId]/row-asset` POST path as base images.
- The production-doc grid view. Untouched.
- The future production-doc Editor view at `src/components/production-doc/editor/`.
  Those untracked components are a separate surface; we do NOT consume them
  from `/edit/[projectId]`.

## Phases

### Phase 1 — Variants

**Visual indicator on the shot strip / list**
- Rows with `group_id` set get a left-border accent in the section's group color.
- Variant rows (`variant_index > 0`) show chip `var N/M`.
- Base rows (`variant_index === 0` AND group has > 1 row) show chip `base · M variants`.

**Inspector "Variants" accordion**
Three render states, matching the production-doc affordance set:

1. **Standalone row** — dashed `+ Add variant` button. Click promotes the
   row to `variant_index = 0`, stamps a new `group_id`, inserts a new
   `variant_index = 1` row right after.
2. **Base row** — chip + horizontal mini-strip of variants in the group
   (click jumps the editor's selection to that variant) + `+ Add variant`.
3. **Variant row** — chip + `variant_edit_prompt` textarea (autosaves on
   blur via `PATCH_ROW`) + `✨ Generate variant (~$0.011)` button + `Delete
   variant` + `Move ↑↓ within group`.

**Generate-from-base flow**
- Fire-and-forget POST to `/api/generate/production-doc/image/edit` with
  the composed prompt (base.ai_image_prompt + variant.variant_edit_prompt)
  + base image URL.
- On success: write the returned URL via `/row-asset` POST (same channel as
  every other image write in the editor).

**New store commands**
- `ADD_VARIANT_ROW { baseIndex }` — promotes/creates as above. Reindexes
  `project_assets` rows whose `row_index > baseIndex` via the existing
  `reindex-for-command` helper.
- `DELETE_VARIANT_ROW { rowIndex }` — removes a variant, leaves base intact.
  If the deleted variant was the last in the group, also clear `group_id`
  from the base. Reindexes via the existing helper.
- `MOVE_VARIANT_ROW { rowIndex, direction }` — swap adjacent rows within
  the same `group_id`. No-op if the swap would cross a group boundary.

Tests for each command in `tests/editor-reindex-for-command.test.ts`
(or a sibling test file).

### Phase 2 — Title cards

**Visual indicator** — title-card badge on the shot strip / list for
`visual_type === 'Title Card'`.

**Inspector**
- New "Shot Type" select with options: Animation / Title Card / Statistics
  / B-Roll / blank. Writes via new `SET_ROW_VISUAL_TYPE` command.
- `✂ Split as title card` button — extracts a leading `##` heading from
  `script_text` into a new Title Card row inserted above the current row.
  Port the existing algorithm from production-doc verbatim.
- `Apply as section title →` button on Title Card rows — propagates the
  card's `script_text` as `section_title` to every downstream row until
  the next Title Card. Port verbatim.

**New store commands**
- `SET_ROW_VISUAL_TYPE { rowIndex, visualType }` — patches `visual_type`.
  When promoting to Title Card, also clears `ai_image_prompt`,
  `visual_description`, `image_saliency` (same as production-doc).
- `SPLIT_AS_TITLE_CARD { rowIndex }` — extracts heading, inserts new row,
  reindexes via existing helper.
- `APPLY_TITLE_CARD_AS_SECTION_TITLE { rowIndex }` — bulk PATCH on
  downstream rows.

Tests per command.

### Phase 3 — Per-row notes

- `notes` textarea per row in Inspector (separate from NotesDock; that
  stays for timeline annotations).
- `SET_ROW_NOTES { rowIndex, notes }` command + test.

## Risks

- **Reindexing** is the highest-risk class. Adding/deleting rows shifts
  every higher index in `project_assets` AND `text_overlays.attachToRow`.
  Mitigation: use the existing `reindex-for-command.ts` helper and add
  tests for the new commands.
- **Density**: 171-row docs with many variant groups will have a busy
  shot strip. Mitigation: small, scan-friendly chips (single-character
  glyph + N/M); left-border, not full background, so the thumbnail still
  reads.
- **Title-card splitting algorithm parity**: the production-doc version
  has corner cases (markdown headings inside code fences, multi-line
  headings). Mitigation: copy the algorithm verbatim; cite the source
  line in a comment so future maintainers can sync.
- **The shot-graph editor uses Remotion** to render the preview. Changes
  to row count/index propagate to the rendered video. The editor's save
  path is asset-blind, so the doc shape edits flow through the full PATCH
  while image URLs flow through `/row-asset` — both already version-safe.

## Sequencing

1. Save this plan (done).
2. Read the existing editor primitives + the production-doc helpers to
   port.
3. Phase 1 (variants) — commands + Inspector + indicators + tests.
4. Phase 2 (title cards) — commands + Inspector + indicators + tests.
5. Phase 3 (per-row notes) — textarea + command + test.
6. Typecheck + run the touched test files.
7. Commit + push as one bundle (user accepted scope explicitly).
