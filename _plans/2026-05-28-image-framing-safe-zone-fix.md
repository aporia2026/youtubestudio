# Image framing — stop content getting cut at the top and bottom

**Date:** 2026-05-28
**Status:** implemented (council-revised). See "Council revisions applied" at the bottom for what changed vs the original draft.
**Related plans:**
- `_plans/2026-05-27-doodle-explainer-2-ref-bleed-fix.md` — earlier attempt at the same symptom from the ref-image angle. This plan is the downstream prompt-layer backstop.
- `_plans/2026-05-28-doodle-2-character-cache.md`, `2026-05-28-doodle-2-scene-cache.md` — the Atlas Edit continuation paths whose prompts currently skip the safe-zone directive entirely.

## Problem

Generated images frequently place faces, characters, text, and props flush against the top and bottom edges of the visible frame. In the post-crop / post-render image, that content is either:

- **Literally destroyed** by the 1536×1024 → 1536×864 center-crop on the variant + collage paths (7.8% off the top AND 7.8% off the bottom = ~16% of vertical content gone).
- **Visually destroyed** by the rendered scene's tight composition with no breathing room above/below — looks unprofessional even when no crop fires.

The user's example (2026-05-28): a hacker character whose head sits flush at the top edge, and the text "1,500 businesses" partly cut at the bottom of the canvas.

## Root cause (two layers)

### Layer 1 — `safeEdgeDirective` is weak

`src/lib/prompt-augmentation.ts:156-157` asks for a 10% margin in negative phrasing:
> "No text, faces, callouts, props, titles, or background elements extend within 10% of the top, bottom, left, or right edge of the canvas."

Two weaknesses:
- **Negative-only.** Diffusion models obey positive composition language ("content sits in central 70%") much more reliably than prohibitions ("no content within 10%").
- **Margin too tight for the actual destroy band.** Variant + collage paths crop 7.8% off top and bottom — a 10% directive leaves only 2.2% headroom. Any drift past spec lands inside the destroy band.

### Layer 2 — Atlas Edit prompts skip the directive entirely

`buildCharacterContinuationEditPrompt` (`character-cache.ts:51`), `buildSceneContinuationEditPrompt` (`scene-cache.ts:35`), and the variant edit compose (`production-doc-image-gen.ts:327-338`) build their own prompts inline — none of them prepend or append any safe-edge guard. Atlas Edit gets zero framing instruction. The fact that the cached base image dictates most of the composition makes this less catastrophic than it sounds, but compounds across continuation chains and shows up as the bottom-cut symptom on every Edit-path output.

## Goal

Make every Atlas T2I, Atlas i2i, Atlas Edit, and Atlas-collage prompt explicitly steer content into the central 70% of the canvas with at least 15% empty padding above and below, in both positive and negative phrasing, so future generations stop placing critical content in the destroy band.

## Constraints

- **Prompt-only change.** No new vendors, no new infrastructure, no new SKUs. No size changes — variants + collage are stuck at 1536×1024 by Atlas's Edit-endpoint validation (`src/lib/image-edit-pricing.ts:256-262`, "Atlas Edit's size enum is 1024×1024 / 1024×1536 / 1536×1024 only; 2560×1440 returns 404").
- **Backward compatible.** Existing generated images stay as they are. Only new generations get the stronger framing.
- **No quality regression on full-frame scenes.** Some shots legitimately need to fill the frame (close-up portraits, full-screen text moments). The new wording must still allow the model to fill the central 70% — not force shrinking to 50% with massive empty bands.
- **Wording must be terse.** Each new directive eats into `promptCap` budget (`SINGLE_SHOT_PROMPT_CAP = 2000`, `COLLAGE_CELL_PROMPT_CAP = 600`). The safe-edge block today is ~280 chars; the new version must stay within ~350 chars to avoid further squeezing the user's body prompt.

## Approach (recommended)

Two coordinated changes:

### A. Replace `safeEdgeDirective` in `prompt-augmentation.ts`

Combine positive + negative, name the post-crop reality, ask for 15% bands:

```
Wide composition with empty whitespace padding across the top 15% and bottom 15% of the canvas. All characters, faces, text, props, and key details occupy ONLY the central 70% of the frame, with generous vertical breathing room. The image will be cropped at the top and bottom — anything placed in the outer 15% bands is lost. No element touches or extends past any edge of the canvas.
```

Length: ~360 chars (slightly longer than current ~280). Acceptable within `COLLAGE_CELL_PROMPT_CAP = 600` budget (still leaves >200 chars for user body after subtracting all other directives).

The `ostSafeEdgeReinforcement` directive (already exists at `prompt-augmentation.ts:203-205`, fires only when OST is baked) stays as-is — its 15% number now matches the safe-edge baseline instead of overriding a weaker 10%.

The `safeTopDirective` (fires only when section title overlays the image, `prompt-augmentation.ts:165-167`) stays as-is — it's already positive-phrased and complements the new baseline.

### B. Add a shared `SAFE_FRAMING_EDIT_SUFFIX` constant + append it to every Atlas Edit prompt

