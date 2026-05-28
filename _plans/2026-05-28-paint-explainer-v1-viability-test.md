# Paint Explainer v1 — Architecture Viability Test

**Date:** 2026-05-28
**Branch:** claude/video-creation-ui-pqXzS
**Status:** in progress
**Predecessor:** none — this gates the full `paint_explainer_v1` plan, which will only be written once this test resolves.

## Goal

Resolve, in a single afternoon, the two load-bearing architecture questions for the future `paint_explainer_v1` style before committing to a 4–6 PR plan:

1. **Mouth-swap viability** — can we get a "talking character" effect that reads as alive (not as a creepy puppet) using one Atlas-generated base image plus a procedural mouth overlay animated in code?
2. **Scribble draw-on viability** — does a stroke-reveal animation over a static base read like the Paint Explainer "drawing in progress" signature, or like a generic motion-graphics wipe?

Output: one side-by-side comparison MP4 placed at `hiccup-analysis/paint-explainer-viability/comparison.mp4` (folder borrowed for ad-hoc artifacts) showing the reference clip alongside both viability candidates. User watches it and renders a verdict.

## Why (the council, summarized)

The LLM Council unanimously flagged the original architecture as too large to commit to without proving the riskiest primitive first. Key blockers:

- **Mouth-swap might look broken at 6fps** — masked Atlas Edit would give sharp seams and lighting drift if it existed, but discovery during exploration revealed **Atlas Edit has no mask parameter at all** (`src/lib/atlas-cloud-images.ts:26-31` documents `supportsMask: false`). So the original masked-edit approach is dead on arrival. The remaining path is *procedural* mouth: Atlas removes/clears the mouth area, code overlays SVG/CSS mouth states. This is also closer to how the genre is actually produced per the user's own forensic STYLE_GUIDE.md (puppet rigs, parts swap).
- **LLM emitting anchor coords on an unseen base** would be a coin flip at 50%+ miss rate. Procedural mouth at a hardcoded position is an acceptable bound for the test; an anchor pass (vision model or generator-supplied coords) is a separate problem for the real plan.
- **Cost math was hand-waved.** This test costs ≤ $0.05 in Atlas calls; we'll know whether the architecture survives before committing the cost-modelled plan.
- **Audio was missing from the entire architecture.** Four of five council peer reviewers raised it. Excluded from this viability test by design (visual reads first), but flagged for inclusion in the real plan.

## Constraints

- **Cost ceiling for the test:** ≤ $0.10 (about 9 Atlas Edit calls worst case).
- **Time ceiling:** half a day.
- **No code in `src/`** — all test artifacts live under `scripts/paint-explainer-viability/` and `hiccup-analysis/paint-explainer-viability/`. Nothing touches the production renderer, the LLM prompt, the schema, or the existing `doodle_explainer_2` style.
- **No PR opened from this work** unless the test passes and we begin the real plan.

## Approach

### Base assets

- **Mouth-swap test base:** `public/style-refs/Doodle-explainer-2/14-close-up-character-face.jpg` (close-up of the explainer character; mouth is large and clearly positioned).
- **Draw-on test base:** `public/style-refs/Doodle-explainer-2/03-lone-stick-figure-frowning.jpg` (single subject, clean background, good for stroke-reveal demo).
- **Reference clip:** 5-second slice from `refs/the paint explainer/videoplayback.mp4` starting at a known character-talking moment.

### Test A — procedural mouth-swap

1. **Atlas Edit pass:** prompt the model to remove the mouth from the close-up character base, leaving the face plain (no seam, no shadow). Result: `face_no_mouth.png`.
2. **Procedural mouth overlay (HTML + headless capture):** a small standalone HTML page renders the `face_no_mouth.png` and overlays an SVG mouth at an approximate position. The SVG mouth cycles through three states (closed `⌒`, mid `−`, open red oval) at 6, 8, and 10 fps. Capture each fps variant via ffmpeg screen-record or via a Remotion preview render. If headless capture is fussy, fall back to building the three mouth-state PNGs and using ffmpeg's `overlay` + `tile` filter on a frame sequence.
3. **Output:** three 5-second MP4s — `mouth_6fps.mp4`, `mouth_8fps.mp4`, `mouth_10fps.mp4`.

