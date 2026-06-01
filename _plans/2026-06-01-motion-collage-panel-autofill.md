# Motion-collage panel auto-fill

Date: 2026-06-01
Branch: claude/video-creation-ui-pqXzS
Status: approved, implementing

## Problem

On the production-doc page (`doodle_explainer_2` style), the "↯ Convert to
motion collage" button seeds a 2x2 grid with four **empty** panel prompts and
wipes the row's `ai_image_prompt`. The user is then expected to hand-type every
keyframe description (4, 6, 9, up to 16 of them). If they generate without
filling them, `generateMotionCollage` rejects the row with
`validation_failed:panel_prompt_empty` (the "⚠ Failed" state in the bug report).

There is no auto-generation anywhere. The design assumed the main doc-generation
LLM would emit `motion_collage_panel_prompts` itself (the style guide in
`production-doc-styles.ts` has detailed instructions for that), but the manual
"Convert" button and the editor's grid picker got none of that intelligence. So
as a manual action the feature is effectively useless.

Root cause: `src/app/(app)/production-doc/page.tsx` ~L11112-11125 (convert
handler seeds `['','','','']`).

## Goal

When the user converts a row to motion collage, auto-generate the N keyframe
panel prompts from the row's existing content (`script_text` +
`visual_description` + `ai_image_prompt`), following the same same-scene /
only-the-moving-element-advances contract the style guide defines. Keep manual
editing fully intact (never remove options — see memory `feedback_never-remove-options`).

## Decisions (confirmed with user)

- **Trigger**: auto-fill instantly on "Convert" click (brief spinner) PLUS an
  "✨ Auto-fill panels" button in the editor for re-roll / refill.
- **Grid change**: keep existing panels, auto-fill only the newly-added empty
  cells. Never overwrite a panel the user already wrote.

## Approach

LLM decomposition step using the model the `production-doc` feature already
resolves to (default `gpt-5.4-mini`). One call ~2K in + ~500 out ≈ **$0.002**.
Negligible (rule 8). Pricing tagged "verify on openai.com" in `ai-models.ts`;
confirm live before merge.

### New files

1. `src/lib/motion-collage-panel-fill.ts` (pure, testable)
   - `buildPanelFillPrompt(args)` → `{ system, user, expected }`. System prompt
     distills the same-scene contract + per-panel rules (short 80-150 chars,
     subject-first, "Same scene", sparse doodle) from `production-doc-styles.ts`.
     User prompt carries the beat content, grid (N), character bible, and any
     existing panels with indices so the model paces new frames between kept ones.
   - `parsePanelFillResponse(raw, expected)` → `string[]` of length `expected`
     (reuses `parseLlmJson`; coerces, trims, pads/truncates).

2. `src/app/api/generate/production-doc/motion-collage/panels/route.ts`
   - `apiRoute.authed`, rate-limited (mirrors the sibling `motion-collage` and
     `detect-titles` routes). Body: `{ grid, scriptText, visualDescription?,
     baseImagePrompt?, existingPanels?, stylePreset?, characterDescriptions? }`.
   - Resolves model via `getEffectiveModelId(session.ws, 'production-doc')`,
     style suffix via `resolveStyle(stylePreset, session.ws, session.uid)`.
   - Requires at least one non-empty content field (400 otherwise).
   - Calls `generateText` (spend-logged), parses, returns `{ panelPrompts }`.
   - `maxDuration = 60`.

### Edits

3. `src/components/production-doc/MotionCollageRowEditor.tsx`
   - Add props `onAutoFill: () => void` and `autoFilling?: boolean`.
   - Add "✨ Auto-fill panels" button (disabled + spinner while autoFilling).
     Tooltip: fills empty panels; clear a panel to regenerate it (non-destructive).
   - `onChange` gains a `reason: 'grid' | 'prompt'` discriminator so the parent
     can distinguish grid taps from text edits.

4. `src/app/(app)/production-doc/page.tsx`
   - State: `autoFillingRows: Set<number>`.
   - `autoFillMotionCollagePanels(rowIndex, payload)` — race-free (caller passes
     grid + content + existingPanels explicitly, no stale doc reads). Merges
     response: keep existing non-empty, fill blanks. Clears `image_url` +
     `motion_collage_*url` so the next gen re-runs. Toasts on error.
   - Convert handler: capture content from `row` BEFORE clearing, seed empty
     grid, then call auto-fill with the captured content (all-empty existing →
     fills all 4).
   - Editor wire-up: `onAutoFill` reads the current row; grid-change branch in
     `onChange` (reason === 'grid', expanded, has content + has blanks) triggers
     blank-fill using the onChange payload directly.

### Tests

5. `tests/motion-collage-panel-fill.test.ts` — unit-test `parsePanelFillResponse`
   (code-fence, bare array, padding/truncation, junk → throws) and
   `buildPanelFillPrompt` (expected count, existing-panel injection, suffix).

## Alternatives rejected

- **Explicit button only** (no auto on convert): more clicks, fails the lazy-user
  bar (rule 10). Rejected.
- **Generate at image-gen time as a fallback** (fill empties inside
  `generateMotionCollage`): hides the prompts until after a paid image run; the
  editor still shows blank boxes; no chance to review/edit. Rejected.
- **Regenerate-all on grid change**: overwrites manual edits. User chose
  keep-existing. Rejected.

## Security / safety

- New route is `apiRoute.authed` (same auth as siblings), rate-limited per IP.
- No new secrets, no PII logged (log counts + grid only, like sibling routes).
- LLM output is plain text written into panel-prompt strings the existing
  pipeline already validates (length cap, non-empty) before any paid call —
  no new injection surface beyond what the manual textareas already allow.

## Edge cases / QA checklist

- Convert with empty narration → route 400, page toasts "add narration/visual
  description first", panels stay empty (manual entry still works).
- Grid expand 2x2 → 3x2 with 4 filled: keeps 4, fills 2 new.
- Grid shrink: truncates, no LLM call.
- Rapid grid toggling: in-flight guard drops overlaps; explicit button recovers
  the final grid if a tap was dropped (documented minor limitation).
- Auto-fill failure: toast, panels unchanged, editor usable.
- LLM returns wrong count / junk: parser coerces to N or throws → toast.
- Revert to regular row still clears all motion_collage_* fields.
