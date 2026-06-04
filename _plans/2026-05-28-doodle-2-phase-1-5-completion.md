# Doodle Explainer 2 — Phase 1.5 (completion of the Phase 1 character cache)

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** Awaiting approval before execution.
**Predecessor:** `_plans/2026-05-28-doodle-2-character-cache.md` (Phase 1, shipped in commit `46f4031` at 09:37 UTC today).

---

## Why this exists

Phase 1 shipped the server-side cache (Atlas Edit on a stored base, fall-through to i2i, full telemetry) and the mixing_rules prose telling the LLM to emit `character_id`. The Atlas Edit smoke test confirmed the mechanics work in isolation.

QA on the Sodder Children doc `b59e88ad-a0c4-4497-8493-ad0a1e13e8ad` (run 09:45 UTC, immediately after the Phase 1 deploy) revealed three independent bugs that meant Phase 1 produced ~zero behavioural change end-to-end:

- **Bug A:** the LLM did not emit `character_id` on any of the 22 rows. The cache code path never fired.
- **Bug B:** the auto-grouper failed to group consecutive rows with **identical** `ai_image_prompt` strings (8 duplicate pairs in the Sodder doc — rows 0+1, 3+4, 5+6, 10+11, 13+14, 15+16, 17+18, 18+19). The LLM is *intentionally* emitting identical prompts for the doodle_explainer_2 "near-static animation" style: the same i2i image should render across the combined narration duration with Remotion layering slight motion (pan/zoom/character-bobble) on top — no image-to-video, no Atlas Edit drift. The auto-grouper currently treats "no delta between base and variant" as "can't group" instead of "this IS the variant — reuse the base verbatim." Result: each duplicate runs through a fresh i2i and the two outputs drift apart (George in suit vs no suit, two different houses).
- **Bug C:** baked on-screen-text like the year "1945" lands near the top edge of the i2i output and gets sliced by the dispatcher's 7.8% top center-crop.

Phase 1.5 closes these three bugs as a single PR. No new architecture; all changes are surgical and bounded.

## Goals

1. Phase 1 cache mechanism actually fires on real docs — `character_id` reliably emitted by the LLM and surfaced through to the stage handler.
2. Consecutive rows with identical or near-identical `ai_image_prompt` share a single i2i base instead of running two independent generations.
3. Baked on-screen text stays inside the visible safe area after the dispatcher's center-crop.

## Constraints

- No new vendor dependencies, no new tables, no migrations.
- No change to the existing variant-dispatch contract — the existing editor behavior for groups must keep working unchanged.
- User owns model defaults (memory rule) — no model-id changes anywhere.
- Phase 3 (scene cache) and Phase 4 (editor UI for character_id) stay deferred per the original plan. House drift across non-consecutive rows is acknowledged as out of scope for this PR.

## Requirements

### R-A — Add `character_id` to the LLM JSON schema example

