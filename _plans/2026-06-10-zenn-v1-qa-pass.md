# zenn_v1 - End-to-End QA Pass (PR 7)

**Date:** 2026-06-10
**Status:** runbook, awaiting first execution
**Dependencies:** PR 1 through PR 6.5 merged
**Plan:** `_plans/2026-06-10-zenn-v1-style.md` (parent)

This document is the runbook for the final acceptance pass before
zenn_v1 is treated as production-ready. The PR 7 deliverable in plan
section 12 is not code - it is a graded human evaluation of three
rendered videos against real Zenn reference clips. The bar is "a
reviewer cannot reliably tell at a glance which is which."

This runbook has three parts: pre-flight, the three test renders, and
the A/B grading rubric. Work through them in order. Stop and triage
any bug as soon as it surfaces - it is much cheaper to fix mid-pass
than after a full re-render.

---

## 0. Pre-flight (do once, before the first render)

Run through this list before kicking off the first test doc. Skipping
a step here is what makes a QA pass take three days instead of one.

### 0.1 Environment

- [ ] Vercel project has `PIPELINE_IMAGE_GEN_CAP_USD = 20` set
  (Production AND Preview). Without this every render will stall at
  the $10 cap mid-job (plan section 11).
- [ ] Vercel project has the existing Kie API key
  (`KIE_API_KEY`) set. The zenn_v1 stage routes through the existing
  gpt-image-2-edit dispatcher, so the same env var works.
- [ ] R2 bucket is reachable (`R2_IMAGES_BUCKET_NAME`,
  `R2_IMAGES_PUBLIC_URL`, the access key vars). Mirror writes go
  here on every generation.
- [ ] Vercel function `maxDuration` is still 300 s on the cron route.

### 0.2 Reference material

- [ ] Local copies of the seven Zenn reference videos at
  `refs/zenn/*.mp4` are present (Calhoun, Spotlight, Ancient Humans
  Day, Ancient Humans Night, Aliens, Titanic, Baby).
- [ ] Per-video frame grids at `refs/zenn/_analysis/*_grid.jpg` are
  present (the same files we used to define the style in PR 1).
- [ ] Side-by-side comparison setup: two windows, real Zenn on the
  left, our render on the right, both at 100% playback. Audio off
  for the first pass (the visual comparison is the bar).

### 0.3 Style sanity check

In the production-doc page, pick the zenn_v1 style and confirm:

- [ ] Settings panel mounts and shows the nine controls.
- [ ] Default mode is "Scene (Mode B, the differentiator)".
- [ ] Label color reads `#D32F2F`.
- [ ] Highlighter is on, color `#FFE840`.
- [ ] Ground color reads `#9E9E9E`.
- [ ] Median shot length reads 3.2 s.

### 0.4 Test pipeline check (no LLM, no Kie spend)

Run the existing test suite once. It exercises every helper the
pipeline depends on without touching real APIs:

```bash
npx vitest run tests/zenn-v1-*.test.ts
```

Expected: ~159 tests pass. If any fail, fix before proceeding.

---

## 1. Test renders (three videos, different stress profiles)

The three renders are chosen to exercise different paths through the
pipeline. Each one targets a specific failure mode that could only
surface in production.

### 1.1 Render A - Mode B world-driven (high character persistence)

**Topic suggestion:** "What if the Romans had encountered Vikings?"
or any historical/animal-kingdom-style topic with recurring named
entities.

**Why this script:**
- Forces high Mode B usage (named historical entity needs a recurring
  drawn character).
- Stresses the character bank pipeline (3-5 unique recurring entities
  expected).
- Stresses the world overlay rendering (sky_ground for outdoor
  scenes; possibly room for indoor).

