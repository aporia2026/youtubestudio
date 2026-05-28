# Doodle Explainer 2 — Variant Count Precision (Bug 2)

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** In flight as the deferred Bug 2 follow-up from Phase 1.6.
**Predecessor:** `_plans/2026-05-28-doodle-2-phase-1-6-completion.md` (Bug 2 deferred there with note: "Atlas Edit's count-instability under 'remove the extra X' language. Not a Phase 1.5 regression — pre-existing Atlas Edit behavior. Fixes belong in a separate 'variant prompt precision' pass.").

---

## Why this exists

QA on Sodder doc `b30b8d1e`: base showed 7 figures (George + Jennie + 5 children), variant showed only 5. The LLM-emitted variant_edit_prompt was:

> *"Keep the front-door escape scene the same, but remove the extra two children so only George, Jennie, and four"*

The model interpreted "remove the extra two" as license to thin the crowd more aggressively than asked. Atlas Edit's count compliance is variable; subtraction-style instructions amplify the variance.

Phase 1.6 deferred this with the note that it's an Atlas Edit limitation, not a Phase 1.5 regression. Now that the cache + bible + chain mode + scene cache + editor UI work is in, this is the only remaining major visible quality issue.

## Goal

Variant Edit calls produce the exact figure count the user intended — no thinning crowds, no inserting extra figures — across the full range of count-bearing variant prompts.

## Constraints

- No new vendor surface. Same Atlas Edit dispatch.
- LLM-side fix preferred (preventative). Server-side hint as the safety net (always-on regardless of LLM cooperation).
- Existing variant prompts on already-saved docs continue to render with the current behavior; this work changes the FUTURE LLM emissions and the preservation hint that wraps every Edit dispatch.

## Approach

Two-prong fix:

### R-1 — LLM teaching for count-precise variant prompts

The LLM is the source of the subtraction-style pattern. Teach it via doodle_explainer_2 mixing_rules + the JSON schema example to write count-precise PRESERVATION-style prompts:

**WRONG (subtraction form, what the LLM emits today):**
> "remove the extra two children so only George, Jennie, and four are left"

**RIGHT (preservation form):**
> "Keep exactly George + Jennie + 4 children visible (6 figures total). Do not remove or add any other figures."

The preservation form states the TARGET state directly. Atlas Edit can reason about "show exactly 6 figures" more reliably than "remove 2 from however many are there."

Files:
- `src/lib/production-doc-styles.ts` — VARIANT GROUPS section in doodle_explainer_2 mixing_rules gains a "COUNT-PRECISE VARIANTS" subsection with the canonical wrong / right pattern + a worked Sodder example.
- `src/lib/prompts.ts` — the variant_edit_prompt description in the JSON schema notes the preservation-form requirement when figure count is involved.

### R-2 — Preservation hint extension

The variant dispatcher today appends a short hint after every variant_edit_prompt via `getVariantPreservationHint`. The doodle_explainer_2 hint currently reads:

> *"Apply only the change above. Composition, positions, proportions, and line style must stay exactly identical to the input image — nothing else changes."*

Composition / positions / proportions / line style — but NOT figure count. Atlas reads this as "I can change the people count freely" and the QA failure mode confirms this.

Extend the hint to call out figure count explicitly:

> *"Apply only the change above. Composition, positions, proportions, line style, AND the number of figures, people, and characters in the scene must stay exactly identical to the input image — except when the change above EXPLICITLY asks to add or remove a specific person. Do not silently thin crowds or add bystanders."*

Files:
- `src/lib/production-doc-flags.ts` — extend the doodle_explainer_2 entry in `VARIANT_PRESERVATION_HINTS`. The default hint (used by other styles) stays unchanged for now; if other styles report similar issues we extend them in their own rounds.

### Why not regex-rewrite "remove N" patterns server-side?

Considered, rejected. Detecting "remove N" reliably requires parsing the prompt for numerals + noun + intent — brittle. False positives (rewriting a sentence that mentions "remove" in a different context) cause new failures. False negatives (missing variants on synonyms like "five fewer", "less than six") leave the original bug uncovered. The LLM teaching + preservation hint approach addresses the bug at both ends of the prompt without any parsing risk.

## Requirements

### R-3 — Verification

The Sodder-style count failure must not reproduce after this fix on a fresh regeneration. Specifically:

- A variant_edit_prompt mentioning a target count ("only 4 children") should render with that exact count.
- A variant_edit_prompt with NO count change ("change his expression to surprised") should preserve the base's figure count exactly.
- The hint extension is always-on for doodle_explainer_2; it shouldn't break any non-count variants.

### R-4 — Tests

- Unit-test `getVariantPreservationHint('doodle_explainer_2')` includes the figure-count language.
- The mixing_rules change is plain text; no targeted test (verified end-to-end by regeneration).

## Phased delivery

Single commit:

1. Mixing_rules COUNT-PRECISE VARIANTS subsection (R-1).
2. JSON schema variant_edit_prompt description tightening (R-1).
3. Preservation hint extension for doodle_explainer_2 (R-2).
4. Unit test on the updated hint (R-4).

Effort: ~1 hour. ~50 LOC + ~30 LOC tests.

## Observability (CLAUDE.md rule 14)

No new log lines needed. The existing `[production-doc variants]` + auto-pipeline image-gen logs already surface variant counts and prompts. A figure-count drift would surface visually; a behavioral telemetry would require vision-based comparison which is out of scope.

## Security (CLAUDE.md rule 13)

N/A. Pure prompt-engineering. No new user input paths.

## Cost (CLAUDE.md rule 8)

Zero. Hint extension adds ~80 chars to every variant Edit prompt — well within Atlas's input budget; pricing is per-call.

## Open questions

1. **Preservation-form compliance.** The LLM teaching is preventative. If LLM compliance is incomplete (e.g. the LLM still occasionally writes "remove N" patterns), the hint catches it at dispatch time. Verified by the next QA pass.
2. **Other styles.** The default preservation hint stays unchanged. paint_explainer_v1 docs have not reported count drift yet; if they do, mirror this fix there.
