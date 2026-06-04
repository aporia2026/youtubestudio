# Doodle Explainer 2 — Phase 1.6 (wire the character cache into the manual editor + cleanup)

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** Approved 2026-05-28. Execute in order D → 3 → E → F → 4. Bug 2 (Atlas Edit count drift) deferred to its own round.
**Predecessor:** `_plans/2026-05-28-doodle-2-phase-1-5-completion.md` (commits 4589520, 1bca4ad, 57cde61).

---

## Why this exists

Phase 1.5 fixed the LLM-emission contract (Bug A), the auto-grouper's identical-prompt blind spot (Bug B), and OST safe-area cropping (Bug C). QA on Sodder doc `b30b8d1e-e753-4edc-b718-67b6f25d3b34` (run 11:13 UTC, post-deploy) verified those three.

Same QA also revealed:

- **Bug D (load-bearing)** — the character cache mechanism that is the *entire* deliverable of Phase 1 only fires on the auto-pipeline image-gen path. The manual editor / production-doc page uses a different image-gen route that never references the cache. The QA doc has `character_id = "george-sodder"` on 15 of 22 rows AND 20 generated images AND `doodle_explainer_2_character_cache: NULL`. Phase 1's hot path is dead code on the surface the user actually uses. **The drift you're still seeing on George is the pre-Phase-1 baseline because the cache mechanism isn't firing.**
- **Bug 3** — LLM emitted two rows (5 and 6) with the same `group_id` AND the same `variant_index = 1` AND identical `variant_edit_prompt`. Editor renders both as "variant 1/2" — visually broken group structure.
- **Bug E** — LLM picked `visual_type = "Statistics"` on row 9 ("No bones. No teeth.") for a doodle_explainer_2 doc. Statistics rows have empty `ai_image_prompt` by design and the editor offers only "Search Images". The narrative beat should have rendered as Animation.
- **Bug F** — when an Animation row has `ai_image_prompt` but no `image_url` yet, the editor surfaces "Search Images" as the primary action instead of "Generate AI image". Discoverability problem — the user has to know the affordance is hidden behind a different control.
- **Bug 4** — the doodle_explainer_2 ref set includes a realistic forest-path photo (illustrating "real photos can compose into the cartoon"). i2i treats it as a content reference and bleeds the forest into unrelated scenes (rows 16, 17, 21 in the QA doc). The existing memory `feedback_refs_teach_style_only.md` predicts this exact failure mode.
- **Bug 2 (deferred)** — base→variant person-count drift when the variant_edit_prompt says "remove the extra two children". Atlas Edit removes more than asked. This is a pre-existing Atlas Edit limitation that wants its own round of variant-prompt precision work, not in scope here.

## Goals

1. Character cache writes AND reads fire on the manual editor's image-gen path. End state: regenerate Sodder, `character_cache` is non-null with `george-sodder` mapped to a base URL, AND subsequent rows with `character_id = "george-sodder"` go through Atlas Edit on the cached base instead of fresh i2i.
2. No two rows in the same group share a `variant_index`. Auto-grouper or a new dedicated post-pass enforces this invariant on the LLM's output.
3. doodle_explainer_2 docs never have `visual_type = "Statistics"` or `"Title Card"` on mid-script narrative rows.
4. The editor's primary action on an un-generated Animation row with a prompt is "Generate AI image", not "Search Images".
5. The active doodle_explainer_2 ref bundle does not contain content-distinctive realistic photos that i2i will stamp into scenes verbatim.

## Constraints

- No new vendor dependencies. No new tables. No migrations. Same cache shape as Phase 1 (per-doc JSONB).
- No regression on the auto-pipeline path's cache behavior (which already works per the smoke test).
- User owns model defaults — no model-id changes anywhere.
- Animation is delivered via Atlas Edit variants from a shared base, never Remotion motion or image-to-video (memory: `feedback_near_static_animation_mechanism.md`).

## Requirements

### R-D — Wire the character cache into the manual editor image-gen route