**File:** [src/lib/prompts.ts:2320-2374](src/lib/prompts.ts#L2320-L2374)

**The bug:** the schema example currently lists 8 (or 11 when overlays are on) core fields, and the `ABSOLUTE RULES` block reads "Every row has all 8/11 core fields (variant fields are OPTIONAL …)." `character_id` is described only in the mixing_rules prose ([src/lib/production-doc-styles.ts:508-534](src/lib/production-doc-styles.ts#L508-L534)) and never echoed in the structural schema example. LLMs anchor strongly on structural examples; prose-only optional fields routinely get dropped.

**Fix:** mirror the existing `### OPTIONAL — variant-group fields` block. Add a new block right after it:

```
### OPTIONAL — character-continuity field

When the chosen style's mixing_rules ABOVE define recurring named
characters (e.g. doodle_explainer_2), add this ONE optional field
to every row that features a recurring character. Omit it on rows
without a recurring character (one-off / anonymous / no-people).

{
  "...": "all core fields above",
  "character_id": "george"
}

  - `character_id` — a short lowercase-with-dashes slug naming the
    character. The SAME slug appears on EVERY row showing that
    character, including variant rows inside a group_id. This is
    what lets the server reuse the same base image across rows.
```

**Plus:** update the ABSOLUTE RULES line to read "Every row has all ${allowOverlay ? '11' : '8'} core fields (variant fields and `character_id` are OPTIONAL — they're additive, never replace core fields)."

**Plus:** add a single line in the mixing_rules CHARACTERS section linking back to the schema:

```
- The output JSON schema below treats `character_id` as an optional
  per-row field. Emit it as `"character_id": "<slug>"` on every
  qualifying row. Omit the key entirely on non-qualifying rows.
```

### R-B — Auto-grouper handles identical-prompt pairs via synthesized motion delta

**File:** [src/lib/auto-group-variants.ts](src/lib/auto-group-variants.ts)

**The bug:** `extractDelta(base, variant, minDeltaWords)` returns `null` when prompts are byte-for-byte identical (zero suffix delta, zero novel words). The main `while` loop's `if (!delta) break;` then bails, so identical pairs stay ungrouped. The Sodder doc has 8 such pairs out of 22 rows.

**Why dedup-to-base is wrong:** the doodle_explainer_2 "near-static animation" style is delivered via **Atlas Edit producing sibling frames from a shared base** — not by reusing one frozen image across multiple narration beats. When the LLM emits identical prompts, the intent is "same scene, slight motion variation between frames" — exactly the case Atlas Edit was designed for. Reusing the base image_url verbatim would freeze the frame and break the animation feel.

**Fix:** when `basePrompt === variantPrompt` (both trimmed), `extractDelta` returns a fixed-default subtle-motion delta string — not `null`, not `""`. The constant:

```ts
const DEFAULT_SUBTLE_MOTION_DELTA =
  'keep composition, character identity, clothing, lighting, and scene layout exactly identical to the base; apply only a small natural variation — a subtle shift in pose, expression, or limb position consistent with the same moment.';
```

The main loop then promotes the row into the group with `variant_edit_prompt = DEFAULT_SUBTLE_MOTION_DELTA`. The existing dispatcher runs Atlas Edit on the base with this delta → produces a sibling frame at $0.011, identity stays anchored to the base, motion is incidental and natural.

**Sibling-only, by design.** Phase 1.5 deliberately stays with the current base-anchored dispatch: every variant references the base image, no variant references its predecessor. Progressive motion arcs (V3 continues V2) are NOT enabled here. See **Follow-up phase: chained variants** at the bottom of this plan for that work.

**Telemetry addition:** extend the `[production-doc auto-group-variants]` log to count `identicalPromptMergesWithDefaultDelta` separately from regular `mergedRowCount`. The QA tool surfaces this metric so we can verify the fix on the next Sodder run.

**Tests:** unit-test `autoGroupVariants` with three new fixtures:

1. Two identical full prompts → 1 group, 1 merged row, identicalPromptMerges = 1, variant_edit_prompt === DEFAULT_SUBTLE_MOTION_DELTA.
2. Three identical full prompts in a row → 1 group, 2 merged rows, both variants get the default delta.
3. Two identical prompts followed by a third unrelated prompt → 1 group of 2, the third row stays standalone.

### R-C — Bake-OST positioning forbids the top edge

**File:** [src/lib/prompt-augmentation.ts:147-178](src/lib/prompt-augmentation.ts#L147-L178)

**The bug:** `ostPosition` resolves to `"within the scene"` when no section stripe is present. With no positional anchor, image models default the baked OST to the top of the frame as a "title graphic." The dispatcher's 1536×1024 → 1536×864 center-crop then removes 80px (7.8%) off the top. Year-shaped OST values ("1945", "1969") trigger this most reliably because they cue the model toward title placement.

**Fix:** strengthen both directives so the model has explicit edge-avoidance language at every OST mention. Three small changes:

1. Replace `ostPosition = 'within the scene'` with:
   ```
   'in the lower-center portion of the frame, well inside the visible safe area, NEVER near the top edge'
   ```
2. Tighten `ostLeadingDirective` to say:
   ```
   `Hand-lettered text "${escapedOst}" drawn large in bold marker style ${ostPosition}, in the illustration's own style. The text must sit with AT LEAST 15% empty margin from the top edge of the canvas.\n\n`
   ```
   (15% not 10% — the OST bake specifically; the rest of the scene still uses the 10% directive.)
3. Append an explicit anti-top-edge clause to `safeEdgeDirective` when an OST is being baked:
   ```
   `Any hand-lettered text, title, or numeral inside the picture sits AT LEAST 15% inside from the top edge — never touching it.\n\n`
   ```

**Verify** the fix on the Sodder doc by re-running just rows with OST = year values ("1945", "1969", "5 MISSING", "THREAT") and visually inspecting the top crop.

**Optional follow-up (NOT in this PR):** add an OST mode `'overlay-with-safe-area'` that suppresses the bake and instead renders the text via Remotion's `LowerThird` with explicit safe-area padding. Today the global default is `'bake'`. Logging the chosen mode per row would let us audit which mode is hitting which content.

## Phased delivery

Single PR. Three commits, in this order so each is reviewable in isolation:

1. **Commit 1 — Bug A (schema fix).** Smallest change, no behavioural risk; once shipped, the LLM starts emitting `character_id` and the existing Phase 1 server code starts firing. Verify via the existing `[production-doc character-ids]` log on the first post-fix doc.
2. **Commit 2 — Bug B (auto-grouper identical-prompt path).** Pure server-side; unit-tested in isolation. Net cost direction: down (fewer fresh i2i calls).
3. **Commit 3 — Bug C (OST positioning).** Prompt-augmentation change; affects every doc using OST bake, not just doodle_explainer_2. Slightly broader blast radius but the change is additive (stricter constraints, no removed behavior).

**Effort estimate:** ~3 hours total. ~80 LOC + ~60 LOC tests.

## QA after the PR

Regenerate the Sodder Children doc end-to-end and verify all three checks pass before declaring Phase 1.5 done:

1. The `[production-doc character-ids]` log shows `hasAnyReusable: true` and the doc has at least one `character_id` shared across ≥2 rows (likely `george`).
2. The `[doodle-2 character-cache]` log shows ≥1 `hit-and-edit` (Atlas Edit was reused).
3. The auto-grouper log shows `identicalPromptMerges > 0` if the LLM produced duplicate prompts, OR `0` if the LLM stopped producing duplicates (both are acceptable outcomes — the first proves the safety net works, the second proves the schema fix made it unnecessary).
4. Visually: rows 0+1 (house) render the same house. Rows 3+4 (family fleeing) render the same George. The "1945" OST is fully inside the frame, no top crop.

If all four pass, Phase 1.5 ships and we revisit "Phase 2 (multi-character composition) vs Phase 3 (scene cache)" with the data from a doc where Phase 1 is actually firing.

## Settings audit (CLAUDE.md rule 15)

None of the three fixes warrant a new user-visible setting:

- A — schema correction. Always-on, no knob.
- B — identical-prompt dedup is strictly an improvement. Could expose a `dedupConsecutiveIdenticalPrompts` toggle if a future use case wants two adjacent renders to deliberately differ, but no such use case exists today and the current behavior (random drift) is not what any user actually wants.
- C — universal anti-top-edge OST positioning. Same reasoning: every user wants OST inside the safe area. If we add the `'overlay-with-safe-area'` mode later, that becomes a setting; for this PR, the bake path's default positioning is just corrected.

## Observability (CLAUDE.md rule 14)

- A — the existing `[production-doc character-ids]` log gates the success metric ( `hasAnyReusable: true`). No new log needed.
- B — extend the existing `[production-doc auto-group-variants]` log with `identicalPromptMerges` field. One additional integer, no extra log line.
- C — add `[prompt-augmentation ost-bake]` log with `{ rowIndex, ost, position, hadStripe }` so we can audit which positioning string was active for each row.

## Security (CLAUDE.md rule 13)

N/A. No new external systems, no new user input paths. The OST sanitiser (120-char cap + newline strip + quote escape) is already in place and unchanged by R-C.

## Cost (CLAUDE.md rule 8)

- A — zero cost impact.
- B — **savings.** Every duplicate-prompt pair previously cost 2 × $0.04 = $0.08 in i2i. After the fix, 1 × $0.04 + 1 × $0 (reuse) = $0.04. On the Sodder doc with three duplicate pairs (rows 0+1, 3+4, 5+6) that's $0.12 saved per regeneration. Scales linearly with how often the LLM duplicates.
- C — zero cost impact (prompt text gets ~120 chars longer; well within budget; the augmenter's `promptCap` already accounts for fixed overhead).

## Follow-up phase: chained variants with LLM-controlled mix (NOT in Phase 1.5)

Approved by user on 2026-05-28 as the next phase after Phase 1.5 ships and QA's clean. Captured here so it doesn't get lost.

**The gap Phase 1.5 leaves open.** Today's variant dispatcher is sibling-only: every variant references the BASE image, never its predecessor. That works for "same scene, slight variation" (siblings), but breaks for "progressive motion across N frames" (V1 starts to raise arm, V2 arm halfway, V3 arm fully up — V3 needs to see V2). On the base-anchored path V3 is computed against the base in isolation, with no memory of V2's pose, so the three frames jitter instead of forming a motion arc.

**The fix (later phase, not Phase 1.5).**

1. Add a group-level field on `ProductionDoc` rows: `chain_variants?: boolean`. Default false (siblings — preserves current behavior). When true, V_n is Atlas-Edited from V_n-1's image instead of from the base.

2. When chaining is on, inject an explicit identity anchor into every chained Edit prompt: *"keep the character's face, hair, clothing, and overall identity EXACTLY identical to the ORIGINAL base — only the pose/motion/expression progresses from the previous frame."* This dampens the drift compounding that naive chaining would cause (~5%/step → ~14% by V3 without the anchor).

3. **LLM-controlled mix.** Teach the LLM to set `chain_variants` per group based on the script's beat:
   - One static moment narrated across multiple beats ("George went to bed thinking his family was safe") → `chain_variants: false` (siblings; tiny incidental variation).
   - Genuine progression in the narration ("the door cracked open, then swung wide, then slammed shut") → `chain_variants: true` (chained; real motion arc).
   The LLM gets the choice on a per-group basis. Mixing both kinds in one doc is fine.

4. **Editor UI.** Add a per-group toggle so the user can override the LLM's choice. Default visible state is "auto (from LLM)" → checked/unchecked per group accordingly.

5. **Cost.** Chained vs sibling has the same Atlas Edit cost per variant ($0.011/call) — the difference is which image gets passed as input, not the number of calls. No cost regression.

**Open questions for the chained-variants plan (to address in that plan, not this one):**
- How to retry/repair a chained group when one mid-chain Edit fails — does the rest of the chain block, or do we fall back to base-anchored for the remainder?
- Whether the identity anchor should reference the base via the prompt only, or also by passing the base image as a second `images[]` input to Atlas Edit (if the endpoint supports multi-image Edits).
- How the LLM signal "this is a motion arc" is distinguished from "siblings with slight variation" reliably — needs concrete script examples in the mixing_rules.

Plan file when scoped: `_plans/2026-05-28-doodle-2-chained-variants.md` (TBD after Phase 1.5 QA).

## Open questions

1. **Bug A vs Bug B prevention overlap** — if Bug B's server-side auto-grouping catches the duplicate-prompt failure mode independently, does Bug A's schema fix still earn its keep? Yes: `character_id` is what enables continuity across NON-consecutive rows (George in row 0 vs row 18). Auto-grouper only helps adjacent pairs. Both fixes target different problems.
2. **Atlas Edit identity preservation under fixed-default delta.** The default delta says "subtle variation" without naming what should move. Atlas Edit's behavior under that vague delta hasn't been measured at scale — needs to be verified in the post-Phase-1.5 QA pass. If outputs are too static (no visible variation) or too drifty (face/clothing change), the delta wording needs tuning. Track outcomes per group in the auto-grouper telemetry.
