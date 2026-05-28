# Doodle Explainer 2 — Multi-Character Consistency via Character Bible

**Date:** 2026-05-28
**Owner:** Yoav
**Status:** In flight as the Phase 2 continuation per the original character_cache plan.
**Predecessor:** `_plans/2026-05-28-doodle-2-character-cache.md` (Phase 1), `_plans/2026-05-28-doodle-2-phase-1-5-completion.md`, `_plans/2026-05-28-doodle-2-phase-1-6-completion.md`, `_plans/2026-05-28-doodle-2-chained-variants.md`, `_plans/2026-05-28-doodle-2-scene-cache.md`.

---

## Why this exists

Phase 1 + 1.5 + 1.6 closed the SINGLE-character drift problem. When a row has ONE recurring character, Atlas Edit on the cached base preserves that character's face / hair / clothing perfectly.

Multi-character rows are still uncovered. The Sodder script has rows like "George, Jennie, and four children escaped through the front" where the cache only anchors ONE character (per the precedence rule: the dominant). The others — Jennie, the kids — render fresh on every row, drifting from their canonical appearance across the doc.

Phase 1's plan called Phase 2 "multi-character composition" and proposed two options:

1. Pass multiple cached base URLs to Atlas Edit via `images: string[]`. Unproven — Atlas Edit may pick one to preserve and drift the others, or refuse the multi-image input entirely.
2. Cheaper "character bible" prompt augmentation — store a short visual description per character_id and inject it into every row's prompt so the model has consistent reference language even for non-anchored characters.

Option 2 ships now. Option 1 is a smoke-test follow-up — until we know Atlas can actually compose multiple cached characters coherently, the prompt-augmentation path delivers real value at zero infrastructure risk.

## Goals

1. Every recurring character renders with consistent visual features across the doc — face, hair, clothing, color palette — regardless of whether they're the dominant anchor on the row.
2. Mechanism reuses the existing image-gen route. No new endpoints, no multi-image Atlas Edit dependency.
3. LLM emits a per-doc map of character descriptions once at doc-gen time; the dispatcher prepends the relevant subset to every prompt.

## Constraints

- Same vendor surface as Phase 1 / 3. No new dependencies.
- JSONB-only schema additions; no DB migration.
- User owns model defaults; no model-id changes.
- Animation continues via Atlas Edit (memory: `feedback_near_static_animation_mechanism.md`).
- Cache stays per-doc; no cross-doc reuse.

## Requirements

### R-1 — Schema

One nullable field on the doc:

- `ProductionDoc.doodle_explainer_2_character_descriptions?: Record<string, string>` — LLM-emitted at doc-gen time. Keys are character_id slugs; values are 1-2 sentence visual descriptions: *"George Sodder: gray hair, mustache, dark vest over a white shirt, brown trousers, often holding a hat."*

Mirrors the existing `doodle_explainer_2_character_cache` shape (per-doc map keyed by character_id). Lands in `src/remotion/utils.ts` (canonical), `src/app/(app)/production-doc/page.tsx` (local mirror), and `src/lib/auto-pipeline/production-doc-image-gen.ts` (PipelineImageDoc mirror).

No per-row schema additions. The dispatcher reads the doc-level map and injects descriptions for every recurring character mentioned in the row's prompt.

### R-2 — LLM mixing_rules update

Extend the existing CHARACTERS section in `doodle_explainer_2` mixing_rules:

- For EVERY unique `character_id` used in the doc, emit a `character_descriptions` entry with a 1-2 sentence visual description.
- Describe distinctive, visible, paintable features only — clothing, hair, age, build, distinctive accessories. NOT personality / backstory / unseen attributes.
- Use the SAME slug as the character_id key.
- Worked example for the Sodder script: George, Jennie, Maurice/Martha/Louis/Jennie/Betty (children), and any recurring authority figure.

### R-3 — LLM JSON schema update

Add `doodle_explainer_2_character_descriptions` as an OPTIONAL doc-level field in the JSON schema example in `src/lib/prompts.ts`. Mirrors how variant-group fields and character_id are documented as optional-additive.

### R-4 — Dispatcher augmentation (manual editor + auto-pipeline)

