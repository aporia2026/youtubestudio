# Doodle Explainer 2 — Chained Variants with LLM-Decided Mix

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** Draft — DO NOT EXECUTE until Phase 1.5 QA is clean (verify the 4 success checks in `_plans/2026-05-28-doodle-2-phase-1-5-completion.md`).
**Predecessor:** `_plans/2026-05-28-doodle-2-phase-1-5-completion.md` (Phase 1.5, in flight at draft time).

---

## Why this exists

Phase 1.5 closes the sibling-only animation path: identical-prompt rows get grouped, each variant runs Atlas Edit against the BASE image with a synthesized subtle-motion delta, the result is a sibling frame with slight variation (pose, expression, limb shift). This produces a "near-static animation" feel — frames feel hand-redrawn rather than CSS-tweened, identity stays anchored to the base.

What sibling-only does NOT solve: **progressive motion arcs**. When a beat is "George raises his arm across 3 frames" (V1: arm starts to rise, V2: arm halfway, V3: arm fully up), every variant edits from the BASE so V3 has no memory of V2. The three frames jitter independently instead of forming a coherent motion arc.

The user's animation intuition for doodle_explainer_2: most moments are static beats where siblings are exactly right (subtle variation, same scene). A minority of moments are real progressions where each frame continues the last. The system needs to do BOTH, and the LLM should be able to pick per group based on what the narration calls for.

## Goals

1. Atlas Edit dispatch supports two modes per variant group: **sibling** (current behavior — V_n edits from base) and **chained** (new — V_n edits from V_n-1's image).
2. Chained mode preserves character identity across the chain — anchor every chained Edit to the original base via prompt language so drift doesn't compound across V1 → V2 → V3.
3. The LLM picks the mode per group based on whether the narration beat is static or progressive. User can override in the editor UI.
4. No regression on sibling groups — the current dispatch behavior is the default and stays unchanged when `chain_variants` is unset/false.

## Constraints

- No new vendor dependencies, no new database tables, no migrations. `chain_variants` is a nullable group-level field on the doc's JSONB row blob, mirroring `group_id`/`variant_index`/`variant_edit_prompt`.
- Atlas Edit cost is unchanged: chained vs sibling routes pass a different `originalImageUrl` but call the same endpoint at the same $0.011/Edit. No cost regression.
- User owns model defaults (memory rule) — no model-id changes.
- Animation continues to be delivered by Atlas Edit. **Never** Remotion motion on a single static image, **never** image-to-video AI (see memory: feedback_near_static_animation_mechanism.md).
- Identity drift is the load-bearing risk. Naive chaining (without an explicit anchor in the Edit prompt) compounds drift ~5%/step → ~14% by V3. The identity-anchor language must be measured against this baseline in the QA pass before broad rollout.

## Requirements

### R1 — Schema addition

One nullable group-level field on the doc's row JSONB:

- `ProductionDocRow.chain_variants?: boolean` — set on the BASE row of a group (variant_index 0). When `true`, the variant dispatcher chains: V_n edits from V_n-1's image instead of from the base. When `false` or unset, dispatch stays sibling (current behavior). The flag lives on the base for cleanest schema — variant rows already share the base's `group_id` so the dispatcher reads it from there.

Location: `src/remotion/utils.ts` (the row TypeScript shape) and `src/lib/auto-pipeline/production-doc-image-gen.ts` parallel field. No DB migration — JSONB is opaque.

### R2 — LLM mixing_rules update

Add a CHAINED-VARIANTS subsection to the existing variant-group prose in `doodle_explainer_2` mixing_rules (`src/lib/production-doc-styles.ts`). Tell the LLM:

- Default = `chain_variants: false` (siblings — small independent variations of the same beat).
- Set `chain_variants: true` ONLY when the narration beat is a real progression: a single physical motion that completes across multiple consecutive rows (a hand rises, a door opens, a character walks forward, fire grows).
- Worked example: "George raises the photograph slowly" across rows 18+19+20 → `chain_variants: true`; "George stares at the photograph in close-up" across the same row span → `chain_variants: false`.
- Explicit anti-pattern: don't set `chain_variants: true` just because rows are in the same group. Group-ness is about same scene; chain-ness is about same continuous motion.

### R3 — Dispatcher fork

`composeVariantEditRequest` in `src/remotion/utils.ts` is the single point of fork. Today it always reads `getBaseRow(doc, groupId)` and passes `baseImageUrl`. After R3:

- If `chain_variants` on the base is true AND `variantRow.variant_index > 1`, look up the PREVIOUS sibling in the group (variant_index N-1) and pass its image_url as `originalImageUrl` instead.
- If `chain_variants` is true AND `variantRow.variant_index === 1`, this is the first variant — there's no prior variant, so it still edits from the base (chaining starts at V1's output).
- If `chain_variants` is false/unset, current behavior is preserved exactly — every variant edits from the base.

