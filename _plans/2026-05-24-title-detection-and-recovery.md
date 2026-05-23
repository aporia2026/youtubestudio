# Title Detection & Recovery

**Date:** 2026-05-24
**Status:** in progress

## Problem

A user-submitted script contains six `##Title` section markers. The production-doc generator (an LLM call) inconsistently detects them — `##Wana Decrypt0r 2.0` produces a Title Card row, but `##TrickBot` is silently dropped, along with other later headings.

Two failures stacked on top of each other:

1. **Chunk-boundary suppression rule.** `src/lib/prompts.ts:2225` explicitly instructs the LLM: *"Opening row: First B-Roll/Animation scene (no Title Card — continuation chunk)"* when `isChunk` is true. If a heading lands at the start of a continuation chunk, the Title Card is dropped on purpose.
2. **LLM non-determinism on non-standard markdown.** `##NoSpace` is not standard markdown. The LLM was instructed to detect it (with a worked example at `src/lib/prompts.ts:2126`), but its detection across a long script is unreliable.

## Goals

1. Deterministic title detection: every `##` heading in the script produces exactly one Title Card row, no matter the chunk it falls in or the LLM's mood that day.
2. UX affordances so the user can (a) mark titles in the script without remembering syntax, and (b) recover from a missed title in an already-generated production doc.
3. Telemetry from day one: logs that surface what the regex caught, what the LLM emitted, and the diff between them, so future regressions are visible immediately.

## Constraints

- Backward compatibility with existing scripts that use `##Heading` (with or without space).
- No new third-party services or costs.
- Plain `<textarea>` editor — no rich-text editor migration in scope here.
- Must work both for in-app generated scripts and pasted external scripts.

## Chosen approach

Two-phase plan. Phase 1 fixes the bug deterministically and ships with observability. Phase 2 adds the UX features the user explicitly asked for, with the safety affordances surfaced by the council (confirm, undo, hover-preview, disabled-when-no-selection).

### Phase 1 — deterministic backend fix

1. **Regression fixture.** `tests/script-titles.test.ts` includes the user's exact 6-title script. Locks behavior before code lands.
2. **`src/lib/script-titles.ts`.** Exports `extractScriptTitles(script)` returning `{ stripped, titles, warnings }`.
   - Regex `/^##(?!#)\s*(.+?)\s*$/` — line-anchored, rejects `###`/`####`, accepts both `##Title` and `## Title`.
   - Skips lines inside ` ``` ` fenced code blocks.
   - Replaces each detected heading line with a sentinel token `<<TITLE_N>>` in the stripped script.
   - Cap: 50 titles per script, 200 chars per title; titles beyond the cap are left as plain text and a warning is returned.
3. **Server-side, per-chunk extraction.** The route extracts titles from the *chunk* it receives, not from the full script. The client-side chunker is untouched. This makes per-chunk title scoping automatic and resolves the per-chunk leakage risk the council flagged.
4. **`productionDocPrompt()`** accepts a new `titles` arg. The old prose heading-extraction section is removed entirely (no double-truth). New instructions tell the LLM: every `<<TITLE_N>>` marker in the script MUST produce one Title Card row; the sentinel itself never appears in any row's `script_text`; do not invent extra title cards.
5. **Delete the `isChunk` suppression rule** at `src/lib/prompts.ts:2225`. With sentinels, chunks are self-describing.
6. **Post-validator** in the route compares the count and texts of extracted titles vs emitted Title Card rows. Mismatches are logged and surfaced as `generation_warnings` to the client. Also detects sentinel-leakage (a `script_text` field containing `<<TITLE_`).
7. **Telemetry**:
   - `[production-doc title-extract]` — input script chars, stripped chars, title count, title texts, isChunk flag.
   - `[production-doc title-emit]` — expected count, emitted count, missing titles, extra titles, leaked sentinels.

### Phase 2 — UX features

8. **"Mark as title" button** next to the existing ElevenLabs copy buttons on the production-doc page.
   - Disabled when there's no selection in the textarea (Outsider's catch). Tooltip: "Select the title text first."
   - On click, snap selection to its surrounding line boundaries (Contrarian's catch — no `wo## rd` corruption), then wrap as `\n## ${snapped}\n`. If the line is already a title (`##` prefix), strip the marker instead — toggle behavior.
   - Logs `[production-doc mark-as-title]` with line length and whether it was a toggle-on or toggle-off.