### Test B — scribble draw-on

1. **No Atlas call.** Take the unmodified `03-lone-stick-figure-frowning.jpg`.
2. **ffmpeg-driven reveal:** apply a horizontally-moving feathered mask via the `geq` filter or a programmatically-generated alpha frame sequence. The image is revealed left-to-right over ~3 seconds, then holds for 2 seconds. This is a low-fidelity stand-in for true stroke-by-stroke SVG draw-on, but it answers the same question: does progressive reveal read as "alive"?
3. **Output:** `drawon.mp4` (5 seconds).

### Test C — side-by-side comparison

1. **ffmpeg slice:** extract a 5-second talking-character moment from `videoplayback.mp4` → `ref_clip.mp4`.
2. **ffmpeg stack:** scale every clip to a common height, then `hstack` in this order: `ref_clip | mouth_6fps | mouth_8fps | mouth_10fps | drawon`. Single output file.
3. **Output:** `hiccup-analysis/paint-explainer-viability/comparison.mp4`.

## Decision rules (after the user watches the comparison)

- **Mouth-swap reads alive at one of 6/8/10 fps:** Layer 1 architecture is viable as proposed; the real plan proceeds with `<MouthSwap>` as a Remotion primitive backed by an Atlas "mouth-removed" base.
- **Mouth-swap reads as puppet at every fps:** Layer 1 mouth-swap dies. Pivot to First Principles' "drawing in progress" framing — `<ScribbleDraw>` becomes the load-bearing primitive, and the budget shifts toward generating bases in multiple draw stages rather than mouth PNGs.
- **Draw-on reads alive:** confirms `<ScribbleDraw>` regardless of the mouth verdict. We ship it.
- **Draw-on reads template-y:** the real plan must use stronger draw-on signals (stroke-by-stroke SVG path animation in Remotion, not ffmpeg-reveal), and the test result is a known-low-fidelity floor, not a kill signal.

## Observability (per rule 14)

Every command logged with namespace `[paint-explainer viability]`:
- `[paint-explainer viability atlas] mouth-removed gen start` — input image, prompt
- `[paint-explainer viability atlas] mouth-removed gen done` — output URL, cost in tokens
- `[paint-explainer viability ffmpeg] mouth-overlay <fps>fps render` — input, output, duration
- `[paint-explainer viability ffmpeg] drawon render` — same shape
- `[paint-explainer viability ffmpeg] hstack comparison` — final output path

## Security (per rule 13)

- No user data, no PII, no live production-doc rows touched. All inputs are repo-committed style refs.
- Atlas API key already provisioned via env (per `env_vars_provisioned.md` memory).
- Output MP4 is local-only; not uploaded anywhere automatically.

## Settings audit (per rule 15)

N/A. This is a viability test, not a user-facing feature. The real `paint_explainer_v1` plan will carry the Settings audit (mouth fps, talk threshold, draw-on duration, real-photo cadence, etc.).

## Open questions (resolved before locking the real plan)

1. **If Atlas refuses to cleanly remove the mouth** (returns the same face or with artifacts) — does the procedural approach work at all, or do we need a vision pass on the base to detect mouth position? *Resolved by the test output.*
2. **What's the right fps for the loop?** *Resolved by side-by-side viewing — the user picks.*
3. **Does the procedural mouth position need to be character-specific (head tilt, profile angle) or can a single anchor work for most poses?** *Punted — answered when we run more bases through the real plan's PR 1.*

## Out of scope

- Anchor coordinates for non-mouth motion (labels, props). Answered in the real plan.
- Real-photo overlay mix. Already works in `doodle_explainer_2`; not a viability question.
- Audio / alignment-JSON viseme timing. Will be in PR 1 of the real plan per user direction; excluded here to keep the test visual-only.
- Any LLM prompt or schema changes. None happen until the real plan is approved.