**Procedure:**
1. Create a new production-doc with style preset `zenn_v1`.
2. Generate the script via the existing pipeline at 7-10 min target.
3. Wait for the production-doc generation to complete.
4. Open the resulting doc and confirm:
   - [ ] Every row has `zenn_mode` set.
   - [ ] At least 60% of rows are `scene` (the differentiator mode).
   - [ ] `zenn_v1_character_descriptions` is populated at the doc
     level with 3-7 entries.
   - [ ] At least one recurring `zenn_character_id` shows up on
     5+ rows.
5. Generate images and wait for the pipeline to finish (multiple
   ticks).
6. Check the Vercel function logs for `[zenn-v1 mode-pick]`,
   `[zenn-v1 character-bank]`, `[zenn-v1 world-background]`,
   `[zenn-v1 cost-tick]`. Confirm:
   - [ ] mode-pick log shows the LLM's `stick` / `scene` distribution.
   - [ ] character-bank log fires once per unique character.
   - [ ] world-background log fires once.
   - [ ] cost-tick cumulative_cost_usd is in the $7-15 range.
7. Render the video end-to-end.

### 1.2 Render B - Mode A canvas-reveal heavy (psychological topic)

**Topic suggestion:** "Why do we feel deja vu?" or any
internal/psychological topic where Mode A is the dominant mode.

**Why this script:**
- Forces high Mode A usage (abstract, no recurring entity).
- Stresses the canvas_reveal pipeline (long evolving shots need
  multi-layer reveals).
- Stresses the red label overlay (more on-screen-text-heavy than
  Mode B).

**Procedure:**
1-5: same as Render A.

Doc-level confirmations specific to this render:
   - [ ] At least 50% of rows are `stick` (Mode A is the right pick
     for this topic).
   - [ ] At least 10 rows carry `zenn_canvas_reveal_layers` entries.
   - [ ] At least one canvas_reveal layer has `fade_in_ms: 0`
     (canvas_layer_add semantics for the snappy beat).
   - [ ] No row has `overlay_stock_terms` populated (Zenn uses zero
     photographic content; if any row carries this, the style suffix
     or mixing_rules need a fix before we proceed).

6-7: same as Render A, with the additional log:
   - [ ] `[zenn-v1 canvas-reveal]` log fires once per generated layer.

### 1.3 Render C - Mixed-mode worst-case (statistical topic)

**Topic suggestion:** "Why are airplane crashes so rare?" or any
data-heavy topic that requires both modes (chart callouts in Mode A
plus scene worlds for incident dramatization in Mode B).

