# Workspace-Level Character Bible (Phase 5)

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** Spec draft — to be picked up in a new session.
**Predecessor:** Phases 1 → 1.7 → 3 → 2 → 4 of the doodle_explainer_2 cache work. The cache and bible mechanisms are proven at the **per-doc** level (`doc.doodle_explainer_2_character_cache`, `doc.doodle_explainer_2_character_descriptions`). This phase lifts the bible to **workspace** scope so recurring characters reuse the same canonical base + description across many docs.

---

## Why this exists

The per-doc cache already saves money WITHIN a doc: one fresh i2i for George on his first row, then $0.011 Atlas Edits for every subsequent George row. Across the doc's ~10 character-bearing rows, that's ~$0.30 saved per regen.

**The gap:** every new doc starts the cache from zero. A series channel making 20 videos featuring the same protagonist (a recurring narrator, a historical figure who shows up in many episodes, a mascot) generates a fresh George base on every doc — 20 × $0.04 = $0.80 just for the first George base across the series. And the LLM-emitted description is rewritten from scratch each time, so the character's distinctive features (gray hair / mustache / vest / age) drift across episodes even when the slug is identical.

Workspace-level scope fixes both. One canonical base, one canonical description, reused across every doc the workspace owns. Series content stays visually consistent AND gets dramatically cheaper.

## Concrete use cases

1. **Story-explainer channels with recurring narrator/mascot.** Channel makes 50 videos with the same stick-figure narrator character. After the first video, every other video Atlas-Edits on the cached narrator base — zero fresh i2i for the protagonist.

2. **Historical-figure series.** Channel does an "Untold Stories of WWII" series. Eisenhower, Churchill, Roosevelt each appear in 5+ videos. Each gets a single canonical base; every appearance after that is an Atlas Edit.

3. **Educational channels with a "professor explains" framing.** The professor character is the same across the whole channel. Workspace bible defines them once.

4. **Story-arc channels with recurring side characters.** A "missing persons" channel where one investigator appears across many videos.

## Goals

1. A workspace-level character can be DEFINED once (slug + description + canonical base image) and REUSED on any doc in that workspace.
2. The existing per-doc cache + bible mechanism keeps working unchanged. Workspace data is an additional **source**; the doc-level fields remain the **local cache** that the dispatchers read at render time.
3. The editor surfaces workspace characters next to doc-local ones so the user can:
   - Pick a workspace character when assigning a row's `character_id`.
   - Promote a doc-local character to the workspace ("save George to my workspace library").
   - Edit / archive workspace characters from a dedicated settings page.
4. No regression on existing docs / workspaces that have never used workspace characters.

## Constraints

- **Scope: workspace, not user, not channel.** Workspaces are how content is organized today; cross-workspace sharing is out of scope.
- **Storage: new SQL table.** JSONB on the workspace settings record is tempting (zero migration) but makes querying / listing slow as the roster grows. A dedicated table is correct.
- **Snapshot semantics.** A doc that already saved a character description / base_url at gen-time keeps that snapshot. Workspace updates only affect FUTURE docs OR future regens that explicitly re-import. This matches the existing per-doc semantics and protects ongoing edits from upstream churn.
- **Lambda render compatibility.** The renderer reads `doc.payload.doc.*` — it must NOT need to fetch workspace data at render time. The dispatcher copies workspace data into the doc on first reference (existing doc-level fields). The renderer never queries the workspace table.
- **Permissions: workspace members can READ; only admins can WRITE.** Mirrors existing workspace permission semantics.
- **Atlas Edit identity fidelity has been smoke-tested for cross-pose continuity (`_plans/2026-05-28-atlas-edit-smoke/`).** The cross-doc case is mechanically identical — same Atlas Edit call on a cached base — so no new smoke test is required.

## Architecture

### Storage

New table `workspace_characters` in the existing Postgres schema:

