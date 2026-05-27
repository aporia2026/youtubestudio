# Collage default ON + per-cell augmentation parity

**Date:** 2026-05-26
**Status:** approved, ready to execute
**Related plans:**
- `_plans/2026-05-24-system-upscale-and-collage.md` (introduced collage mode and the per-quadrant slicing)
- `_plans/2026-05-25-atlas-cloud-gpt-image-2.md` (Atlas branch of the collage route)

## Problem

The user reports seeing 4 individual Recraft upscale calls in the Kie log for a single bulk image-generation in production-doc. The root cause is not the collage path (which correctly upscales once on the composed image before slicing) — it's that `collage_mode` defaults to OFF, so bulk-gen runs 4 single-shot calls, each of which independently calls `pollKieResultThenUpscale`. That's 4 generations + 4 upscales for what should be 1 generation + 1 upscale (~75% cost overrun on bulk gen).

Cause for the default-off historically: the collage route deliberately skips the OST/safe-top/section-title per-cell augmentation that `/api/generate/production-doc/image` applies. The route comment ([collage/route.ts:46-51](../src/app/api/generate/production-doc/collage/route.ts#L46-L51)) makes the caller responsible for augmentation, but no caller has been doing that. So flipping the default without porting the augmentation would regress OST baking and safe-top scene composition on bulk gen.

## Goal

1. Make `collage_mode` default to ON for production-doc and editor bulk-gen.
2. Port per-cell augmentation into the collage route so behavior matches single-shot at the cell level. No quality regression on OST baking, safe-top scene composition, or sheet-description continuity.
3. Preserve per-shot Regenerate as single-shot (unchanged).
4. Preserve all existing fallback paths (malformed-after-retry → 4 single-shots; mixed-model / i2i / <4 shots → singles).

## Constraints

- t2i-only on the collage path. i2i / styleId / refs continue to flow through the single-shot route as today.
- No new cloud cost surface. Existing Recraft upscale is the only paid call; collage net reduces total upscale spend (~75% saving on bulk gen). Verified pricing in [_plans/2026-05-24-system-upscale-and-collage.md](2026-05-24-system-upscale-and-collage.md).
- No data migration. Treat `collage_mode === undefined` as ON; store `false` explicitly when the user turns it off.
- Behavior-preserving refactor for the single-shot route: extracting `augmentCellPrompt` into a shared helper must produce byte-identical augmented prompts to the current inline block. Tests assert this.

## Approach (Option C from chat)

Flip the default to ON, AND port the per-cell augmentation into the collage path so behavior matches single-shot exactly. Single source of truth via a new `src/lib/prompt-augmentation.ts` module that both the single-shot route and the collage route import.

### Alternatives rejected

- **Option A — flip default only, accept augmentation regression.** Cheapest, but regresses OST baking on bulk gen. User-visible quality drop for the sake of saving ~75% cost — wrong trade.
- **Option B — flip default only for new docs.** Doesn't fix existing docs without manual toggling. Punts the win.
- **Move augmentation to the client.** Duplicates logic; harder to sanitize untrusted input; asymmetric with single-shot route. Worse posture.

## Surfaces changed

1. **`src/lib/prompt-augmentation.ts`** (new) — exports `augmentCellPrompt({ prompt, onScreenText, onScreenTextMode, sectionTitle, sectionTitleLayout, styleSheetDescription, promptCap })`. Returns the augmented string + a `truncated` flag for logging. Constants `SINGLE_SHOT_PROMPT_CAP = 2000`, `COLLAGE_CELL_PROMPT_CAP = 600`. Same sanitization (newline strip, length cap, quote escape) as today's inline block.
2. **`tests/prompt-augmentation.test.ts`** (new) — covers: bake produces leading + trailing OST; overlay produces neither; safe-top fires only with sectionTitle + overlay layout; sheet-desc tail; body truncation respects budget; sanitization strips newlines and caps length.
3. **`src/app/api/generate/production-doc/image/route.ts`** — replace the inline augmentation block (lines 109-188) with a single call to `augmentCellPrompt`. Behavior-preserving. Log line stays the same.
4. **`src/lib/collage-prompt.ts`** — keep `composeCollagePrompt` signature, but document that cells are now expected to be already-augmented. Template stays simple.
5. **`src/app/api/generate/production-doc/collage/route.ts`** — accept a new `cells: Array<{ prompt, onScreenText?, onScreenTextMode?, sectionTitle?, sectionTitleLayout?, styleSheetDescription? }>` shape alongside the legacy `prompts: string[]`. Apply `augmentCellPrompt` per cell, then compose. Backwards-compatible: when only `prompts` arrives, fall through to no-augmentation behavior (matches today). Log per-cell augmentation state.
6. **`src/app/(app)/production-doc/page.tsx`**:
   - Default check: `doc?.collage_mode !== false` (was `=== true`).
   - Toggle UI: `checked={doc.collage_mode !== false}`. On uncheck: `next.collage_mode = false`. On check: `delete next.collage_mode`.
   - Help text: remove the "Limitations: no per-cell on-screen-text baking" line — no longer accurate. Update the wider help paragraph to note collage is now default-on.
   - Collage call body: send `cells` array with per-row `onScreenText` / `onScreenTextMode` / `sectionTitle` / `sectionTitleLayout` / `styleSheetDescription` from each `item`.
7. **`src/app/(app)/edit/[projectId]/EditorClient.tsx`**:
   - Default check at line 703: `=== true` → `!== false`.
   - Collage call body: send `cells` with `onScreenText` / `sectionTitle` per row (matching today's single-shot editor call surface — mode/layout default server-side, same as today).
8. **`ROADMAP.md`** — entry under image-gen / collage.

## Out of scope

- The collage `composeCollagePrompt` already-augmented input changes only — no template rework, no new prompt language.
- No per-cell canvas sizing for cloud paths (Kie/Atlas ignore canvas dims; local ComfyUI is excluded from collage).
- No changes to malformed-detection, fallback flow, slicer, saliency.
- No changes to `src/lib/auto-pipeline/image-gen.ts` (cron path uses single-shot per-shot, out of scope for this task).
- No changes to per-shot Regenerate (stays single-shot).

## Budget math (per-cell cap)

Today: 400 chars per cell, hard. Composed = template (~250) + 4 × 400 = ~1850 chars total.

With augmentation:
- Safe-top directive: ~190 chars when present
- OST leading directive: ~120 chars when baked
- OST trailing directive: ~30 chars when baked
- Sheet description: ~280 chars when present
- Per-cell worst-case overhead: ~620 chars when all fire (rare)

New per-cell cap after augmentation: **600 chars**. `augmentCellPrompt` truncates the user-supplied prompt body if the augmented result exceeds the cap — same truncation pattern as the single-shot route's existing logic. Worst-case composed total: ~2650 chars. Well within Kie request body limits.

## Default-flip semantics

Treat `collage_mode === undefined` as ON. The toggle stores `false` explicitly when off (instead of `delete`). Net result:

- Existing docs with no `collage_mode` field → collage runs by default.
- Existing docs with `collage_mode: true` → unchanged behavior.
- Existing docs with `collage_mode: false` → wouldn't exist (today the off state stores `undefined`), so no docs land here today. After this change, anyone who turns it off via the toggle writes `false` and stays off.

No data migration. No code that reads `collage_mode` checks for `false` specifically — only `=== true` and the new `!== false`.

## Security / safety

- All per-cell user-controlled strings (OST, sectionTitle, sheet-desc) are sanitized in `augmentCellPrompt`: newline strip, length cap, quote escape. Same posture as today's single-shot route.
- No new attack surface. Same request validation pattern (per-cell length cap, type checks) on the collage route as today.
- No new secrets, no new env vars.

## Observability (rule 14)

- **`augmentCellPrompt`** returns `{ prompt, truncated, fixedOverhead }`. Callers log a `[prompt-augmentation truncated]` line when truncated.
- **Collage route** logs per-cell augmentation state in `[collage generate] cells composed` before kicking off the model call: array of `{ index, ost_baked, safe_top, sheet_desc, truncated, augmented_len }`.
- **Single-shot route** keeps its existing `[prodoc image-gen prompt-truncated]` log line for parity; behavior unchanged.

## Settings (rule 15)

The existing `collage_mode` toggle in production-doc settings stays — users can still override the new default. UI changes:

- Toggle label stays: "Generate 4 shots at once (collage mode)".
- Help-text removes "Limitations: no per-cell on-screen-text baking" (no longer true).
- Help-text gains a one-line "Default: ON" note so users know what they're opting out of.
- Toggle defaults visually to checked for any doc without an explicit `false`.

No new settings added.

## Test plan

**Unit (`tests/prompt-augmentation.test.ts`, new):**
- bake mode → leading + trailing OST present
- overlay mode → no OST directives
- none mode → no OST directives
- safe-top fires only when sectionTitle non-empty AND layout === 'overlay'
- safe-top suppressed when layout === 'letterbox'
- sheet description appended at tail when non-empty
- newline-stripping and length-capping for OST and sheet-desc
- body truncation when augmented prompt would exceed cap
- byte-identical output to today's inline block for representative inputs (parity test)

**Unit (`tests/collage-route-augmentation.test.ts`, new or extension of existing):**
- legacy `prompts: string[]` body still works (no augmentation, current behavior)
- new `cells: [...]` body applies augmentation per cell before composing
- truncation log fires when a cell exceeds the per-cell cap
- existing tests for malformed-detection / fallback flow stay green

**Manual QA (rule 6, golden path + edge cases):**
- Default ON: open a fresh production doc, hit "Generate all missing stills" on 8 empty rows → confirm 2 Kie collage calls + 2 upscale calls in logs (was: 8 generations + 8 upscales).
- Default override: turn toggle off in settings → confirm 8 single-shot calls happen as before.
- Per-cell OST: set 2 of 4 rows in a collage group to `bake` with text → confirm the baked rows show the text in the rendered image and the other 2 don't.
- Per-cell section title overlay: set `sectionTitle` + `overlay` layout on 1 of 4 rows → confirm that row's composition leaves the upper area open.
- Per-shot Regenerate: hit Regenerate on a single shot → confirm it still goes through single-shot route (one generation + one upscale).
- Mixed-model group: change one row's model in a collage group → confirm that group falls back to 4 singles (existing eligibility filter).
- i2i / styleId row inside a collage group → confirm singles fallback (existing filter).
- Trailing <4 shots: 7 empty rows → 1 collage group of 4 + 3 single shots. Confirm cost = 1 + 3 = 4 upscales.
- Editor fill-blanks: same golden-path verification on the editor side.

## Sequencing

1. Write this plan file.
2. Extract `augmentCellPrompt` into `src/lib/prompt-augmentation.ts` with unit tests.
3. Refactor `src/app/api/generate/production-doc/image/route.ts` to use the helper. Verify parity test stays green.
4. Update `src/app/api/generate/production-doc/collage/route.ts` to accept `cells` and apply the helper per cell.
5. Add tests for the collage route's new behavior.
6. Update `src/app/(app)/production-doc/page.tsx`: flip default, invert toggle storage, send `cells`, fix help text.
7. Update `src/app/(app)/edit/[projectId]/EditorClient.tsx`: flip default, send `cells`.
8. Run lint + typecheck + the affected test suites.
9. Manual QA pass per the plan above.
10. Update `ROADMAP.md`.

## Open questions

None — user confirmed the editor metadata fidelity (only `onScreenText` + `sectionTitle` from the editor, defaults applied server-side) and that the toggle stays in the UI.