9. **"Make this a title card" (Promote) row action** in `SectionRowControls.tsx`.
   - Confirmation dialog: "Replace the image prompt and visual fields? The current values will be backed up to row notes so you can paste them back."
   - On confirm: mutates `visual_type = "Title Card"`, `ai_image_prompt = ""`, `on_screen_text = script_text`, `stock_search_terms = ""`, and appends the prior `ai_image_prompt` to `notes` as `[backup-from-promote] ...` so the user can recover by hand.
   - Logs `[production-doc row-promote]`.
10. **"Split row" action**.
    - Modal showing `script_text` with a hover-preview split indicator: a vertical line between any two words on hover, plus a tiny preview reading `Title: "<text before>"` / `Stays as <visual_type>: "<text after>"`.
    - On click, inserts a new Title Card row above the current row with the "before" text; the current row keeps the "after" text and its original visual_type.
    - Logs `[production-doc row-split]` with the split position and resulting row lengths.

## Alternatives considered and rejected

- **Switching marker syntax to `[[TITLE: ...]]`** — would still leave LLM detection in the critical path. Doesn't fix the root cause and breaks existing scripts.
- **Char-offset position encoding** — char offsets drift on any subsequent edit. Sentinel tokens survive transformations.
- **Auto-repair missing Title Cards by inserting them at LLM-inferred positions** — too clever, too error-prone. Surface as warnings and let the Phase 2 split/promote tools handle recovery.
- **Generalized "structural editor" with full AST and round-trip sync** (council's Expansionist proposal) — the right north star but premature scope. Parked in ROADMAP.

## Followups parked in ROADMAP

- Audit other prompt rules that ask the LLM to do deterministic parsing (row segmentation, sentence boundaries). First Principles thinker's bigger point — worth a dedicated pass.
- Regenerate idempotency: protect hand-edited `ai_image_prompt` values across regenerations.
- Generalized row operations (merge, reorder, duplicate, demote) — once Promote+Split prove themselves.

## Security / safety

- Title length capped at 200 chars; total titles capped at 50, to prevent prompt-bloat amplification from malicious input.
- Sentinel tokens are server-generated, never user-supplied. The extractor strips any pre-existing `<<TITLE_N>>` substring from the input before processing to prevent injection.
- Post-validator catches the case where the LLM leaks sentinel syntax into a row's `script_text` (which would otherwise reach the renderer).
- No new attack surface beyond what already exists (script content already reaches the LLM).

## Observability

Phase 1 logs are listed above. Every row action in Phase 2 logs its own namespaced line with the operation and the resulting state diff. Sufficient for the user to grep `[production-doc` and see exactly what happened in any session.

## Settings audit

No new settings. Title detection is strictly better as automatic. The "Mark as title" button and the row actions are UI affordances, not toggleable behaviors.

## QA checklist

- [ ] User's exact 6-title script produces 6 Title Card rows (regression fixture passes).
- [ ] `## Title` (with space) detected.
- [ ] `##Title` (no space) detected.
- [ ] `### Title` (h3) NOT detected.
- [ ] `## ` inside a ` ``` ` fenced code block NOT detected.
- [ ] Title at the very start of the script detected.
- [ ] Title at a chunk boundary detected (regression for the original bug).
- [ ] Title with trailing whitespace detected, whitespace stripped.
- [ ] Title length > 200 chars truncated/warned.
- [ ] 51st title not promoted to Title Card; warning surfaced.
- [ ] Pre-existing `<<TITLE_N>>` substring in user script stripped before processing.
- [ ] Post-validator catches LLM dropping a Title Card row → warning surfaced.
- [ ] Post-validator catches LLM hallucinating a 7th Title Card → warning surfaced.
- [ ] Phase 2: Mark-as-title disabled with no selection.
- [ ] Phase 2: Mark-as-title snaps to line boundaries (no mid-word corruption).
- [ ] Phase 2: Promote shows confirm; original `ai_image_prompt` backed up to notes.
- [ ] Phase 2: Split shows hover-preview; click splits correctly; resulting rows preserve original visual_type for the "after" half.
