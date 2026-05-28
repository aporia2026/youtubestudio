# Doodle Explainer 2 — Character + Scene Consistency via Atlas Edit Cache

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** Awaiting approval before Phase 1 execution.

---

## Why this exists

After the Phase 2 work (refs + REALISM + variant compliance) shipped in commit `ecbd993`, the next layer of inconsistency surfaced in the Sodder Children QA: non-consecutive shots of "the Sodder family" rendered with different hair, different ages, different family-member counts (a baby appeared in one shot but not others); the family home rendered with different colors and window layouts shot-to-shot.

Variant groups solve consistency between *consecutive* rows (same composition, additive delta). They do not help when the same character or scene reappears later in the doc with other rows between. paint_explainer_v1 has a `character_id` cache, but it only caches the mouth-removed pair — the base image is regenerated fresh on every row, so it does NOT enforce visual consistency. Confirmed by grepping the codebase: `cache[characterId].base_url` is written but never read for reuse.

The actual fix: cache the base image of each recurring character keyed by `character_id`, and on subsequent rows referring to the same character, use **Atlas Edit** to modify the cached image with the new scene/pose. Atlas Edit operates on an input image with an edit prompt — character identity is preserved while pose/setting/expression can change.

## Goals

1. Character appearance is consistent across all rows referencing the same `character_id` within a doc.
2. Location/scene appearance is consistent across rows referencing the same `scene_id` (Phase 3).
3. Implementation reuses the proven cache pattern from paint_explainer_v1's pipeline integration (same persistence shape, same telemetry shape) so future maintainers see one mechanism, not two.
4. No regression on rows that lack `character_id`/`scene_id` — they continue through the existing i2i path unchanged.

## Constraints

- **Atlas i2i caps at 4 refs/call.** We can't add a 5th slot. All character-continuation work goes through Atlas Edit, not multi-ref i2i.
- **First occurrence of a character must be i2i.** The character has to exist before it can be cached. Edit is only meaningful when there's a prior generation to edit from.
- **User owns model defaults** (memory rule). The Edit call uses Atlas's `openai/gpt-image-2/edit` per the existing edit-models registry; no new model selection.
- **No breaking schema changes.** Both new fields (`character_id`, `scene_id`) are nullable additions to the row JSONB blob; existing rows keep working with both undefined.
- **Cache lives on the production_doc record's JSONB metadata**, mirroring `paint_explainer_v1_character_cache`. No new tables, no new migrations.

## Requirements

### R1 — Schema additions

Three nullable fields:

- `ProductionDocRow.character_id?: string` — stable slug identifying a recurring character. The LLM picks the slug on the first row a character appears (e.g. `"george"`, `"jennie"`, `"louis"`) and reuses it on every subsequent row the character is in.
- `ProductionDocRow.scene_id?: string` — stable slug identifying a recurring location/object (e.g. `"sodder-house"`, `"fire-ladder-shed"`). Phase 3 wiring.
- `ProductionDoc.doodle_explainer_2_character_cache?: Record<string, { base_url: string; first_seen_row_index: number }>` — per-video cache keyed by `character_id`. Persisted to the artefact's `metadata_jsonb` after each stage tick.

All fields land in `src/remotion/utils.ts` (the row/doc TypeScript shape) and in `src/lib/auto-pipeline/production-doc-image-gen.ts` (the pipeline row type if it has its own). No DB migration — JSONB is opaque.

### R2 — LLM mixing_rules update

Add a CHARACTERS section to `doodle_explainer_2` mixing_rules instructing the LLM to:

- Detect every recurring character/entity in the script.
- Pick a stable, short, lowercase-with-dashes slug per character (`"george"`, `"jennie"`, `"louis-as-adult"`).
- Set `character_id` to that slug on EVERY row showing that character.
- Pick stable `scene_id` slugs for recurring locations.