**Why this script:**
- Forces real mixing of both modes inside one doc.
- Stresses the world overlay defaulting (some rows pick a Mode B
  overlay; others don't and should fall back cleanly to white).
- Surfaces any visual coherence regression caused by mode-switching
  mid-doc.

**Procedure:** identical to A and B above. The acceptance bar for this
render is that the mode switches feel intentional (cut to a stick
beat for an abstract callout, then back to the scene world for the
narrative continuation) and not jarring.

---

## 2. A/B grading rubric

Place the real Zenn clip and the rendered clip side by side. For each
of the three test renders, score every axis on a 1-3 scale:

- **1 (visibly different):** A reviewer can tell at a glance which is
  the real Zenn and which is the render.
- **2 (subtly different):** The reviewer needs to look closely;
  knowing which is which they can spot the gap but a casual viewer
  would miss it.
- **3 (indistinguishable):** A casual viewer cannot tell.

The PR 7 acceptance bar is **median score >= 2.5 across all axes for
all three renders**. Below that, ship a follow-up PR (PR 7.5+) to fix
the lowest-scoring axes and re-run.

### 2.1 Line and shape

- [ ] Line weight matches (Zenn's lines are uniform-thickness,
  digital-clean, no pen jitter)
- [ ] Character anatomy matches (circle head, dot eyes, stick body
  with mitten hands)
- [ ] Background color bands match (sky-on-top, ground-on-bottom for
  Mode B outdoor scenes)

### 2.2 Color

- [ ] Mode A: pure white background reads correctly, grey ground
  baseline strip is at the right tone
- [ ] Mode B: sky color, ground color, character flat fills match
  Zenn's palette
- [ ] Red labels read as Zenn red (not orange or maroon)
- [ ] Yellow highlighter stripe sits behind the text at the right
  opacity

### 2.3 Typography

- [ ] Label text feels hand-lettered (not too clean, not too messy)
- [ ] Label sits at the top of the frame (not bottom-third like a
  default LowerThird)
- [ ] Highlighter `[hl]` markers render as inline yellow stripes,
  not as visible markup text

### 2.4 Pacing

- [ ] Median shot length matches Zenn's measured 2.8 s for Mode B and
  4.3 s for Mode A
- [ ] Hard cuts feel snappy (not crossfaded into mush)
- [ ] canvas_reveal layers feel like the canvas is being drawn IN
  (not flickering or re-painting)

### 2.5 Character persistence

- [ ] The same drawn character appears across 5+ shots without
  identity drift
- [ ] The world background stays visually coherent across shots
- [ ] Recurring props (when the LLM emits them) reuse the same PNG

### 2.6 Audio sync (do this pass after the visual pass is green)

- [ ] Label pops sync with word onsets (the highlighter appears as
  the word is spoken, not after)
- [ ] Hard cuts land on script-pivot moments, not mid-clause

---

## 3. Triage process

When any acceptance gate fails:

1. **Save the artifact.** Take a screenshot or short clip of the
   failure side-by-side with the Zenn reference. File it under
   `_plans/2026-06-10-zenn-v1-qa-pass-findings/` with a timestamped
   filename.
2. **Identify the layer.** Which file is responsible for the failure?
   - Wrong line weight in the AI image -> style suffix in
     `src/lib/production-doc-styles.ts`
   - Wrong color band -> WORLD_PALETTE_DEFAULTS in
     `src/lib/auto-pipeline/stages/generate-zenn-v1-images.ts` and
     `src/remotion/scenes/ZennScene.tsx` (both tables must stay in
     sync)
   - Wrong label color or position -> ZennLabelOverlay in
     `src/remotion/scenes/ZennScene.tsx`
   - Pacing off -> median_shot_seconds default in ZENN_V1_DEFAULTS
     OR the mixing_rules PACING section
   - Character drift -> character bank prompt in
     `buildCharacterBankPrompt` OR the doc-level
     `zenn_v1_character_descriptions` content
3. **Fix in a PR.** Reproduce the failure in a unit test where
   possible. The plan section 9 testing table lists every load-bearing
   helper - extend the relevant test file.
4. **Re-render the affected video only.** Don't burn budget
   re-rendering all three.

---

## 4. Decision gate

After the three renders are graded:

- **All three at median score >= 2.5:** zenn_v1 is production-ready.
  Merge the QA findings doc, update the plan section 12 PR 7 row to
  "completed", announce internally.
- **One or two below 2.5:** ship a PR 7.5 targeting the failing axes.
  Re-grade only the affected axis on each render.
- **All three below 2.5:** stop. The foundation has a systemic issue
  that needs a council-style review before further investment. Don't
  burn more budget chasing fixes.

---

## 5. Cost log (fill in after each render)

| Render | Topic | Total cost | LLM | Image gen | Notes |
|--------|-------|-----------|-----|-----------|-------|
| A (Mode B) | | | | | |
| B (Mode A canvas-reveal) | | | | | |
| C (Mixed) | | | | | |
| **Total** | | | | | |

The plan section 11 budgeted $10-20 per video. Numbers materially
outside that range need investigation before signing off the gate.

---

## 6. References

- Parent architecture plan: `_plans/2026-06-10-zenn-v1-style.md`
- Zenn reference videos: `refs/zenn/*.mp4`
- Frame grids and hi-res analysis: `refs/zenn/_analysis/`
- Settings table: plan section 8
- Observability log namespaces: plan section 7
- Phasing (this is PR 7 of 7): plan section 12
