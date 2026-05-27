# Move the production-doc style suffix from LLM output to server-side post-parse

**Date:** 2026-05-26
**Owner:** Yoav + Claude
**Status:** In progress

## Goal

Stop having the LLM retype the full style suffix (up to 377 words for `doodle_explainer_2`) into every row's `ai_image_prompt`. Instead, have the LLM emit only the 35–55 word scene body and append the suffix server-side in the API route after `parseLlmJson`. The persisted production-doc row shape stays identical, so zero downstream consumers change.

## Why

Three prior fixes (chunk size 700 → 450 → 300, then per-row word caps in the prompt) all failed. The model still truncated at roughly the same JSON position on long scripts. Root cause confirmed: doodle_explainer_2's `ai_image_suffix` is 377 words ≈ ~500 output tokens. Per row the LLM produces ~500 (suffix) + ~70 (scene body) + ~30 (other fields) ≈ ~600 tokens. With 22 rows in a 300-word chunk that's ~13k pure output tokens before reasoning tokens — GPT-5.4 Mini's 16k cap busts mid-stream. Word-cap instructions in the prompt do not actually bound output tokens at the model level.

The suffix's only real consumer is the image generator (Replicate / Kie), via `buildBrollPrompt` in `src/lib/broll.ts`. Storing the same 377-word string on every row was structurally wasteful from the start — the truncation just exposed it.

## Approach (Option X — post-parse server-side concatenation)

The persisted `production_doc.rows[].ai_image_prompt` keeps its current shape (scene body + suffix). What changes is **who writes the suffix**: the API route does it now, not the LLM. This means:

- LLM prompt: ask for scene body only (35–55 words). Drop the "MUST end with the style suffix verbatim" rule. Keep the MANDATORY IMAGE STYLE block so the model writes scene bodies that *fit* the aesthetic, but stop demanding the suffix string literally.
- API route (`src/app/api/generate/production-doc/route.ts`): after `parseLlmJson` + `validateAndSplitOverlongRows`, if `style?.ai_image_suffix` is non-empty, walk every row and append `" ${suffix}"` to non-empty `ai_image_prompt` values.
- Idempotency guard: skip rows whose `ai_image_prompt` already ends with the suffix (handles partial-compliance LLMs and retries).
- Persisted shape: unchanged. All ~17 downstream consumers (`broll.ts`, editor regenerate routes, otio export, BrollCell, InlinePromptEditor, google-sheets export, etc.) continue to read `ai_image_prompt` and see exactly what they see today.

### Alternatives considered, rejected

- **Option Y (consumer-side concat):** Strip suffix from `ai_image_prompt`, pass it as `styleHint` to `buildBrollPrompt`. Cleaner architecture but invasive: 17 consumer paths, every legacy doc in the DB would render with no style on the next regen, and we'd need a fallback/migration. Wrong tradeoff for the timeline.
- **Switch model to Sonnet 4.6:** Solves truncation in 5 min but costs ~$3-4× more per doc and leaves the structural waste in place. Doesn't fix the underlying issue.
- **Smaller chunks (150 words):** Belt and suspenders, but at ~600 tokens/row even a 150-word chunk has ~10 rows ≈ 6k tokens. Next verbose style breaks it again. Not solving the root cause.

## Files to change

1. `src/lib/prompts.ts` — `productionDocPrompt`:
   - Strip "Every non-empty ai_image_prompt MUST end with this exact suffix (copy verbatim, do not rephrase)" from the MANDATORY IMAGE STYLE block; replace with a one-liner saying the style is enforced automatically downstream.
   - `ai_image_prompt` field description: remove the "then append the mandatory style suffix verbatim" instruction.
   - OUTPUT FORMAT example: drop `${styleSuffix ?? ''}` from the sample row.
   - ABSOLUTE RULES: drop "Every ai_image_prompt MUST end with the style suffix".
   - Replace the `≥ 40 words` rule with `35–55 words for the scene body`.

2. `src/app/api/generate/production-doc/route.ts`:
   - Right after the title-card validator and before the response is shaped, add a new pass `attachStyleSuffix(result.rows, style?.ai_image_suffix)` that mutates non-empty `ai_image_prompt` values in place (skip Title Card / Talking Head / Screen Recording where the field is "").
   - Log row count + suffix length + chars appended.

3. `tests/prompts-user-direction.test.ts` and any other prompt-shape tests — check none break. Confirm by running `npm test`.

## Observability

- Single new log: `console.info('[production-doc suffix-attach]', { rowCount, attachedCount, suffixWords, suffixChars })` after the pass runs. Lets us confirm post-deploy that LLM output is no longer carrying the suffix.

## Security

No new attack surface. The suffix is a static, workspace-configured string read from the same source as today (`style.ai_image_suffix`). It is appended to a server-controlled prompt, never echoed to a user-controllable surface that didn't already render it.

## Settings

No new settings. Existing style picker continues to control which suffix is appended.

## QA plan

1. `npm test` — must pass clean (especially `tests/script-titles-heuristic.test.ts` and any production-doc prompt tests).
2. `npx tsc --noEmit` — must pass clean.
3. Manual: run the same 1211-word Dyatlov/Wow!/Mary Celeste script with `doodle_explainer_2` + GPT-5.4 Mini on `/production-doc`. Expect no truncation; expect every row's `ai_image_prompt` to still end with the doodle suffix in the saved doc.
4. Spot-check: open one row's "Edit AI image prompt" in the editor — confirm the suffix is present in the displayed text (not just in the eventual broll prompt).
5. Spot-check: trigger a broll generation on one row — confirm the prompt sent to Kie/Replicate matches today's behavior (suffix included).
6. Token math check via logs after the run: `[production-doc suffix-attach]` should show `attachedCount` matching non-empty-prompt rows.

## Risk

Low. Persisted shape unchanged. If the LLM ever ignores the new instruction and writes the suffix anyway, the idempotency guard avoids double-suffixing. Worst case: the LLM produces no suffix and the post-pass adds it — that's the intended path.

## Token math after fix

Per row: scene body ~70 tokens + visual_description ~28 tokens + other JSON fields ~30 tokens ≈ ~130 tokens. 22 rows = ~2900 output tokens, well under GPT-5.4 Mini's 16k cap with comfortable headroom for reasoning tokens. ~5× reduction vs. today.
