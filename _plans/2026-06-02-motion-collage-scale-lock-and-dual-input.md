# Motion-collage fix — element-scale lock + dual-input chained Edit

**Date:** 2026-06-02
**Trigger:** User reported the warning-triangle motion_collage panels showing the triangle growing from tiny → huge across the four panels AND the sticky-note layout shifting between panels. Two distinct failure modes stacked into one visible bug.

## Goals

1. Stop the LLM from picking "an element grows in size" as the depicted motion. Element scale must be locked across all panels.
2. Stop background/static elements from drifting frame-to-frame in chained Atlas Edit, without losing the smooth motion-arc continuity that the chained approach gave us.

## Constraints

- Must not break the existing chained Atlas Edit identity-preservation flow (variant chains at production-doc-image-gen.ts:412 use the same dispatcher).
- Must not violate the AGENTS.md guardrail: do not retrofit paint_explainer_v1's motion-beat system into doodle_explainer_2 yet (paint_explainer_v1 needs to prove itself in production first).
- Same cost envelope (~$0.054 per 4-panel shot, Atlas Edit at $0.011/call).
- Partial-regen support must keep working.

## Root causes (both confirmed in code)

### 1. Scale-as-motion
The panel-fill LLM at [src/lib/motion-collage-panel-fill.ts](../src/lib/motion-collage-panel-fill.ts) and the main doc LLM at [src/lib/production-doc-styles.ts](../src/lib/production-doc-styles.ts) tell the model "spread the motion evenly across panels" and forbid CAMERA changes but say nothing about ELEMENT scale. So when the narration is something like "a warning appears", the LLM happily picks "the warning starts small and ends huge" as its motion arc — that's a forbidden scale change masquerading as a legitimate motion.

### 2. Chained-edit drift
Atlas Edit is not a copy-pixels-with-changes operation — it re-generates the entire image conditioned on the input. Each chained step at [production-doc-image-gen.ts:1782-1909](../src/lib/auto-pipeline/production-doc-image-gen.ts) introduces ~5% layout drift. After 3 steps the sticky notes have wandered 20-40px from where they started. The framing-lock clause helped but couldn't eliminate it because the model is still re-painting from scratch each step.

## Chosen approach

### Fix A — Tighten both LLM-prompt-authoring layers