```sql
CREATE TABLE workspace_characters (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  description   TEXT NOT NULL,
  base_url      TEXT,            -- R2 URL of the canonical i2i base; nullable until first generation
  base_style_id TEXT,            -- style this base was generated under ('doodle_explainer_2' today)
  first_doc_id  UUID,            -- the doc that generated the canonical base; useful for "show me where this came from"
  created_by    UUID REFERENCES collaborators(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ,     -- soft delete; archived characters drop out of the editor picker but stay queryable
  PRIMARY KEY (workspace_id, slug)
);

CREATE INDEX idx_workspace_characters_workspace ON workspace_characters(workspace_id) WHERE archived_at IS NULL;
```

`base_style_id` matters because a character base generated under doodle_explainer_2 may NOT compose well in paint_explainer_v1 (different visual aesthetic). For V1, the picker filters by style match. Cross-style reuse is a Phase 5.5 question.

A scene-level twin table (`workspace_scenes`) is in scope for parity; same schema swap `slug` semantics. Both ship in the same migration to avoid two rounds of UI work.

### API endpoints

New routes under `/api/workspace/characters/`:

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/workspace/characters` | List active workspace characters for the caller's workspace. Returns slug + description + base_url + base_style_id. Used by the editor's chip popover. |
| `POST` | `/api/workspace/characters` | Create. Body: `{ slug, description, baseUrl?, baseStyleId? }`. Validates slug + description length. |
| `PUT`  | `/api/workspace/characters/[slug]` | Update description and/or base_url. Body: `{ description?, baseUrl?, baseStyleId? }`. |
| `DELETE` | `/api/workspace/characters/[slug]` | Soft-delete (sets archived_at). |
| `POST` | `/api/workspace/characters/[slug]/promote-from-doc` | Promote a doc-local character to workspace: body `{ docId }`; reads `doc.doodle_explainer_2_character_descriptions[slug]` + `doc.doodle_explainer_2_character_cache[slug]` and persists them. |

All authed; workspace-id resolved from the session per the existing pattern in `src/lib/route-helpers.ts`. SSRF-check the `baseUrl` field same as the row-asset endpoint does today.

Mirror twin endpoints for `/api/workspace/scenes/`.

### Server-side dispatch integration

The dispatch sites that consume the doc-level cache + bible today are:
- Manual editor `generateImageForRow` (`src/app/(app)/production-doc/page.tsx`)
- Auto-pipeline `stages/generate-production-doc-images.ts`

Both gain a new "workspace fallback" branch in their cache-lookup logic:

1. Row has `character_id = "george"`.
2. Check doc cache (existing behavior). If hit → use it.
3. **NEW:** Else, check workspace cache. If a workspace entry exists for `(workspace_id, "george")` AND its `base_style_id` matches the doc's `style_preset`:
   - Use the workspace `base_url` for the Atlas Edit input.
   - **Copy** the workspace entry into the doc's local cache (`doc.doodle_explainer_2_character_cache[slug]`) so subsequent rows in this doc hit the doc cache (faster, no DB call per row), and so Lambda renders work offline.
   - Telemetry: `[manual-editor character-cache] workspace-import-hit` / `[doodle-2 character-cache] workspace-import-hit`.
4. Else fall back to fresh i2i + miss-and-store (existing behavior). The new entry lands in the doc-level cache; the user can later promote it to workspace via the UI.

Bible lookup gets the same treatment: when the doc's `doodle_explainer_2_character_descriptions` is missing a slug that has a workspace description, copy the workspace description into the doc on dispatch. The next regen has the description embedded; no DB hit at render time.

This "workspace as source, doc as cache" pattern is load-bearing — it keeps the renderer offline-compatible AND prevents stale workspace data from drifting into existing docs.

### Editor UI

Three surfaces:

#### 1. Per-row SlugChip enhancements

The existing `SlugChip` popover (from Phase 4) gains TWO sections in the dropdown:

```
+ New character_id…
─── From this doc ───
george   · 4 rows
jennie   · 2 rows
─── From workspace library ───
narrator-mascot    · used in 12 other docs
churchill          · used in 4 other docs
napoleon           · used in 3 other docs
Clear
```

Selecting a workspace character:
- Calls a new `attachWorkspaceCharacter(slug)` editor action.
- That action POSTs to `/api/workspace/characters/{slug}` to fetch the canonical description + base_url.
- Stamps both into the doc's local cache + descriptions map via `setDoc` + the atomic-persist pattern.
- Calls `updateRow(rowIndex, { character_id: slug })`.
- The next image-gen on the row hits the (newly-populated) doc cache.

Workspace entries in the popover are visually distinguished — gold border + a small workspace icon (e.g. 🏛 for shared library; pick a different glyph since 🏛 is already used by scene chip).

#### 2. CharacterDescriptionsPanel "Promote to workspace" button

The doc-level `CharacterDescriptionsPanel` (Phase 4) gains a "Promote to workspace" affordance per entry — a small button next to each [edit] / [add]:

```
george       │ Gray hair and mustache, dark vest…         [edit]  [promote ↑]
jennie       │ Yellow dress with brown apron…             [edit]  [promote ↑]
```

Clicking [promote ↑] hits `POST /api/workspace/characters/{slug}/promote-from-doc?docId={...}`. After success:
- The panel shows a small "in workspace ✓" badge next to that row.
- Future docs in the same workspace can pick this character from the SlugChip dropdown.

If a workspace character with that slug already exists, the button shows a confirm dialog: *"`george` already exists in your workspace library with a different description. Replace?"*

#### 3. Workspace settings page — Character Library

New page at `/workspace/character-library` (or extend existing settings):

```
Character Library