The lookup of "previous sibling" needs a new helper `getPreviousVariantRow(doc, groupId, currentVariantIndex)` co-located with `getBaseRow`.

### R4 — Identity anchor for chained Edits

Naive chaining drifts. The Edit prompt for chained variants gets explicit identity-preservation language inserted: *"keep the character's face, hair, clothing, and overall identity EXACTLY identical to the ORIGINAL base frame (referenced by the same group_id) — only the pose, motion, or expression progresses from the previous frame in this chain."*

Composition shape inside `composeVariantEditRequest`:
- Sibling: base.ai_image_prompt + delimiter + variant.variant_edit_prompt (current behavior).
- Chained: prev-sibling's effective prompt (composed from base + cumulative deltas) + delimiter + variant.variant_edit_prompt + identity-anchor clause.

The identity-anchor clause lives in a `CHAINED_VARIANT_IDENTITY_ANCHOR` exported constant for testability and tuning.

### R5 — Editor UI for `chain_variants`

Add a per-group toggle visible on the base row in the editor view:
- Label: "Animation type"
- Options: "Subtle variation (siblings)" / "Progressive motion (chained)"
- Default visible state: whichever value the LLM wrote (or "Subtle variation" when unset)
- Toggle persists to the doc and re-triggers variant Edits for the group when flipped

Location: `src/app/(app)/edit/[projectId]/page.tsx` editor variant group UI. Surfaces alongside the existing `variant_edit_prompt` per-row editor.

### R6 — Observability

Three logs gain a per-group field:
- `[production-doc auto-group-variants]` — bump `chainedGroupCount` and `siblingGroupCount` counters.
- `[doodle-2 variant-dispatch]` (new) — per Edit call: `{ rowIndex, groupId, variantIndex, chainMode: 'sibling' | 'chained', inputImageUrl }`. Lets us audit which mode fired for which row, and which image was used as the Atlas Edit input.
- `[production-doc variant-mode-summary]` (new) — per doc: `{ totalGroups, chainedGroups, siblingGroups, chainedRows, siblingRows }`. One-line read on how the LLM is mixing the two modes per doc.

### R7 — Tests

- Unit test `getPreviousVariantRow`: returns the V_n-1 row for a chained group; returns the base for V1 in a chained group; returns undefined for a sibling group (chained-only helper).
- Unit test `composeVariantEditRequest` with `chain_variants: true`: V1 references the base's image, V2 references V1's image, V3 references V2's image. Identity-anchor clause present in the composed prompt.
- Unit test the LLM-emission path: a doc with `chain_variants: true` on one group and `false` (or unset) on another emits both flag values intact through the doc lifecycle.
- Regression test: sibling groups (no `chain_variants` field set anywhere) continue to dispatch identically to Phase 1.5 behavior — every variant references the base, no anchor clause, no chain log line.
- Integration smoke (~$0.05): a chained 3-frame "George raises arm" sequence, eyeball identity preservation against the base.

## Phased delivery

Single PR, three reviewable commits in order:

1. **Commit 1 — Schema + dispatcher fork.** R1 + R3 + R4. Tests for the dispatch path. No LLM teaching yet (LLM still emits siblings only, schema is forward-compatible).
2. **Commit 2 — LLM mixing_rules teaching.** R2. Verify on a regenerated Sodder doc that the LLM emits `chain_variants: true` on rows with clear progressive motion (if any in the script).
3. **Commit 3 — Editor UI + observability.** R5 + R6. Lets the user override the LLM's choice and gives the QA tool surface to verify mode mix.

