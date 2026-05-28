# Doodle Explainer 2 — Scene/Location Cache (Phase 3)

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** In flight as the "continue to next step" follow-up after Phase 1.7 R5 landed.
**Predecessor:** Phase 1 (`_plans/2026-05-28-doodle-2-character-cache.md` shipped `46f4031`), Phase 1.5 (`_plans/2026-05-28-doodle-2-phase-1-5-completion.md`), Phase 1.6 (`_plans/2026-05-28-doodle-2-phase-1-6-completion.md`), Phase 1.7 (`_plans/2026-05-28-doodle-2-chained-variants.md`).

---

## Why this exists

The QA on Sodder doc b59e88ad (pre-Phase-1) flagged TWO drift problems: George rendered with different hair / suit across non-consecutive shots, AND the family home rendered with different colors / window layouts shot-to-shot. Phase 1 + 1.5 + 1.6 closed the character-drift problem via `character_id` and the Atlas Edit cache.

The location/object drift is still open. The Sodder script mentions the family home across 5+ rows ("they went to bed → house on fire → family escaped → empty doorway → searched the rubble") — but each row goes through fresh i2i with no shared anchor for the house. Random diffusion variation gives a different house every time.

Phase 3 — explicitly queued in the Phase 1 plan as "Phase 3 — Scene/location cache" — mirrors the character_cache mechanism for recurring locations and significant recurring objects. Same pattern, same dispatch infrastructure, same cost profile. Solves the second half of the drift problem.

## Goals