Include a worked example using the Sodder Children script structure ("George went to bed" → set character_id "george"; "George and Jennie escaped" → both ids; etc.).

### R3 — Stage handler cache integration

In `src/lib/auto-pipeline/stages/generate-production-doc-images.ts`, mirror the paint_explainer_v1 pattern (lines 268–333) but for the BASE-IMAGE cache:

For each row in a `doodle_explainer_2` doc:

1. **Cache HIT (row has `character_id` AND `cache[character_id]` exists):**
   - Compose an edit prompt from the row's `ai_image_prompt`: `"Modify this image: [original ai_image_prompt]. Keep the character's identity (face shape, hair, body proportions, clothing) exactly identical."`
   - Call Atlas Edit with the cached `base_url` as the input image.
   - Persist the edit result as the row's `image_url`.
   - Cost: ~$0.011/call (Edit) vs ~$0.04 (i2i) → 73% savings on repeated characters.
   - Telemetry: `[doodle-2 character-cache] hit { row_index, character_id }`.

2. **Cache MISS with character_id (first occurrence):**
   - Generate fresh via i2i with the 4 style refs (existing path).
   - Persist `cache[character_id] = { base_url: result.imageUrl, first_seen_row_index: index }`.
   - Telemetry: `[doodle-2 character-cache] miss-and-store { row_index, character_id }`.

3. **No character_id:**
   - Existing path unchanged — i2i with style refs.

### R4 — Edit-prompt transformer

A small helper `buildCharacterContinuationEditPrompt(originalPrompt: string): string` that wraps the LLM's `ai_image_prompt` into an Atlas Edit instruction. Lives next to `generateMouthRemovedForCharacter` in `production-doc-image-gen.ts` for cohabitation.

Default wrapper format:
```
Modify this image to show the SAME character in this new scene: ${originalPrompt}.
CRITICAL: keep the character's face, hair, body proportions, clothing, and overall identity EXACTLY identical to the input image. Only change the pose, setting, expression, and other scene elements per the new scene description above.
```

Variations may be needed if Atlas Edit drifts more on certain prompt shapes — iterate during QA.

### R5 — Observability

- `[doodle-2 character-cache]` namespace logs at every step (hit / miss-and-store / failure).
- Update the existing `[production-doc variants]` and `[production-doc overlay-stock terms]` block in `route.ts` to also log `cacheHitCount` and `cacheMissCount` per doc — gives a one-line read on how much consistency reuse is happening.
- Add a `[doodle-2 character-cache-summary]` log at the end of each tick: `{ totalRows, uniqueCharacters, cacheHits, cacheMisses, costSaved }`.

### R6 — Tests

- Unit test the cache helper: cache hit path returns the cached URL through Edit; miss path generates fresh and writes the cache; missing character_id passes through unchanged.
- Unit test the edit-prompt transformer: known input → known output, edge cases (very long prompts, multi-character mentions, prompts already containing "modify").
- Integration test against a Mary Celeste-style script: 20 rows, 1 recurring character mentioned in rows 3, 7, 12, 18; verify cache hits in rows 7/12/18 and miss in row 3.

## Phased delivery

### Phase 1 — Character cache for solo-character rows (R1 + R2 + R3 + R4 + R5)

- Schema additions only for `character_id` (defer `scene_id` to Phase 3).
- LLM instruction + worked example added to mixing_rules.
- Stage handler integration for character-bearing rows.
- Edit-prompt transformer + Atlas Edit call wired up.
- Observability logs.
- QA: regenerate the Sodder Children doc and verify the family's appearance is consistent across rows 4 / 10 / 16 (or wherever George reappears).

**Out of scope for Phase 1:**
- Multi-character rows (Phase 2)
- Scene cache (Phase 3)
- Editor UI for character_id editing (Phase 4 — current behavior is "LLM-emitted only")

**Effort estimate:** 1 working day. ~250 LOC + 100 LOC tests + plan reference.