**Files:**
- `src/app/api/generate/production-doc/image/route.ts` (the manual editor's single-shot image-gen route)
- `src/lib/auto-pipeline/production-doc-image-gen.ts` (existing helpers `buildCharacterContinuationEditPrompt`, `generateCharacterContinuationImage` — relocate into a non-auto-pipeline module so the manual route can import without crossing the auto-pipeline boundary; new file `src/lib/character-cache.ts` is the cleanest landing spot)
- `src/lib/auto-pipeline/stages/generate-production-doc-images.ts` (continues to call the relocated helpers — same behavior, just from a new path)

**Behavior:**
1. The manual route receives a per-row image-gen request that already includes the doc context (style, refs, row's `ai_image_prompt`, etc.). Today it always calls Atlas i2i with the style refs. Phase 1.6 adds a pre-check:
   - When `doc.style_preset === 'doodle_explainer_2'` AND the row has `character_id` AND the doc's cache has an entry for that slug → call Atlas Edit on the cached base with the wrapped continuation prompt (same flow as the auto-pipeline path uses today). Cost: ~$0.011 vs ~$0.04.
   - On cache miss with `character_id` set → run normal i2i, then write `cache[character_id] = { base_url, first_seen_row_index }` to the doc's JSONB. The next row with the same slug goes through Atlas Edit.
   - On Edit failure → fall back to fresh i2i so the row still ships (matches auto-pipeline behavior). Telemetry counter.

2. **Read** the cache from the doc the route is operating on. The manual route currently receives the row and doc context separately; the cache lookup needs `(doc.id, row.character_id)`. If the route receives a snapshot of `doc` already, read from there; if not, fetch via the existing doc-load helper.

3. **Write** the cache. The manual route persists the generated image URL back to the doc (via the existing patch endpoint). The cache write needs to be part of that same persistence step so the cache and image_url land atomically. If the persistence is a separate call from the gen call (likely), bundle the cache write into the persistence payload.

**Observability:**
- Add `[manual-editor character-cache] hit-and-edit | miss-and-store | edit-failed-fallback-to-i2i` log at every fork, mirroring the existing auto-pipeline namespace.

**Tests:**
- Unit: cache-hit path calls Atlas Edit with the wrapped prompt and persists the result without touching i2i.
- Unit: cache-miss path runs i2i then writes the cache entry.
- Unit: Edit failure on cache hit falls back to i2i (the row's image still ships, telemetry bumps).
- Integration (no smoke needed — already proven by Phase 1's smoke artefacts at `_plans/2026-05-28-atlas-edit-smoke/`).

### R-3 — Variant-index collision post-pass

**Files:** `src/lib/production-doc-postprocess.ts` (or a new sibling module `src/lib/variant-index-dedup.ts` if postprocess is already crowded — pick whichever keeps each file scannable).

**Behavior:**
For every `group_id` present in the doc, walk the rows and verify:
- Exactly one row has `variant_index === 0` (the base).
- The remaining variants have unique `variant_index` values, contiguous starting at 1.

When a collision is detected (two rows with the same `(group_id, variant_index)`):
- If the rows have **identical** `ai_image_prompt` AND `variant_edit_prompt` → drop the duplicate (keep the first occurrence). Mirrors the auto-grouper's "identical prompts mean one beat" philosophy.
- If they differ → renumber the duplicates sequentially so each variant has a unique index. Pick by position order.

When the base is missing (group has variants but no `variant_index === 0`) → log a warning. Promote the row immediately preceding the first variant as the base IF it's a plain fresh row (no group_id, has an `ai_image_prompt`), mirroring the auto-grouper's existing rescue pass.

**Observability:** `[production-doc variant-index-dedup]` log with counts of `collisions_resolved`, `duplicates_dropped`, `renumbered`, `bases_recovered`.

**Tests:** unit tests for each of: duplicate-with-same-prompt → dropped; duplicate-with-different-prompts → renumbered; missing-base → recovered if previous row is fresh; missing-base → logged warning if no fresh predecessor.

### R-E — doodle_explainer_2 mixing_rules guardrail against Statistics / Title Card mid-script

**File:** `src/lib/production-doc-styles.ts` (doodle_explainer_2 mixing_rules section).

**Behavior:** add a SHOT TYPE section near the top of the mixing_rules:

```
== SHOT TYPE — ALWAYS ANIMATION FOR NARRATIVE BEATS ==

Every row narrating the story is `visual_type: "Animation"`. Do NOT
use "Statistics", "Title Card", "Talking Head", or "Screen Recording"
for mid-script narrative beats — those types emit an empty
ai_image_prompt and the editor cannot generate an image for them.

Use the typed exceptions only when the script explicitly calls for
them: opening/closing title cards from explicit <<TITLE_N>>
sentinels, or a narrator-on-camera intro. Default = Animation.
```

**Tests:** none specific — covered by re-running Sodder and verifying row 9's visual_type is now Animation.

### R-F — Editor surfaces "Generate AI image" before "Search Images" on un-generated Animation rows

**File:** `src/app/(app)/production-doc/page.tsx` (the row cell UI; specifically the empty-image-cell action area).

**Behavior:**
Today: when a row has no `image_url`, the cell shows "Search Images" as the primary visible action. "Generate AI image" lives behind a hidden affordance or doesn't exist at this surface (TBD — needs UI audit).

After R-F: when a row has `visual_type === "Animation"` AND non-empty `ai_image_prompt` AND no `image_url`:
- Primary action: "Generate AI image" (existing i2i flow).
- Secondary action: "Search Images" (de-emphasised — smaller, dimmer, or behind a "more" menu).

For Title Card / Statistics / Talking Head rows (where ai_image_prompt is empty), "Search Images" stays primary — those rows have nothing to generate.

**Tests:** none specific — UX change, validated by visual inspection in the editor.

### R-4 — Curate the doodle_explainer_2 ref set against content bleed

**Files:** `public/style-refs/Doodle-explainer/` (the active ref bundle directory).

**Behavior:**
1. Audit the current refs visually. Identify any with distinctive content (named locations, recognisable objects, signature compositions) — the forest-path photo is the known offender from this QA round.
2. Move offenders to `public/style-refs/_review-not-Doodle-explainer/` per the existing `feedback_ref_curation.md` workflow.
3. Replace each removed ref with a subject-neutral realistic photo that demonstrates "realism CAN appear" without seeding a specific subject — examples: textured paper, fabric weave, abstract close-up of brushwork, neutral wood grain.
4. Verify the new ref set still teaches the "realism integrates into doodle" style without bleeding specific subjects.

**No tests** — this is content curation. Validation is the next Sodder re-run not showing the forest where it doesn't belong.

## Phased delivery

Single PR, five reviewable commits in order:

1. **Commit 1 — Bug D** (R-D). Largest. Touches both the route and a new shared module. Wins back the entirety of Phase 1's value.
2. **Commit 2 — Bug 3** (R-3). Small, self-contained server-side post-pass. Unit-tested.
3. **Commit 3 — Bug E** (R-E). 10-line mixing_rules clause.
4. **Commit 4 — Bug F** (R-F). Editor UX change.
5. **Commit 5 — Bug 4** (R-4). Ref curation; mostly file moves and replacements. No code.

**Effort estimate:** ~4 hours total. Bug D dominates (~2.5 hours). Each of 3/E/F is ~20 min. Bug 4 is whatever the ref hunt takes.

## QA after the PR

Regenerate the Sodder Children doc end-to-end on the deployed branch. Verify:

1. `payload.doc.doodle_explainer_2_character_cache` is non-null with `george-sodder` mapped to a base URL.
2. `[manual-editor character-cache]` logs show at least 1 `hit-and-edit` line per re-occurrence of George.
3. No `(group_id, variant_index)` collisions in the rendered rows — the editor's variant-count badges read sensibly ("1/2", "2/2").
4. Every row has `visual_type === "Animation"` for narrative beats — no "Statistics" mid-script.
5. The editor's empty-image cell on row 2 (or any Animation row that hasn't been generated yet) shows "Generate AI image" as the primary action.
6. Visually: George looks IDENTICAL across rows 0, 1, 2, 3, 4, 5, 6, 8, 10, 11, 15, 16, 20 (every row with `character_id = "george-sodder"`). House and forest no longer bleed into scenes that don't call for them.

## Settings audit (CLAUDE.md rule 15)

None of the five fixes warrant a new user-visible setting:

- D — cache wiring; intrinsic plumbing, no knob.
- 3 — variant-index collision is malformed data; always silently corrected.
- E — Animation default is a style guarantee, not a preference.
- F — primary action ordering is a UX correctness fix.
- 4 — ref curation is editorial.

## Observability (CLAUDE.md rule 14)

- D — new `[manual-editor character-cache]` namespace with hit/miss/fail counters; plus the existing `[doodle-2 character-cache]` log on the auto-pipeline path unchanged.
- 3 — new `[production-doc variant-index-dedup]` log per doc.
- E/F/4 — no new logs.

## Security (CLAUDE.md rule 13)

N/A. Same vendor surface, same auth, no new user input paths. `character_id` is LLM-emitted and only consumed as a JSONB key.

## Cost (CLAUDE.md rule 8)

**Bug D is a savings unlock.** Today's manual editor path runs every row through fresh i2i ($0.04). Each row reusing the cache will drop to $0.011 (Atlas Edit). On the Sodder doc that's ~14 character-bearing rows × $0.029 saved = ~$0.40 per doc when Phase 1 actually fires on this surface. Compounds across docs.

Bugs 3, E, F, 4 — no cost impact.

## Open questions

1. **Where does the cache write fit in the manual editor flow?** The auto-pipeline writes inside its image-gen stage handler. The manual editor likely has image-gen split across (route generates → client patches doc with image_url). The cache write needs to ride along with that patch, not a separate save. Will figure out at the start of Commit 1 by reading the manual route.
2. **Concurrent cache writes.** If the user triggers multiple row image-gens in parallel (which the editor does on bulk-generate), two requests may both miss the cache for the same `character_id`, both run i2i, and the last write wins. Acceptable for V1 — the cost overhead is one extra i2i call per concurrent burst, and the cache still settles. Document the behavior; revisit if it becomes annoying.
3. **Existing docs without character_cache.** Docs created pre-Phase-1.6 have no cache field. The new code paths read `doc.doodle_explainer_2_character_cache ?? {}` — empty cache is fine, miss-and-store fires on the next char-bearing row. No migration needed.
