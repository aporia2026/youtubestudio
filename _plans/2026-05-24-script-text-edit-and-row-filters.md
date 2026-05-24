# Script-text editing + column filters in the production-doc table

**Date:** 2026-05-24
**Status:** in progress

## Problem

In the production-doc table, the user can edit `visual_type`, `ai_image_prompt`, `on_screen_text`, `section_title`, and a bunch of section/zoom controls — but `script_text` itself is read-only. There's also no way to filter the rows; on a 184-shot project, scrolling to find every "Title Card" row or every "Statistics" row is friction.

## Goals

1. The user can edit any row's `script_text` inline, with the same affordance the AI Prompt cell already has (click ✎, type, Save / Cmd-Enter / Escape).
2. The user can filter the table by:
   - **Visual type** — multi-select pill toggles for each visual type in the doc (e.g. show only Title Card + B-Roll).
   - **Free-text search** — case-insensitive substring match across `script_text`, `visual_description`, `on_screen_text`. So you can type "TrickBot" and only see rows that mention it.
3. Filters apply to both desktop table and mobile cards. Filtered-out rows render nothing (no `display: none` ghost rows in the DOM) but row numbers stay tied to their original doc-index so every action keeps working.

## Out of scope (parked)

- Auto-recomputing timecodes when `script_text` length changes. The downstream timecode is wall-clock from the doc start, so editing the wording without touching timing means narration drift if the change is large. That's a separate, opinionated feature (one button: "Recompute timecodes from script"), worth doing later but not bundled here.
- URL-persisted filters. Local state for now; promote to URL params if it becomes a workflow.
- Column-header filter UI (Excel-style dropdowns in each column). One global filter bar above the table is cleaner for now; per-column dropdowns can come later if the user finds themselves combining many filters.

## Approach

### Editing `script_text`

Mirror the AI Prompt pattern exactly:
- New state next to `editingPromptRow`: `editingScriptRow: { rowIndex; draft } | null`.
- In the script_text cell, add a small ✎ button next to the text. Click → cell shows a textarea autofocused, with Save / Cancel / hint "⌘/Ctrl+Enter to save".
- On save → `updateRow(i, { script_text: draft })`. On Escape or Cancel → discard.
- Log `[production-doc script-edit]` with `{ rowIndex, charsBefore, charsAfter }`.

### Filters

- New state: `filters: { visualTypes: string[]; search: string }`. Empty arrays/strings = no filter applied for that field.
- Filter bar component above the table:
  - **Search input** with a leading magnifier icon, placeholder "Search script, visual, on-screen…".
  - **Visual-type pills** — one pill per distinct `visual_type` present in the doc. Active = highlighted; click toggles. Count badge on each pill ("Title Card · 6").
  - **Clear filters** button (only shown when any filter active).
  - **Result counter** "Showing N of M rows" inline.
- Apply via a memoized `isRowVisible(row): boolean`. When no filter is set, returns true for everything (zero overhead).
- In the row `.map`, render `null` for rows where `isRowVisible(row) === false`. Index `i` stays the doc index so `updateRow(i, …)` and every existing handler stays correct.
- Mobile cards get the same filter bar (above the cards). Same filter state — desktop and mobile share.

### Observability

- `[production-doc filter-change]` log with the new filter state on every change.
- `[production-doc script-edit]` log on every script_text save.

### Settings audit

No new persistent settings. Filters reset between sessions intentionally — they're a working-session tool, not a configured default.

### Security/safety

- `script_text` is user-controlled text already; editing inline doesn't change the threat model.
- Filter search is client-side substring matching — no SQL injection surface.

## QA checklist

- [ ] Click ✎ on script_text → textarea opens with current text.
- [ ] Cmd/Ctrl+Enter saves; Escape cancels.
- [ ] Save commits via `updateRow` and survives reload.
- [ ] Mobile script_text cell gets the same edit affordance.
- [ ] Visual-type pills show counts; clicking toggles inclusion.
- [ ] Search filters across all three text fields.
- [ ] When filtered, row numbers shown are the original doc indices (not 1..N of the filtered list).
- [ ] "Clear filters" wipes filters and shows all rows again.
- [ ] No filters = identical render to pre-change (no perf regression).
