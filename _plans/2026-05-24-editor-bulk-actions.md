# Editor Bulk Actions — v1 Plan

**Date**: 2026-05-24
**Status**: Approved — user signed off on scope after LLM Council pressure-test
**Branch**: TBD (off `fix/render-broll-stuck` or main, depending on merge state)

## Goals

- Let the user apply a single setting to every shot in a project with one click.
- Cover the highest-frequency repetitive operations first.
- Don't introduce silent surprises. One click = one logical change.
- A single Ctrl+Z (or Undo click) reverts an entire bulk action.

## Constraints

- No new API endpoints. Reuse the existing atomic PATCH endpoint at `src/app/api/edit/[projectId]/route.ts`.
- No new multi-select infrastructure. (Considered and deferred — see "Alternatives rejected".)
- Must coexist with the 3-worker Fill-blank-shots pool race-free.
- Header is already crowded with model + defaults selectors. v1 adds at most one new top-level control.

## Requirements

### v1 actions

Six actions. Each touches exactly one field.

1. **Apply section title layout** — `section_title_layout`: overlay / letterbox
2. **Apply on-screen text mode** — `on_screen_text_mode`: bake / overlay / none
3. **Apply clip fit mode** — `clip_fit_mode`: stretch / freeze-last / loop / trim-scene
4. **Apply cross-fade transition** — `transition_in`: on / off
5. **Apply mute** — `muted`: mute all / unmute all
6. **Apply background-removal** — `image_rmbg_applied`: use cutout / use original

### Override semantics

For each action that has a doc-default field: write the per-row value on every shot AND update the doc-default. For per-row-only fields (mute, etc.): set on every shot.

This is the heavier write path. The cleaner long-term answer (tri-state `inherit | explicit`) is documented in the v2 design section below and deferred to a future iteration.

### UI

- Single button labeled **"Apply to all shots"** in the editor header dropdown area (next to the model / doc-defaults controls).
- Click opens a menu listing the six actions.
- Selecting an action expands it inline into a small form:
  - Field-specific picker (radio buttons or toggle)
  - Diff summary line: "N will change, M already match"
  - Apply button labeled with the count: "Apply to 23 shots"
- After apply: success toast with a visible **Undo** button (5s timeout) plus a count. Ctrl+Z also reverts.

### Copy rules (per project standing rules)

No em dashes. No AI-tells. Plain language over jargon:

- Section title layout values: "Overlay (text floats over the video)" and "Letterbox (text in a black bar above/below)". Avoid raw `overlay` / `letterbox` strings in UI copy.
- On-screen text mode values: "Burned into image" (bake), "Live overlay" (overlay), "Hidden" (none).
- Clip fit mode values: "Stretch", "Hold last frame", "Loop", "Trim scene".
- Background-removal: "Use cutout (background removed)" vs "Use original".
- Cross-fade: "Cross-fade transition into shot — on/off".
- Mute: "Mute audio" vs "Unmute audio".

### Confirmation

No modal. Count in the button label + visible Undo button in the toast is the safety contract.

### Undo

Implemented as a **transaction wrapper** in the editor store, not a new `BULK_PATCH_ROWS` command:

- New `beginTransaction()` / `commitTransaction()` API in the store
- All `applyMutation` calls within the transaction land as a single undo entry
- Auto-save fires once at commit, not per-row
- Existing `PATCH_ROW` and doc-default mutations compose without changes
- Future bulk-style operations (multi-select, presets) reuse the same primitive

### Race guard

Bulk apply is **blocked** while the Fill-blank-shots worker pool is active. The button is disabled with a tooltip ("Wait for image fill to finish"). Resolves the race where a bulk write during in-flight image gen would clobber freshly-written `image_url` values via the atomic doc PATCH.

### Empty doc

Button disabled with a tooltip ("Add shots first") when the project has zero shots.

## Approach

### New files

- `src/components/editor/bulk/BulkActionsButton.tsx` — top-bar button + dropdown menu trigger
- `src/components/editor/bulk/BulkActionsMenu.tsx` — list of actions, manages which action is expanded
- `src/components/editor/bulk/forms/*.tsx` — one tiny form per action (`BulkSectionTitleLayoutForm`, `BulkOnScreenTextModeForm`, `BulkClipFitModeForm`, `BulkTransitionInForm`, `BulkMuteForm`, `BulkBackgroundRemovalForm`)
- `src/components/editor/bulk/BulkApplyToast.tsx` — success toast with visible Undo button

### Store changes

- Add `beginTransaction()` / `commitTransaction()` to `src/lib/editor/store.ts`
- Inside a transaction, mutations accumulate; the undo system records the transaction's start state as one entry
- The Fill-blank pool exposes an `isActive` selector the bulk button reads

### Integration point

- `src/app/(app)/edit/[projectId]/EditorClient.tsx` mounts `<BulkActionsButton />` in the existing header next to the doc-defaults / model selectors

## Alternatives rejected