Add an explicit ELEMENT-SCALE-IS-LOCKED section to:
- `motion-collage-panel-fill.ts` (the autofill behind the "Convert to motion collage" button)
- `production-doc-styles.ts` (the main doc-generation LLM's MOTION COLLAGE block)

The new section:
- Names the failure mode by example ("a warning triangle that 'appears small in panel 1 and huge in panel 4' is WRONG").
- Enumerates **forbidden** verbs and adjectives: grows, growing, gets bigger, gets larger, enlarges, swells, expands, shrinks, fills the frame, dominating, looms, more prominent, scaled up, blown up, huge, tiny.
- Enumerates **allowed** motion types: translation (position change), rotation, character pose/expression change, progressive stroke (arrow/line being drawn), text appearing letter by letter, a hand pointing to different anchors in sequence.
- Gives a concrete GOOD/BAD pair for the warning-sign failure mode so the LLM has a pattern to copy.

### Fix B' — Dual-input chained Atlas Edit (replaces the original B which I withdrew)

I originally proposed switching all panels to edit from panel 0 (eliminates compounding drift). The user pushed back correctly: that would make the motion jumpy because each panel would imagine the moving element's position independently. There is no guarantee panel 1's position lies between panel 0's and panel 2's.

The revised approach uses Atlas Edit's native multi-input capability:

For each panel K (K ≥ 2), pass **TWO** input images:
1. **Primary input** = `previousPanelUrl` — provides motion continuity. The model sees where the moving element was last frame and interpolates smoothly to this frame's position.
2. **Second input** = `panel0Url` — provides the composition anchor. Every static element (sticky notes, character, background, props that aren't moving) must match the second input's positions exactly.

For panel 1, the previous panel IS panel 0, so the second input is omitted (it would be a duplicate of the first).

The dispatcher at [src/lib/gpt-image-2-edit.ts](../src/lib/gpt-image-2-edit.ts) is extended with an `extraImageUrls?: readonly string[]` field. Both vendors (Atlas's `images` array and Kie's `input_urls` array) receive `[sourceImageUrl, ...extraImageUrls]` in order. The per-panel edit prompt spells out which input is which so the model can reason about them deterministically.

### Why this gives both smooth motion AND locked composition

- The previous-panel input still acts as the "motion source" so frame K's element position interpolates naturally from K-1's. The arc is smooth.
- The panel-0 input is a parallel reference the prompt explicitly anchors composition to. Even if the previous panel has drifted (a sticky note moved 10px from panel 0), the model is told to trust the second input for static layout.
- No compounding drift: composition is anchored to panel 0 at every step, not to the previous (already-drifted) panel.

## Alternatives rejected

### Always edit from panel 0 (single-input)
Eliminates compounding drift but introduces motion jumpiness — every intermediate panel imagines the element's position independently. Rejected after user pushback.

### Programmatic overlay (paint_explainer_v1-style motion beats)
The right long-term answer for pixel-locked composition, but reinventing what paint_explainer_v1 already does (`<PropSlideIn>`, `<ScribbleDraw>`, `<MouthSwap>`, `<LabelPopOn>`, `<MicroWiggle>`). AGENTS.md explicitly forbids retrofitting paint_explainer_v1's motion-beat system into doodle_explainer_2 until paint_explainer_v1 has 3+ production renders that hold up to scrutiny. Deferred — A + B' may be good enough, and if they aren't, the right path is the paint_explainer_v1 retrofit per AGENTS.md §17, not a parallel motion_collage-only overlay system.

### Tightening only A (LLM prompt) without fixing the chain
Half-measure — even with perfect translation-only motion prompts, chained Atlas Edit still drifts the static elements. The composition anchor in B' is the only thing that anchors them.

## File-level change list

- [src/lib/motion-collage-panel-fill.ts](../src/lib/motion-collage-panel-fill.ts) — system prompt now has an ELEMENT-SCALE IS LOCKED section + forbidden-words list + allowed-motions list + concrete GOOD/BAD example for warning-sign.
- [src/lib/production-doc-styles.ts](../src/lib/production-doc-styles.ts) — main doc-generation LLM's MOTION COLLAGE per-panel rules now have the same scale-lock language for parity.
- [src/lib/gpt-image-2-edit.ts](../src/lib/gpt-image-2-edit.ts) — `Gpt2EditOpts.extraImageUrls?: readonly string[]` added; both Atlas and Kie branches concatenate `[sourceImageUrl, ...extraImageUrls]`. Dispatch log includes `extra_image_count`.
- [src/lib/auto-pipeline/production-doc-image-gen.ts](../src/lib/auto-pipeline/production-doc-image-gen.ts) — chained-edit loop now reads `panelResults[0].url` as the composition anchor; for panels 2..N-1 it passes that URL via `extraImageUrls` and tells the model in the prompt that the second input is the composition anchor. The per-panel `panel done` log includes `composition_anchor: boolean`.

## Testing (rule 18)

- [tests/motion-collage-panel-fill.test.ts](../tests/motion-collage-panel-fill.test.ts) — new `element-scale lock` describe block asserts: (a) the system prompt contains "ELEMENT-SCALE IS LOCKED", "never be the element growing", "keep the SAME SIZE across every panel"; (b) the forbidden words list contains grows / gets bigger / enlarges / expands / shrinks / fills the frame; (c) the allowed-motion list mentions translation, rotation, pose, progressive stroke; (d) the warning-sign GOOD/BAD example is present.
- [tests/gpt-image-2-edit-dispatch.test.ts](../tests/gpt-image-2-edit-dispatch.test.ts) — new `extraImageUrls passthrough` describe block asserts: (a) Atlas receives `[source, ...extras]` in `images`; (b) Kie receives the same shape in `input_urls`; (c) omitting `extraImageUrls` keeps the legacy single-input call shape.
- Full suite: 7 failures in 3 unrelated files (`atlas-images.test.ts`, `scoped-tables-coverage.test.ts`, `voiceover-alignment-integration.test.ts`) — confirmed pre-existing on baseline. All 69 tests in the four files we touched / are adjacent to (motion-collage-* + chained-variants-dispatch + gpt-image-2-edit-dispatch) pass.

## Observability (rule 14)

Two new fields on the existing namespaced logs:

- `[gpt2-edit dispatch] start { …, extra_image_count }` — confirms the second input was passed for panels 2..N-1.
- `[motion-collage pipeline] panel done { …, composition_anchor: boolean }` — confirms whether the anchor was applied per panel. Panel 1 should log `false`; panels 2..N-1 should log `true`.

To diagnose a future "the static elements drifted again" report, grep for `[motion-collage pipeline] panel done` and check the `composition_anchor` field on the failing panel index.

## Security (rule 13)

No new attack surface. The extra image URL is doc-internal (it's `panelResults[0].url`, already produced by the same pipeline run). No user input flows into the new field. Atlas and Kie URL handling is unchanged.

## Settings audit (rule 15)

No new user-facing knobs. The dual-input behavior is a pipeline implementation detail; the user's existing motion_collage controls (grid size, panel prompts, allow_motion_collage flag) remain the surface. If we later observe that the anchor is too strong for some shots and want a per-shot escape hatch, that's a follow-up.

## Open questions

- Kie's behavior with multi-input in `gpt-image-2-image-to-image` is documented as supported but not exercised by any other caller. If the Atlas → Kie fallback fires during a motion_collage panel call, the Kie response may differ from Atlas's in ways we haven't seen. Telemetry from the first few real runs will tell us if this matters.
- The framing-lock clause now explicitly tells the model to override "grows" instructions if they leak through the LLM prompt anyway. This belt-and-suspenders may be redundant once the panel-fill side stops emitting scale words, but the redundancy is cheap and the cost of one Atlas call going wrong is non-trivial — keep it for now.

## What was NOT done (deferred per AGENTS.md §17)

- Programmatic SVG/PNG overlay system inside motion_collage. Would duplicate paint_explainer_v1's motion-beat infrastructure. If A + B' don't ship acceptable results, the right next step is the paint_explainer_v1 motion-beat retrofit through the architecture's planned path (`paint_explainer_v1_motion_optin` flag on the doc), NOT a parallel motion_collage-only overlay system.