Lives in `src/lib/prompt-augmentation.ts` (next to `augmentCellPrompt`) so the source of truth is one place. Worded for the Edit context (the model is editing an existing image, not generating from scratch):

```
When repositioning elements in this scene, place all characters, faces, text, props, and key details inside the central 70% of the frame with at least 15% empty padding from the top and bottom edges. Do not extend any element to or past the top or bottom edge of the canvas.
```

Length: ~280 chars.

Append it (with a `\n\n` separator) inside:
- `buildCharacterContinuationEditPrompt` in `src/lib/character-cache.ts:51`
- `buildSceneContinuationEditPrompt` in `src/lib/scene-cache.ts:35`
- The variant compose in `src/lib/auto-pipeline/production-doc-image-gen.ts:327-338` (and the manual `/api/generate/production-doc/image/edit/route.ts` if it composes inline)

Mouth-removal prompt (`src/lib/atlas-mouth-removal.ts:MOUTH_REMOVAL_PROMPT`) is excluded — the model is editing an already-framed image, and the prompt is structural (remove mouth pixels), not compositional.

### C. Strengthen `prependCharacterBible` context (out of scope, flagged)

The character bible passes through `augmentCellPrompt`, so it already benefits from the strengthened `safeEdgeDirective`. No change needed.

### Alternatives rejected