1. Recurring location identity is consistent across all rows referencing the same `scene_id` within a doc.
2. The mechanism reuses the proven character_cache pattern from Phase 1 + Bug D's manual-editor wiring — no new architecture, no new endpoints.
3. When a row has BOTH `character_id` AND `scene_id`, the dispatcher picks one cache to hit (character wins — character identity is more visually load-bearing than location consistency, and Atlas Edit can only preserve one image's content per call).
4. No regression on rows that lack `scene_id` — they continue through the existing i2i / character-cache paths unchanged.

## Constraints

- Same vendor surface as Phase 1 (Atlas i2i base + Atlas Edit continuation). No new dependencies.
- Same JSONB-only schema additions; no DB migration.
- User owns model defaults; no model-id changes.
- Animation continues to be delivered via Atlas Edit (see memory: `feedback_near_static_animation_mechanism.md`).
- The cache is per-doc only; no cross-doc reuse (out-of-scope per Phase 1 plan).

## Requirements

### R-1 — Schema additions

Two nullable fields, parallel to the character cache fields:

- `ProductionRow.scene_id?: string` — stable slug identifying a recurring location or significant recurring object: `"sodder-house"`, `"fire-ladder-shed"`, `"the-burning-house"`, `"investigator-desk"`. LLM-emitted on every row showing the same scene.
- `ProductionDoc.doodle_explainer_2_scene_cache?: Record<string, { base_url: string; first_seen_row_index: number }>` — per-doc map from slug to the canonical i2i base for that scene.

Mirrors `character_id` / `doodle_explainer_2_character_cache` exactly. Lands in `src/remotion/utils.ts` (canonical), `src/app/(app)/production-doc/page.tsx` (local mirror), and `src/lib/auto-pipeline/production-doc-image-gen.ts` (PipelineImageRow + PipelineImageDoc mirrors).

### R-2 — LLM mixing_rules update

Add a SCENES subsection to `doodle_explainer_2` mixing_rules, positioned right after the existing CHARACTERS section. Tells the LLM to:

- Detect recurring locations / significant objects in the script.
- Pick stable lowercase-with-dashes slugs: `"sodder-house"`, `"family-home-exterior"`, `"investigator-desk"`.
- Set `scene_id` on EVERY row showing that location/object.
- Worked example using the Sodder script: rows 0/1/2/3/4/12/13 all show the family home → `scene_id: "sodder-house"`.
- Explicit anti-pattern: don't emit `scene_id` for one-off backgrounds (a generic "rubble close-up" used once); leave it undefined.

### R-3 — Dispatcher integration (auto-pipeline)

Mirror the Phase 1 character_cache dispatch in `src/lib/auto-pipeline/stages/generate-production-doc-images.ts`. For each row in a `doodle_explainer_2` doc:

1. **Cache HIT (row has `scene_id` AND cache[scene_id] exists AND no character_id hit takes precedence):**
   - Build a scene-continuation edit prompt: *"Modify this image to keep the same location/setting in this new beat: [original ai_image_prompt]. CRITICAL: keep the location's architecture, exterior, color palette, and overall identity EXACTLY identical to the input image. Only change the action, characters, and atmospheric elements per the new scene description above."*
   - Call Atlas Edit with the cached `scene_cache[scene_id].base_url`.
   - Persist the edit result.
   - Telemetry: `[doodle-2 scene-cache] hit-and-edit`.

2. **Cache MISS with scene_id:** generate fresh via i2i (existing path), then write `scene_cache[scene_id] = { base_url, first_seen_row_index }`.

3. **No scene_id (or character_id wins):** existing path unchanged.

**Precedence rule:** when both `character_id` and `scene_id` are set on a row AND both have cache entries, the character_id path wins. Atlas Edit can only preserve one source image's content; preserving the character's face / hair / clothing is higher-stakes than the location's architecture. The non-winning slug's cache stays populated for future single-tag rows.

### R-4 — Dispatcher integration (manual editor)

Mirror the same dispatch in `src/app/(app)/production-doc/page.tsx`'s `generateImageForRow`, paralleling Bug D's character-cache integration:

- Read `doc.doodle_explainer_2_scene_cache[scene_id]` before dispatch
- On hit: route through the existing `/api/generate/production-doc/image/edit` endpoint with the scene-continuation prompt
- On miss: standard i2i, then `setDoc` + `updateProductionDocEntry` to persist the new cache entry (matching Phase 1.6 hot-fix 1's atomic-persist pattern)
- Logs: `[manual-editor scene-cache] hit-and-edit | miss-and-store | edit-failed-fallback-to-i2i`

### R-5 — Scene-continuation edit prompt helper

A pure helper `buildSceneContinuationEditPrompt(originalScenePrompt)` next to `buildCharacterContinuationEditPrompt` in `src/lib/character-cache.ts` (rename the module to `src/lib/scene-cache.ts`? No — keep them separate for cohesion. Add a new module `src/lib/scene-cache.ts` with the same shape.) The wording emphasizes location identity preservation: "keep the architecture / exterior / color palette / overall identity EXACTLY identical."

### R-6 — Observability

- `[doodle-2 scene-cache]` namespace logs at every step (hit, miss-and-store, edit-failure).
- Doc-gen log `[production-doc scene-ids]` mirrors `[production-doc character-ids]`: counts unique slugs, reusable slugs (≥2 rows), sample slugs.
- Per-tick summary log includes scene_cache_hits / scene_cache_misses_stored / scene_cache_edit_failures.

### R-7 — Tests

- Unit-test `buildSceneContinuationEditPrompt`: returns the expected identity-preservation wording with the scene body interpolated.
- Unit-test `getCachedScene` / `writeSceneToCache`: same coverage as character-cache (hit, miss, first-occurrence-wins, immutability).
- Unit-test the dispatch precedence: row with both character_id and scene_id, both cached, dispatcher picks character path.

## Phased delivery

Single PR, three reviewable commits:

1. **Commit 1 — Schema + helpers + tests.** Pure additive; safe to ship without behavior change because no caller consumes the new field yet.
2. **Commit 2 — Auto-pipeline dispatch + manual-editor dispatch.** Wires both paths to the new cache, mirrors Phase 1 + Bug D code.
3. **Commit 3 — LLM mixing_rules update + JSON schema.** Teaches the LLM to emit `scene_id`. After this commit lands and the user regenerates, the cache actually fires end-to-end.

**Effort estimate:** ~3 hours (the design is fully derived from Phase 1; almost all code is copy-and-rename with the precedence rule the only novel bit).

## QA after the PR

Regenerate the Sodder Children doc end-to-end. Verify:

1. `payload.doc.doodle_explainer_2_scene_cache` is non-null with at least one entry (likely `sodder-house`).
2. `[manual-editor scene-cache] hit-and-edit` log fires on at least one row after the first occurrence.
3. Visually: rows showing the family home render the SAME house exterior across rows 0/1/2/3/4/12+ — same roof, same siding, same windows.
4. Character cache still fires on character-only rows (no precedence-rule regression).
5. The mixed character+scene rows render with consistent character (the precedence-rule winner) — the scene may drift slightly, but the character stays anchored.

## Settings audit (CLAUDE.md rule 15)

No new user-visible setting needed. Same reasoning as Phase 1: `scene_id` is intrinsic to the cache mechanism; users don't have a use case to disable it for a doc that has recurring locations.

## Observability (CLAUDE.md rule 14)

R-6 above. Three new log namespaces; no PII; no leakage.

## Security (CLAUDE.md rule 13)

N/A. Same vendor surface, same auth, no new user input paths. `scene_id` is LLM-emitted and only used as a JSONB key.

## Cost (CLAUDE.md rule 8)

**Net savings, parallel to Phase 1's analysis.** Per Sodder doc with the family home on ~7 rows: pre-fix 7 × $0.04 = $0.28; post-fix 1 × $0.04 + 6 × $0.011 = $0.106. **62% savings on the affected rows AND the location renders identically.**

When character_id AND scene_id are both present and both cached, the character path wins; the scene cache is only USED on rows where character_id is absent or uncached. So the savings stack only on scene-only rows; mixed rows still save through the character path.

## Open questions

1. **Precedence rule fidelity.** When character_id wins on a mixed row, the location drifts. Is that acceptable? Expected to be yes — the character is the visual focal point — but verify after the first QA.
2. **Scene-continuation edit-prompt wording.** The character-continuation prompt was smoke-tested. The scene wording is parallel but not separately smoke-tested. If location drifts under the proposed wording, iterate.
3. **What counts as a "scene"?** A character close-up against plain white background — is that a "scene"? LLM judgment call. Worked examples in mixing_rules show locations and named buildings as canonical; close-ups against plain backgrounds are NOT scenes.