**Effort estimate:** ~5 hours total. ~150 LOC + ~100 LOC tests + ~80 LOC editor UI.

## QA after the PR

Re-run the Sodder Children doc end-to-end and verify:

1. Variant-mode-summary log shows a meaningful mix — at least one chained group and at least one sibling group when the script warrants both (the Sodder script has at least the "George raises the photograph" candidate beat).
2. Chained-group Atlas Edit input image_url shows the correct previous-sibling URL (not the base URL) for V2/V3 — confirms the fork actually fires.
3. Visually: a chained 3-frame motion sequence reads as a coherent arc (V3 continues V2 continues V1) AND George's face/clothing stay identical to the base across the chain. If identity drifts visibly on V3, the `CHAINED_VARIANT_IDENTITY_ANCHOR` wording needs tuning before broader rollout.
4. Sibling-only groups produce the same output as Phase 1.5 — no regression in subtle-variation rows.

## Settings audit (CLAUDE.md rule 15)

Two settings worth surfacing:

- **Per-group mode override** (R5 above) — already in scope. Editor UI toggle on the base row.
- **`CHAINED_VARIANT_IDENTITY_ANCHOR` strictness** — an enum `loose | balanced | strict` adjusting the anti-drift language strength. Queued for after the initial wording's QA outcome — if drift is fine at default, we don't need the knob.

Per-style default (chain vs sibling) is NOT a setting — the LLM makes the per-group choice, and the user overrides per group. There's no "always-chain" or "always-sibling" knob because that defeats the LLM's per-beat judgment.

## Observability (CLAUDE.md rule 14)

R6 above. Two new log namespaces + counter additions to existing logs. All new fields are bounded integers or short strings; no PII; no leakage risk.

## Security (CLAUDE.md rule 13)

N/A. Same vendor surface as Phase 1.5 (Atlas Edit), same auth (existing API key), no new user input paths. The `chain_variants` boolean is LLM-emitted and only consumed by the dispatcher as a routing flag — no SQL, no shell.

## Cost (CLAUDE.md rule 8)

**Per-call cost: unchanged.** Atlas Edit is $0.011/call whether the input image is the base or the previous sibling. Chained groups call Atlas Edit the same number of times as sibling groups (one per variant). No cost regression.

**Total cost direction: neutral.** No expected change in i2i vs Edit ratio. If chained variants land enough quality improvement to enable longer-variant groups (4-frame motion arcs vs current 2-frame siblings), Edit call count goes UP — but those calls are cheap ($0.011 each) and the visual gain offsets.

## Open questions

1. **Identity-anchor wording fidelity.** Whether the proposed anchor clause (*"keep face/hair/clothing EXACTLY identical to the ORIGINAL base — only pose/motion/expression progresses"*) is strong enough against Atlas Edit's natural drift. Needs measurement in the Commit 1 smoke test. If V3 visibly drifts from the base on identity, the wording iterates.
2. **Multi-image Atlas Edit input.** Atlas's Edit endpoint may accept multiple input images. If so, chained variants could pass BOTH the previous sibling AND the original base, with the model anchored to the base while progressing from the sibling. Worth testing — could eliminate drift entirely. Defer to Commit 1's smoke test to validate the API supports it.
3. **Retry / repair on mid-chain failures.** If V2's Atlas Edit call fails, V3 cannot chain (no V2 image to edit from). Options: (a) block the whole chain until V2 succeeds, (b) fall back to base-anchored for V3 (drift acceptable), (c) regenerate V2 on demand when V3 is requested. Pick during Commit 1 design — likely (b) with a warning log so the user sees the degradation.
4. **Editor UI surface for failed chains.** When (3) above falls back to base-anchored, should the editor show a "chain broken" indicator on V3? Defer to Commit 3 when the UI takes shape.
5. **Cross-group chains.** What if the LLM groups rows 4+5+6 as one chained group but row 7 is a separate beat that visually continues row 6 (a chase scene that spans two groups)? Current scope: no cross-group chaining — each group is independent. Could revisit if real scripts hit this.
