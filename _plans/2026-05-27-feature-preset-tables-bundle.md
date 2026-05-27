# Feature-preset tables + pipeline preset as bundle

**Date**: 2026-05-27
**Branch**: `claude/video-creation-ui-pqXzS`

## Goals

Refactor the pipeline preset from a half-bundle / half-inline pile of
fields into a clean bundle of FK references to dedicated per-feature
preset tables. User asked for "full presets for each feature, save it
all as one big template for every auto pipeline" — this is that.

Today's state (3 of 8 features have real preset tables, 5 are inline):

| Feature | Today |
|---|---|
| Idea generation | inline (idea_context_jsonb) |
| Script writing | inline (script_rules_jsonb) |
| QA | inline (qa_min_score, qa_max_iterations) |
| Visual style | ✅ production_doc_styles |
| Thumbnail | ✅ thumbnail_template_presets |
| Narration | inline (narration_deadline_days) |
| SEO | ✅ prompt_templates |
| Model fallback | inline (fallback_chains_jsonb) — stays inline |

Adding 4 new preset tables (script, qa, narration, idea) and making
the pipeline preset a thin bundle of FKs.

## Constraints

- **Don't break running pipelines.** Existing in-flight `pipeline_runs`
  and `pipeline_run_videos` rows must keep working through and after the
  migration. The handler-side change reads from the bundle but falls
  back to inline columns until phase 2 drops them.
- **Don't lose user-entered data.** Migration backfills the existing
  inline data into new feature-preset rows; the inline columns are
  preserved for one release cycle as a rollback path.
- **Workspace-scoped at every read.** All new tables get
  `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`.
- Migrations auto-run on Vercel deploys (per AGENTS.md).
- No new paid-API costs.

## Requirements

For each new preset table:

- Workspace-scoped (FK + unique constraint on `workspace_id, name`)
- `id`, `name`, `description`, `created_by`, `created_at`, `updated_at`
- CRUD endpoints at `/api/auto-pipeline/{feature}-presets`
- Dedicated editor page at `/pipeline/presets/{feature}`
- Pipeline preset form picks one via a dropdown + "Edit" deep link

### `script_presets`
Fields extracted from today's `script_rules_jsonb`:
- `tone`, `style_note`, `audience`, `additional_context`,
  `reference_context`, `target_duration_minutes`,
  `script_style_preset_id` (→ production_doc_styles, moved off pipeline_preset),
  `constraints_jsonb` (preserved unknown fields)

### `qa_presets`
Fields extracted from today's columns:
- `min_score`, `max_iterations`,
  `pre_check_enabled` (`on` | `off` | `inherit`),
  `generator_v2_enabled` (`on` | `off` | `inherit`)

### `narration_presets`
Fields:
- `deadline_days`,
- `preferred_narrator_collaborator_id` (→ collaborators, NULL),
- `voice_settings_jsonb` (forward-compat for AI voiceover defaults)

### `idea_presets`
Fields extracted from today's `idea_context_jsonb`:
- `niche_default`, `ideas_count_default`,
- `focus` (`trending` | `evergreen` | `controversial` | `beginner` | `mixed`),
- `audience`, `video_type`, `reference_context`, `reddit_context`

### `pipeline_presets` additions
Four new nullable FK columns (`ON DELETE SET NULL`):
- `script_preset_id`, `qa_preset_id`, `narration_preset_id`, `idea_preset_id`

Existing inline columns stay during transition. Handlers prefer the FK
chain; fall back to inline when the FK is null.

## Chosen approach

### Phase 1 — this PR

1. **Migrations 0097-0100** — create the four new tables, add four FK
   columns on `pipeline_presets`, and run a backfill that creates one
   feature-preset row per existing pipeline preset (named
   `"{pipeline_preset.name} · script"` etc.) and links the FKs.
2. **Types** in `src/lib/auto-pipeline/types.ts` — extend
   `PipelinePreset` with optional nested objects:
   `script_preset?: ScriptPreset`, etc.
3. **DB layer** in `src/lib/auto-pipeline/db.ts` —
   `claimNextVideo`'s preset query JOINs the four new tables.
4. **Stage handlers** — each handler reads from the bundle, with
   inline-column fallback gated by an `if (preset.X_preset)` check.
5. **CRUD APIs** for each feature: list, create, read, update, delete.
   Same `apiRoute.authed` shape every other route uses.
6. **Pages** at `/pipeline/presets/{feature}` for each, mirroring
   the existing `/pipeline/presets` page.
7. **Pipeline preset form** — replace inline fields with dropdowns +
   "Manage presets" links. Inline form still works for legacy presets
   that haven't been migrated.
8. **Backfill verification** — a one-off test that diffs the
   pre-migration `script_rules_jsonb` against the post-migration
   `script_preset` row for each pipeline preset.

### Phase 2 — future PR

Once the new path has run cleanly for one release cycle:
- Drop the inline columns.
- Drop the fallback paths in handlers.
- Update the form to remove inline-edit UX.

## Alternatives rejected

1. **Monolithic JSON pipeline preset** (no separate per-feature tables):
   simpler data model, but loses reusability — every pipeline preset
   would carry its own copy of every setting. User picked the bundle
   approach.
2. **One-shot drop of inline columns in this PR**: too risky. Any
   migration bug rolls back to a state where the inline data isn't
   reachable. Two-phase is the safe play.
3. **Lazy-load each feature preset in its stage handler** (instead of
   eager JOIN in claimNextVideo): per-tick latency cost (4 extra
   round-trips per claim). The eager JOIN adds ~negligible work to a
   query that's already round-tripping.

## Security / safety

- Workspace-scoping enforced on every API route via `apiRoute.authed`.
- Cross-workspace IDs surface as 404, not 403 (Phase 8 pattern).
- All FK constraints set `ON DELETE SET NULL` so deleting a feature
  preset doesn't cascade-orphan pipeline_presets; the handler treats a
  null FK the same as a missing inline value.
- Backfill runs in a transaction per pipeline preset row; if it fails
  mid-row, that pipeline preset is left at its original inline state
  and an error is logged.
- No PII added to any new logs. Stage handlers log preset IDs (UUIDs)
  on read, not free text.

## Open questions

None — the user's two answers (full scope in one PR, FK bundle model)
settle the high-level design. Open sub-questions surface during
implementation; I'll ask before guessing.

## Verification plan

After implementation:

1. **Migrations apply cleanly** — `npm run db:status` shows 0097-0100
   applied. Backfill log records one new row per pipeline preset per
   feature.
2. **Existing pipeline runs survive** — open `/pipeline/[runId]` for a
   pre-migration run; it should still show every stage and let the user
   retry / re-run as before.
3. **New presets surface in the form** — `/pipeline/presets` shows
   dropdowns for each new feature, populated with the backfilled rows.
4. **Stage handlers prefer the bundle** — start a new batch; spend log
   `featureArea` calls flow through the new resolver path.
5. **Inline fallback still works** — null out one feature_preset_id on
   a pipeline preset; the handler should fall back to the inline column
   for that feature without erroring.
6. **Unit tests** — backfill mapping function gets full coverage.
   Stage-handler tests for the "FK present" + "FK null, fall back to
   inline" branches.