Search [           ]                      [+ New character]

Active (4)
  george          · used in 12 docs    [view] [edit] [archive]
  jennie          · used in 8 docs     [view] [edit] [archive]
  narrator-mascot · used in 47 docs    [view] [edit] [archive]
  churchill       · used in 4 docs     [view] [edit] [archive]

Archived (2)
  ...
```

Each [view] opens a side panel with:
- Slug
- Description (editable)
- Base image preview (the canonical R2 URL)
- "Generated from doc {first_doc_id}" link
- "Replace base image" affordance (upload a new R2 URL; future docs use the new base)
- Usage list — which docs reference this character

Same UI shape for scenes under `/workspace/scene-library`.

### Migration

The new table needs a forward migration. Existing docs untouched. No backfill needed — workspace characters land empty; users opt in by either:
- Clicking [promote ↑] on existing doc-level descriptions.
- Clicking [+ New character] in the workspace settings page.

If we want a one-time "scan your workspace for recurring characters" affordance (which slugs appear in ≥3 docs in this workspace? offer to promote the most-used description), that's a Phase 5.1 polish — out of scope for V1.

## Requirements

### R-1 — DB migration

New migration file under `scripts/migrate.ts` step. Creates `workspace_characters` and `workspace_scenes` tables with the schema above. Idempotent — safe to re-run. The auto-migrate-on-deploy path already in place runs this on the next Vercel deploy.

### R-2 — Server-side library modules

New `src/lib/workspace-character-library.ts` and `src/lib/workspace-scene-library.ts`:
- `listWorkspaceCharacters(workspaceId): Promise<WorkspaceCharacter[]>`
- `getWorkspaceCharacter(workspaceId, slug): Promise<WorkspaceCharacter | null>`
- `upsertWorkspaceCharacter(workspaceId, character): Promise<WorkspaceCharacter>`
- `archiveWorkspaceCharacter(workspaceId, slug, archivedBy): Promise<void>`
- `countUsageByDocId(workspaceId, slug): Promise<number>` — used by the library UI's "used in N docs" badge.

Pure DB access; no HTTP, no Atlas calls. Tested with the existing in-memory SQL test harness.

### R-3 — API routes

The five endpoints listed in the Architecture section, each gated on workspace admin permissions where needed. Validation:
- Slug passes `validateSlug` from `src/lib/character-bible.ts` (Phase 4).
- Description ≤ 500 chars (more generous than per-doc; this is the canonical source).
- baseUrl validated as SSRF-safe.

Rate-limit each endpoint same as existing workspace-config endpoints.

### R-4 — Dispatcher integration (workspace fallback)

Extend the cache-lookup logic in both dispatch paths:
- Manual editor: `generateImageForRow` consults workspace library when doc cache misses for a slug.
- Auto-pipeline: `stages/generate-production-doc-images.ts` does the same.

On workspace-import-hit, copy the workspace entry into the doc's local fields via the same atomic-persist pattern (`setDoc` + `updateProductionDocEntry`).

Both paths emit a new `workspace-import-hit` log line so QA can confirm the cross-doc reuse is firing.

### R-5 — Editor SlugChip enhancements

Update `src/components/production-doc/SlugChip.tsx`:
- Accept a new prop `workspaceSlugs: ReadonlyArray<{ slug: string; usageCount: number }>`.
- Render a second section in the dropdown for workspace entries.
- On select, dispatch `attachWorkspaceCharacter(slug)` instead of the existing local `onChange`.

Update `src/components/production-doc/CharacterDescriptionsPanel.tsx`:
- Accept a new prop `workspaceSlugs: Set<string>` indicating which slugs are already promoted.
- Show "in workspace ✓" badge OR [promote ↑] button per entry.

Update `src/app/(app)/production-doc/page.tsx`:
- Fetch workspace characters on mount via the new `GET /api/workspace/characters`. Cache in React state; invalidate on workspace-character mutations.
- Wire `attachWorkspaceCharacter` to the SlugChip popover.
- Wire [promote ↑] to `POST /api/workspace/characters/{slug}/promote-from-doc`.

### R-6 — Workspace settings page

New route `src/app/(app)/workspace/character-library/page.tsx` (or extend the existing workspace settings layout). Renders the library UI from the Architecture section.

Mirror for `/workspace/scene-library`.

### R-7 — Observability

- `[workspace-character-library] hit` per `workspace-import-hit` event during dispatch.
- `[workspace-character-library] write` per promotion.
- Standard CRUD logging on the API endpoints (consistent with other workspace endpoints).

### R-8 — Tests

- DB migration test (the existing migrate harness picks it up).
- Unit tests on the library functions (in-memory SQL).
- API route tests for each endpoint (request validation, permissions, response shape).
- Editor integration: render-test that the SlugChip popover shows both sections when both data sources are populated.
- One integration test of the workspace-import-hit dispatch path: row has slug "george", doc cache empty, workspace has "george" → dispatcher uses workspace base_url + writes to doc cache.

## Phased delivery

This is a sizeable PR; split into three commits for review hygiene:

1. **Commit 1 — DB migration + library modules + API endpoints.** Pure backend; safe to merge before any UI consumes it.
2. **Commit 2 — Dispatcher workspace-fallback branches + telemetry.** Wires the lookup. Without the UI from Commit 3, the only way to use it is via direct API call — useful for smoke-test seeding.
3. **Commit 3 — Editor UI (SlugChip + Panel enhancements + workspace settings page).** User-facing surface.

**Effort estimate:** ~12-15 hours. Migration + library + endpoints ~3 h; dispatcher integration ~2 h; editor UI ~5 h; settings page ~3 h; tests ~2 h.

## QA after the PR

End-to-end on a real workspace with at least one prior doodle_explainer_2 doc:

1. Open the existing doc, promote George + Jennie to the workspace via [promote ↑].
2. Create a NEW doc in the same workspace using the same script.
3. Verify the SlugChip popover shows George + Jennie under "From workspace library".
4. Assign character_id on the new doc's rows by picking from the workspace section.
5. Generate images. The first row with George should hit the workspace cache → Atlas Edit on the workspace base (NOT a fresh i2i). Confirm via `[manual-editor character-cache] workspace-import-hit` log.
6. Visually: George in the new doc looks like George in the old doc — same face / hair / clothing.
7. Cost: new doc spends roughly N × $0.011 on George rows instead of 1 × $0.04 + (N-1) × $0.011 — saves the first i2i.

## Settings audit (CLAUDE.md rule 15)

Two new surfaces that DO warrant settings exposure:

- **Workspace settings — Character Library page.** Central admin UI. Required.
- **Workspace settings — Scene Library page.** Mirror. Required.

Per-doc settings unchanged. The workspace data is opt-in via the editor's chip selection; no doc-level toggle needed.

## Observability (CLAUDE.md rule 14)

R-7 above. Two new namespaces + CRUD logs on endpoints. Cache-hit telemetry surfaces in the per-tick image-gen logs alongside the existing `char_cache_hits` / `scene_cache_hits` counters — extend the summary log to include `workspace_import_hits` once Commit 2 lands.

## Security (CLAUDE.md rule 13)

Same trust boundary as existing workspace data:
- Workspace-id resolved from the session; no client-supplied workspace-id parameter.
- All endpoints authed.
- SSRF-check `baseUrl` on POST / PUT.
- Slug + description bounded (slug ≤ 50 chars per `validateSlug`; description ≤ 500 chars).
- Rate-limit per session.
- Soft delete preserves audit trail (`archived_at` + `created_by`).

## Cost (CLAUDE.md rule 8)

**Storage:** trivial. ~10 KB per workspace character including base_url and metadata. A workspace with 100 characters is ~1 MB.

**Atlas Edit savings:** the main win. Every doc that imports a workspace character saves the first i2i call ($0.04). For a series channel with 20 docs and 3 recurring characters, that's 20 × 3 × $0.04 = $2.40 saved across the series — modest but compounds over time.

**API cost:** the new endpoints add latency to editor mount (one GET per workspace) but are read-light and cached. No external API calls.

**Cross-style risk:** if a workspace base is in doodle_explainer_2 style and a doc uses paint_explainer_v1, the dispatcher refuses the import (style mismatch) and falls back to fresh i2i. No silent miscompose.

## Open questions

1. **Per-channel scope.** Workspaces may contain multiple channels. Should a workspace character be visible to ALL channels in the workspace, or scoped to one? V1 = workspace-wide; revisit if it gets noisy.
2. **Character ownership & sharing.** Should one workspace's characters be exportable to another? Out of scope for V1; can build later as a CSV / JSON export.
3. **Description versioning.** If the user updates a workspace character's description, existing docs that already imported that description keep their snapshot. Should we offer a "re-import this character to get the latest description" button per row? Probably yes, as a Phase 5.1 polish.
4. **Auto-detect recurring characters across docs in the workspace.** Scan all docs in the workspace; find slugs that appear in ≥3 docs; offer a one-click promote-the-most-used-description bulk action. Nice quality-of-life feature; defer to Phase 5.1.
5. **Base image regeneration.** When the workspace base looks bad, the user re-generates it via the settings page. Should every doc that imported that base get automatically updated? V1 = no (preserves doc-level snapshots); offer an explicit "refresh this character from workspace" affordance per doc.
6. **Atlas Edit on a non-doodle base in a doodle doc.** Style mismatch handling — V1 just falls through to fresh i2i. A future round could attempt style-transfer via Atlas Edit but that's its own design problem.
7. **Workspace-level scene library.** Same shape, same UX, mirrored throughout this plan. Both ship together to avoid two rounds of editor work.

## Out of scope for this phase

- Cross-WORKSPACE character sharing (would require an "export / import" model).
- Channel-level character scoping (workspaces are the boundary today).
- Auto-clustering / suggesting characters from existing doc-level data.
- Vision-based character similarity matching (e.g. "this looks like your `george` — link them?").
- Multi-image Atlas Edit composition (Phase 2 Option 1 — still queued for smoke-test).
- Style-transfer between bases generated under different style_presets.

---

## Quick start for the next session

1. Read this plan.
2. Run the existing test sweep to confirm clean baseline: `npx vitest run --exclude=tests/atlas-images.test.ts --exclude=tests/voiceover-alignment-integration.test.ts`.
3. Start with Commit 1 (DB migration + library + endpoints). Use the in-memory SQL test harness to verify the library functions before wiring routes.
4. Smoke the API endpoints with a curl seed before moving to dispatcher integration.
5. Commit 2 (dispatcher) is the smallest of the three — once the lookup module + the doc-side cache copy logic are in place, the existing dispatch sites need maybe 30 LOC of changes each.
6. Commit 3 (UI) is the largest; lean on the existing `SlugChip` + `CharacterDescriptionsPanel` shapes and extend rather than rewrite.

The whole feature ships behind no flag — it's strictly additive. Docs that never import a workspace character behave exactly as before.