In both image-gen paths, when the active style is doodle_explainer_2 AND the doc has `doodle_explainer_2_character_descriptions`, prepend a "character bible" block to the prompt before the existing prompt-augmentation pipeline:

```
Character reference for this scene:
- George Sodder: <description>
- Jennie Sodder: <description>
- Maurice Sodder: <description>

[user's ai_image_prompt follows]
```

The bible block is injected for every row in a doodle_explainer_2 doc — even single-character rows — so the model always has consistent reference language. Cost: ~50-100 chars per character per row; trivial overhead.

The bible runs UPSTREAM of `augmentCellPrompt`. The augmenter then applies safe-edge / OST / sheet-description directives on the bible-prefixed prompt. Order matters: the bible goes at the TOP so it primes the model's reference for the scene body that follows.

Helper: new `buildCharacterBiblePrefix(character_descriptions): string` in a shared module (`src/lib/character-cache.ts`? No — keep it cohesive: `src/lib/character-bible.ts`).

### R-5 — Observability

- New `[production-doc character-descriptions]` log at doc-gen time: emitted count, sample slugs, total chars (so we can detect missing emissions and runaway descriptions).
- New `[manual-editor character-bible] injected` log per dispatch.
- Auto-pipeline path: bible prefix surfaces in the existing image-gen log.

### R-6 — Tests

- Unit-test `buildCharacterBiblePrefix`: empty map → empty string; single entry → expected prefix; multiple entries → all entries listed.
- Unit-test the dispatcher integration: row with character_descriptions on the doc gets the bible prefix; row without doesn't.

## Phased delivery

Single PR, two commits:

1. **Commit 1 — Schema + helper + LLM teaching + tests.** Pure additive infrastructure. Won't change rendered output until the LLM emits descriptions.
2. **Commit 2 — Dispatcher wiring.** Hooks the bible into both image-gen paths. After this commit, the next regenerated doc with character_descriptions actually changes the rendered images.

**Effort estimate:** ~2 hours. Smaller than Phase 1 because it reuses every existing piece of infrastructure.

## QA after the PR

Regenerate the Sodder Children doc end-to-end. Verify:

1. `payload.doc.doodle_explainer_2_character_descriptions` is non-null with at least 2 entries (George + Jennie typical).
2. `[production-doc character-descriptions]` log shows the emission count.
3. `[manual-editor character-bible] injected` fires on every row.
4. Visually: Jennie renders with the SAME yellow dress / hair / build across rows 3/4/5 (the escape rows). George stays anchored via the character cache; Jennie stays consistent via the bible.

## Settings audit (CLAUDE.md rule 15)

No user-visible setting needed. The bible is server-side infrastructure; the LLM emits, the dispatcher consumes. Like the caches, intrinsic to the mechanism.

## Observability (CLAUDE.md rule 14)

R-5. Three new log lines / namespaces. No PII, no leakage.

## Security (CLAUDE.md rule 13)

N/A. Descriptions are LLM-emitted text strings injected into prompts; same trust boundary as the existing ai_image_prompt content.

## Cost (CLAUDE.md rule 8)

Trivial added prompt overhead — ~50-100 chars per character per row × ~2-3 characters per doc × ~20 rows = ~3-6 KB additional prompt text per doc. Atlas i2i / Atlas Edit pricing is per-call, not per-token, so the cost is zero. The quality lift on non-anchored characters is meaningful.

## Open questions

1. **Bible drift on non-character rows.** Rows with no recurring characters (firefighters, rubble close-ups) still get the bible injected. Is that wasted overhead, or does it not matter at the model? Default: leave it. Skipping per-row adds branching complexity; the overhead is trivial.
2. **Description quality.** The LLM's first description sets the canonical look. If the LLM writes a vague description ("an old man"), every row paints a different old man. Worked examples in mixing_rules emphasize concrete distinctive features (clothing, hair color) to push the LLM toward specific descriptions.
3. **Multi-image Atlas Edit (the deferred Option 1).** Once this ships, we have a working baseline. A future round could smoke-test Atlas with `images: [george.png, jennie.png]` and see whether composing both cached identities produces a coherent two-character scene. If yes, replace the bible for multi-character rows; if no, the bible stays the canonical solution.