- **B-only: skip the augmentCellPrompt rewrite, only patch the Edit-path prompts.** Misses the i2i base path that produces the cached bases — every continuation then inherits the original bad framing. The root must be fixed at the base.
- **A-only: skip the Edit-path suffix.** Edit-path prompts get zero framing instruction today and would continue to bias toward "preserve the input image as-is" — which compounds when the input itself is poorly framed.
- **Bump variant + collage to 2560×1440 to skip the crop.** Atlas Edit rejects 2560×1440 with 404 (verified 2026-05-27 per `image-edit-pricing.ts`). Not available. (See Open Question 1 below — needs verification before this plan ships, because if 2560×1440 secretly works on Edit, the variant path's crop can be eliminated entirely.)
- **Bump the safe-edge percentage to 20%.** Tested: leaves only 60% of the frame for content, which produces visibly empty / unbalanced scenes on close-ups. 15% is the right balance (8% headroom over the 7.8% destroy band, 7% over).
- **Generate at native 16:9 (2560×1440) for i2i base only and live with 1536×1024 for Edit.** Already the case (`image-gen-i2i.ts:660` defaults to 2560×1440). This plan doesn't change that.

## Security and safety

- Prompt-only change, no new attack surface.
- All sanitization (`augmentCellPrompt`'s newline strip + length cap) continues to apply because the new wording lives inside the same fixed directive blocks, not the user body.

## Observability

- Existing `[prompt-augmentation truncated]` log line continues to fire if the strengthened directives push the user body past `promptCap` minus overhead — already covered.
- Add a one-time `[image framing] safe-edge directive updated` log at module load, with the new directive char length, so post-deploy we can confirm in Vercel logs that the new wording is what's running.
- After deploy, sample 10 random generated images and eyeball for the bottom-cut symptom. Log the QA result in a follow-up note appended to this plan.

## Settings audit

No new user-facing setting. Reasoning:

- The 15% safe-band number is determined by the post-crop math (7.8% destroyed × 2 sides + headroom), not by user preference. Exposing it would let a user pick a number that lands content in the destroy band — a footgun, not a feature.
- Per-style safe-zone overrides would be a real feature later (e.g. paint_explainer_v1 might want different bands than doodle_explainer_2). Out of scope for this fix; if the QA pass reveals style-specific tuning is needed, file as a follow-up plan.
- The OST baking mode (`bake` / `overlay` / `none`) stays user-controlled. The strengthened directive applies to all three modes — `overlay` and `none` still need the model to NOT place its own text near the edges.

## Pricing impact

None. Prompt-only change adds ~80 chars of overhead per generation; no new vendor calls, no new SKUs.

## Open questions

1. **Does Atlas Edit actually reject 2560×1440?** `image-edit-pricing.ts:256-262` says yes (404, verified 2026-05-27). But `production-doc-image-gen.ts:571,659` for character / scene continuation use 2560×1440 on Edit calls (added 2026-05-28). One of these must be wrong. **If Edit does accept 2560×1440, the variant + collage paths can bump to 2560×1440 and skip the crop entirely — which would eliminate Layer 1 of the symptom geometrically without any prompt change. Need to verify before shipping this plan.** Verification: tail `[atlas-images]` logs from a recent character-cache hit and check whether Atlas returned 200 (working) or whether the helper swallowed a 404 (broken).
2. **Will the strengthened wording over-tighten compositions?** On close-up portraits or full-screen-text moments, "central 70% only" might produce a visibly empty / awkward result. Mitigation: the "with generous vertical breathing room" phrasing keeps it advisory; the 70% number is the floor, not the ceiling. QA pass after deploy will confirm.
3. **Should `composeCollagePrompt` template add its own safe-zone reminder?** Each cell is augmented with the strengthened directive, but the collage scaffolding ("here are 4 scenes in a 2×2 grid...") could mention "each cell respects 15% top/bottom padding" to reinforce. Light lift, but only if needed — defer until the QA pass shows the per-cell directive is being diluted by the collage frame.

## Surfaces changed

1. **`src/lib/prompt-augmentation.ts`** — replace `safeEdgeDirective` body; add and export `SAFE_FRAMING_EDIT_SUFFIX` constant.
2. **`src/lib/character-cache.ts`** — append `SAFE_FRAMING_EDIT_SUFFIX` inside `buildCharacterContinuationEditPrompt`.
3. **`src/lib/scene-cache.ts`** — append `SAFE_FRAMING_EDIT_SUFFIX` inside `buildSceneContinuationEditPrompt`.
4. **`src/lib/auto-pipeline/production-doc-image-gen.ts`** — append `SAFE_FRAMING_EDIT_SUFFIX` inside the variant compose at lines 327-338.
5. **`src/app/api/generate/production-doc/image/edit/route.ts`** — append `SAFE_FRAMING_EDIT_SUFFIX` if the route composes its own edit prompt inline.
6. **`tests/prompt-augmentation.test.ts`** — extend coverage: the new wording is present in every augmented prompt, length stays within budget, `SAFE_FRAMING_EDIT_SUFFIX` is exported and appended by each helper.
7. **`tests/character-cache.test.ts`, `tests/scene-cache.test.ts`** (extend if exist; create if not) — assert the suffix is appended.
8. **`ROADMAP.md`** — entry under image-gen / framing-quality.

## Out of scope

- Changing the destroy-band geometry (crop math). Atlas Edit's size validation forces it.
- Per-style safe-zone tuning.
- Adding any new visible user-facing setting.
- Mouth-removal prompt (different problem).
- Fixing the cached bases that already have edge-bleed — those have to be regenerated to benefit, or accepted as legacy.

## Council revisions applied (2026-05-28)

The original draft was pressure-tested through the LLM council. Resulting changes from draft → shipped:

1. **2560×1440 contradiction resolved.** User confirmed Atlas Edit rejects `2560x1440` with 404. The "if Edit accepts 2560×1440 the framing plan collapses" branch did NOT fire. Character/scene continuation calls at `production-doc-image-gen.ts:571,659` had been silently failing since 2026-05-28. Hotfixed in the same PR as this plan: both calls now use `size: '1536x1024'` + `cropTo16x9AndUpload`. The swallowed `warn` log was promoted to `logger.error('[atlas-edit-failed pipeline character-continuation]', ...)` so the next vendor contradiction doesn't hide for days. Same treatment applied to all five Edit-path catches in the file (base / variant / mouth-removed / character / scene).
2. **Directive-stacking eliminated.** Council flagged that stacking `safeEdgeDirective` + `ostSafeEdgeReinforcement` + `safeTopDirective` + `SAFE_FRAMING_EDIT_SUFFIX` would produce "tiny floating heads in empty canvases" on close-ups (diffusion models concatenate emphasis when the same numeric constraint repeats). Resolution: `ostSafeEdgeReinforcement` was removed entirely; `safeEdgeDirective` is now the single canonical 15% / central-70% statement. `safeTopDirective` and `ostLeadingDirective` reference the safe zone by NAME without re-asserting percentages. Tests updated to cover the new wording AND a new test asserting the directive fires exactly once.
3. **`SAFE_FRAMING_EDIT_SUFFIX` extracted to its own module.** `composeVariantEditRequest` lives in `src/remotion/utils.ts` which is reached from client components. Putting the constant in `src/lib/prompt-augmentation.ts` (which depends on the server-only logger) would have dragged `process.stdout.write` into the client bundle. New file: `src/lib/prompt-framing.ts` — pure-text, no IO, safe to import from any module (server / client / Remotion bundle).
4. **Edit-path coverage explicitly listed.** Suffix applied to:
   - `buildCharacterContinuationEditPrompt` in `src/lib/character-cache.ts`
   - `buildSceneContinuationEditPrompt` in `src/lib/scene-cache.ts`
   - The variant compose at `src/lib/auto-pipeline/production-doc-image-gen.ts:325-338`
   - `composeVariantEditRequest` in `src/remotion/utils.ts:1027` (the manual editor path — was missing from the original draft, council's "manual path drifts from auto-pipeline" concern made it explicit).
5. **QA plan upgrade.** Original "eyeball 10 random images" was called a vibe check. Concrete metrics for the post-deploy review: saliency must stay inside the central 70% region of the canvas, OST glyph bbox top must sit ≥15% from the top edge. (Implementation of automated metric checks is deferred to a follow-up plan, but the standard is named here so a reviewer doesn't accept "looks fine".)
6. **Council blind spot it caught us on:** the silent `warn`-and-swallow pattern is itself the systemic bug — fixing 2560×1440 without making vendor failures loud means the next contradiction hides just as long. All five Edit-path catches in `production-doc-image-gen.ts` now log at `error` level with the `[atlas-edit-failed]` namespace.

What didn't change from the draft: 15% margin (validated as the right number — 8% headroom over the destroy band, 7% over the OST anti-drift bound). Positive + negative phrasing combined. Suffix wording. No new user-facing setting.