### Phase 2 — Multi-character rows

When a row has multiple characters in scope (e.g. "George and Jennie escape"), pass multiple cached base URLs to Atlas Edit via `images: string[]`. Verify Atlas can compose multiple cached characters into one scene. If not, fall back to single-character Edit + accept drift on the other character, or use the cheaper "character bible" prompt augmentation.

Effort: 0.5 day after Phase 1 proves the single-character path works.

### Phase 3 — Scene/location cache

Add `scene_id` field. Same caching pattern. Use cases: "the Sodder house" reappearing across the fire / search / aftermath scenes. Especially relevant for stories with one or two strong location anchors.

Effort: 0.5 day. Mostly mechanical extension of Phase 1.

### Phase 4 — Editor UI for character_id

When the editor surfaces `character_id` as an editable per-row field with a dropdown of "characters used so far in this doc," the user can correct LLM mis-tagging and explicitly mark continuations. Out of scope for now; queue as a future round if Phase 1-3 land well and there's still room for improvement.

## Settings audit (CLAUDE.md rule 15)

Potential per-feature controls:

- `character_cache_enabled` — boolean toggle, default ON. Could disable for one-off rendering experiments.
- `character_cache_edit_strictness` — enum `loose | balanced | strict`. Adjusts the "keep identity exactly identical" language in the edit prompt. Affects how rigid Atlas is about not drifting.

Both queued for the Settings round after Phase 1 verifies the mechanism works. Not part of the Phase 1 ship.

## Observability (CLAUDE.md rule 14)

Already in R5. Logs:
- Per-row: `[doodle-2 character-cache]` hit / miss-and-store / failure.
- Per-doc: `[doodle-2 character-cache-summary]` counts + cost saved.
- Combined view: extend `[production-doc variants]` to include cache stats so the same Vercel log entry shows both metrics.

## Security (CLAUDE.md rule 13)

N/A. No new external systems, no new user inputs, no new data flows. The `character_id` is LLM-emitted and only ever used as a JSONB key on the doc record (no SQL, no shell). Atlas Edit is already an authorised vendor call with the existing API key.

## Cost (CLAUDE.md rule 8)

**Per-row savings:** Atlas Edit at ~$0.011/call vs Atlas i2i at ~$0.04/call → 73% savings on every cache hit.

**Per-doc impact:** for a 20-row doc with 1 recurring character mentioned in 4 rows:
- Before: 4 × $0.04 = $0.16
- After: 1 × $0.04 + 3 × $0.011 = $0.073
- Saving: ~$0.087 (54%) on those 4 rows, ~5% on the doc total.

For docs with multiple recurring characters across more rows, the savings scale. **Net cost direction: down.**

**LLM cost:** unchanged. The mixing_rules update adds ~400 chars but the doc-side cache logic is entirely server-side.

## Open questions

1. **Atlas Edit identity fidelity** — does Atlas's Edit endpoint actually preserve character identity reliably across pose/scene changes? Or does it produce "blurry-but-similar" outputs? Verify in Phase 1 QA with a 3-row test (George in bed → George holding photograph → George at fire) before broader rollout. If fidelity is poor, fall back to "character bible" prompt-only approach as a degraded mode.
2. **Multi-character composition** — when row mentions "George and Jennie," does passing two cached images to Edit produce a coherent two-character scene, or does Atlas pick one to preserve and degrade the other? Phase 2 question; may need a custom composition strategy.
3. **Cache invalidation on edits** — if user manually edits a row's image in the editor, should that propagate to the cache (overwriting the canonical base)? Defer the policy to Phase 4 (editor UI work) — for now the cache is auto-pipeline-only.
4. **Cross-doc cache** — should the same character_id reuse a base across multiple docs? E.g. "george" in the Sodder Children doc vs. a different "george" in a future doc. Default: NO — cache is per-doc only. Cross-doc would need a workspace-level character bible, out of scope.