- **Multi-select infrastructure** (Expansionist): shift-click range, "select matching" filter, named presets. Right long-term direction. Deferred — out of scope for "add a bulk option."
- **Tri-state inherit data model** (First Principles): the data-model fix that makes bulk trivial. See v2 design section. Not in v1.
- **Bundled "Set layout" action** that sets both section_title_layout and on_screen_text_mode in one click. Rejected: silently mutates a field the user didn't pick.
- **Modal confirmation**: rejected as friction. Count-in-button + visible Undo covers the safety bar.
- **New `BULK_PATCH_ROWS` store command**: rejected in favor of transaction wrapper. Reuses existing commands, smaller test surface.
- **Embed bulk affordances inside the doc-defaults panel** (Executor): cleaner architecturally but the user explicitly chose a discoverable header entry point. Documented as candidate refactor if the header gets unmanageable.
- **Drop clip-fit and bg-removal to v1.1** (Executor's cut): user picked all four extras. Six total actions is still tight enough to ship.

## Security / safety (per rule 13)

- No new API surface. The single PATCH endpoint already validates row shape — bulk just produces a doc with more rows mutated, the existing schema validation catches malformed values.
- Race with Fill-blank pool: explicit guard, bulk disabled while pool is active. Error toast if the user somehow triggers it during a brief overlap.
- Failure recovery: bulk goes through normal auto-save. Existing 409 / version-conflict handling applies unchanged.
- No new auth boundaries. Editor already requires an authenticated session.
- **Server-side bulk-shape audit**: deferred. Server validates each row; an atomic PATCH that mutates N rows isn't structurally different from N normal saves stacked together. If we later see malformed bulk payloads in logs, add explicit size/diff caps on the server.

## Observability (per rule 14)

Namespaced `[editor bulk]` logs on every step. All log lines include the absolute values, not just "X happened".

- `console.info('[editor bulk] menu opened')` — when the user opens the dropdown
- `console.info('[editor bulk] action selected', { action })` — when they pick one
- `console.info('[editor bulk] preview computed', { action, willChange, alreadyMatch, totalShots, value })` — when the diff line renders
- `console.info('[editor bulk] applied', { action, count, params, durationMs })` — on apply
- `console.info('[editor bulk] blocked', { reason })` — `reason` ∈ `'fill_pool_active' | 'no_shots'`
- `console.info('[editor bulk] undone', { action, count, via })` — `via` ∈ `'toast_button' | 'keyboard_shortcut'`
- Server: `logger.info('editor patch bulk', { rowsTouched, fields })` on the PATCH receipt when the row-diff count exceeds a heuristic threshold (suggests a bulk apply landed)

## Settings audit (per rule 15)

Candidates considered for v1:

- **"Confirm before bulk actions that change >N shots"** — deferred to v1.1. Default v1 behavior: no confirmation. The visible Undo button + count-in-button satisfies the safety bar.
- **"Bulk actions also update the doc-default"** toggle — explicitly NOT exposed. Predictable semantics matter more than configurability here; the doc-default-write is part of the contract.
- **Keyboard shortcut for the bulk menu** — deferred. Discoverability matters more than power-user speed for v1.

No new settings in v1. Candidates documented above for the v1.1 audit.

## Telemetry placeholder

Log usage so v1.1 can be informed by which actions matter most rather than guesses. The `[editor bulk] applied` log line already captures action + count + params. A future iteration can aggregate.

## Open questions

None remaining. Plan is locked.

---

# v2 Design — Tri-state inherit / explicit per-field

**Status**: Documented per Hybrid choice from the planning conversation. **Not in v1 scope.**

The LLM Council's First Principles advisor (and the peer reviewers unanimously) flagged the underlying data model as the root cause that bulk-actions is treating as a symptom. Capturing the design here so it isn't lost.

## Motivation

Today, `ProductionRow.section_title_layout` is `'overlay' | 'letterbox'`. The doc has `section_title_layout_default` with the same shape. When a row's value equals the default, the system can't tell whether the user explicitly chose that value or it was inherited at row creation.

Consequence: changing the doc-default doesn't update rows that already have a matching explicit value — they look "fine" but were set independently and won't follow future default changes. That's why this bulk-actions feature has to do "write per-row + update default" instead of just "update default".

## Proposal

For each field that has a doc-default:

- Per-row type becomes `'overlay' | 'letterbox' | 'inherit'`
- New rows initialize with `inherit`
- The render layer resolves: `row.field === 'inherit' ? doc.field_default : row.field`
- The inspector UI shows "Inheriting: letterbox" with a small "set explicitly" affordance. Reverting an override returns the row to `inherit`.

## Bulk becomes trivial

With `inherit`, the bulk action collapses to:

- "Apply [field] to all shots" = "set doc-default + reset all explicit overrides to `inherit`"
- One field write (the default) + N tiny `inherit` writes (which compress in the diff)
- Single undo entry naturally
- No write amplification — most rows just say `inherit`
- Future "select N shots, change X" composes naturally — selection sets explicit on the chosen rows

## Migration

- One-time migration script: for each existing row, if `row.field === doc.field_default`, write `row.field = 'inherit'`.
- Heuristic, not proof — values that coincidentally equal the default get treated as inherit. Acceptable risk for layout / text-mode / clip-fit (small option space, defaults are intentional). Higher risk for free-form fields (not in v2 scope).
- Run via the existing `scripts/migrate.ts up` mechanism that the build script already calls (per `AGENTS.md`).
- Dry-run mode: log the count of rows that would change per project before applying.

## Open questions for v2

- Audit existing docs before running the migration? A dry-run summary + spot-check before applying is cheap insurance.
- Fields without a doc-default today (e.g., `pillarbox_color`)? Either add a doc-default first or leave them per-row only (and exempt from the tri-state model).
- Backward compatibility: do older clients reading newer docs treat `inherit` as invalid? Need a deploy plan if so.

## When to revisit

- After 2–4 weeks of v1 usage data
- Sooner if v1 surfaces real user friction around "I changed the default but some shots didn't follow"
