# 2026-06-04 — Pipeline-preset pacing profile

## Problem

The auto-pipeline production-doc handler at
[generate-production-doc.ts:138](src/lib/auto-pipeline/stages/generate-production-doc.ts#L138)
hardcodes `pacingProfile: 'fast'`. The page-level fix in
`_plans/2026-06-03-title-card-deterministic-repair.md` exposed pacing
in the manual UI, but pipeline-triggered runs still always use 'fast'
regardless of what the preset would imply.

Users who configured a preset for slow documentary-style content cannot
get that pace on auto-pipeline runs without manually intervening on
every video.

## Goals

- Pipeline presets carry a `pacing_profile` field the auto-pipeline
  reads at production-doc generation time.
- Null in DB ⇒ falls back to 'fast' (preserves current behavior for
  existing presets; matches the manual route's whitelist default).
- Preset editor exposes a picker mirroring the page's `PacingProfilePanel`.
- POST / PATCH preset routes accept and validate the field.

## Constraints

- Migration is additive (nullable column, no default — every existing
  preset reads as "no opinion → fall back to 'fast'").
- Whitelist values: `'standard' | 'fast' | 'very_fast'` — a `CHECK`
  constraint blocks any other string from landing on the row.
- No schema break for presets that don't carry the field on POST/PATCH.

## Approach

### 1. Migration 0116

`ALTER TABLE pipeline_presets ADD COLUMN pacing_profile TEXT` with a
`CHECK` constraint pinning the value to the three allowed strings or
`NULL`. Down migration drops the column cleanly.

### 2. Type + DB plumbing

- Add `pacing_profile: 'standard' | 'fast' | 'very_fast' | null` to
  `PipelinePreset` in `auto-pipeline/types.ts`.
- Add the column to both SELECTs in `auto-pipeline/db.ts`
  (`claimNextVideo` + `getPresetForWorkspace`).

### 3. Auto-pipeline handler

Read `preset.pacing_profile ?? 'fast'` and thread it through
`productionDocPrompt({ pacingProfile })` (currently `'fast'`) and
`applyPacingPostProcess({ pacing_profile })` (currently `'fast'`).

### 4. Preset routes (`/api/auto-pipeline/presets[…]`)

- POST: validate `pacing_profile` via the new shared helper, INSERT.
- PATCH: same validation, conditional UPDATE.
- GET: include the column in the response.

### 5. PresetForm.tsx

Add a pacing picker right next to `narrationDeadlineDays` in the
form's "production-doc setup" cluster. Reuse the existing
`PacingProfilePanel` component (already on the page) so the visual
language matches across surfaces. Default to the panel's `undefined`
state for new presets so the DB stays NULL until the user picks.

### 6. Shared validation helper

Extract a `parsePacingProfile(raw: unknown): 'standard'|'fast'|'very_fast'|null`
into a small new module so:
- the route's POST/PATCH validation,
- the manual `/api/generate/production-doc` route's body whitelist,
- the auto-pipeline handler's fallback,

all share the same parsing rule. One unit test covers all three
callers.

## Security

- No new external input enters the system — the field is one of three
  whitelisted strings or NULL.
- `CHECK` constraint enforces the whitelist at the DB level too;
  defense in depth against a future code path that bypasses the
  parser.

## Observability

The auto-pipeline already logs `[pacing post-process]` with diagnostics
on every doc. Add the chosen pacing_profile (NOT just the post-process
metrics) so a log reader can correlate "this preset emitted 'standard'
docs" with the preset's configured pace. One log field, zero new lines.

## Settings

Settings audit (per CLAUDE.md rule 15):

- New control: per-preset pacing pick in the PresetForm.
- Default: undefined → server falls back to 'fast'. User must
  consciously click a different pill to deviate.
- Why no other knobs: the three discrete profiles are the documented
  contract from the manual route's panel. Numerical per-row-second
  ranges are derived from the profile inside `productionDocPrompt`;
  exposing them separately would let the two sources of truth drift.

## Testing (vitest)

- `tests/pacing-profile-parse.test.ts` — every input/output pair for
  the parser: `'standard'`, `'fast'`, `'very_fast'`, `''`, `null`,
  `undefined`, `'FAST'`, `42`, `{}`, `'fast '` (trailing whitespace).
- Existing test suites (`tests/auto-pipeline*.test.ts`,
  `tests/post-process-pacing.test.ts`) keep passing — no behavior
  change for null-pacing presets.

## Out of scope

- Per-video override (mirror of `production_doc_style_override_id`).
  Add when a user reports needing it; meanwhile the preset is the
  single dial.
- Backfilling a value onto existing presets. NULL is a valid state
  meaning "no explicit pick" — leave them alone, the fallback handles
  it.
