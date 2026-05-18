# 2026-05-18 — Deep analyzer fidelity eval (Phase 0)

**Date:** 2026-05-18
**Status:** Draft — needs three reference video URLs filled in by operator before it can be run

**Parent plan:** [2026-05-18-youtube-deep-analyzer.md](2026-05-18-youtube-deep-analyzer.md)

## Why this exists

Council's "one thing to do first." Without a way to grade the analyzer's output we cannot tell if Option 1 (single Gemini call) is good enough or whether we need to graduate to Option 2 (specialist stack). Architecture decisions without an eval are unfalsifiable.

This doc is the scorecard. Run it after Phase 2 ships, against three hand-picked reference videos of clearly different styles. Decide ship-or-iterate from the result.

## The three reference archetypes

The three videos must span the visual + audio space the analyzer needs to handle. Pick one of each archetype. Keep each between **5 and 15 minutes** so the eval is fast to run.

Why these three specifically: each archetype stresses a different part of the analyzer's output schema. If all three pass, the analyzer covers most YouTube content. If one fails, you know exactly which axis to specialise on (the fallback path in the plan).

### Reference A — Explainer with cinematic B-roll (Veritasium-style)
**Tests:** `style_packs` returning ≥2 packs (talking-head + B-roll, often + animated-diagram); `voice_style` with deliberate prosody; `typography_and_overlays` for on-screen captions; `suggested_ai_image_suffix` capturing the "considered, cinematic, slow zooms, muted palette" identity.

**Suggested anchor:** Veritasium — recent long-form science-explainer with strong B-roll cinematography. As of May 2026, *How One Company Secretly Poisoned the Planet* (the PFAS exposé) is the canonical recent example, but any 8-20 minute Veritasium / Wendover Productions / Vox Earworm video with multiple visual modes works.

**Operator action:** find a real Veritasium (or equivalent) URL from the last 12 months on the channel and paste it here:

- **URL:** `TODO_OPERATOR_FILL_IN`
- **Why this one (one sentence):** `TODO_OPERATOR_FILL_IN`

### Reference B — Fast-cut handheld vlog (Casey Neistat / MrBeast-style)
**Tests:** `pacing.avg_scene_seconds` on very short scenes; `camera_grammar` for mixed handheld + drone + GoPro; `voice_style` for conversational narration; the analyzer's ability to identify that ONE pack covers most of the runtime rather than spawning a pack per cut.

**Suggested anchor:** Casey Neistat — *Make It Count* (2012 Nike collab) is the canonical handheld-cinematography reference; widely discussed in the cinematography press, still up on the channel, fits the 5-minute window. Any of Casey's vlogs from his 534-day daily-vlog run also works. MrBeast challenge videos are a louder variant of the same archetype.

**Operator action:**

- **URL:** `TODO_OPERATOR_FILL_IN`
- **Why this one (one sentence):** `TODO_OPERATOR_FILL_IN`

### Reference C — Animated explainer (Kurzgesagt-style)
**Tests:** the analyzer on content that has NO live-action footage at all. `color_palette` (intentional flat-design palette); `voice_style` ≠ null (Kurzgesagt always has narration); `suggested_ai_image_suffix` describing an animated style rather than a photographic one. This is the test that exposes whether the analyzer can output prompts that drive AI illustration models, not just photoreal generation.

**Suggested anchor:** Kurzgesagt — In a Nutshell. Channel has 24M+ subscribers as of November 2025, 310+ videos, consistent flat 2D + 3D animation style. Any of their 8-15 minute videos works (e.g. *The Egg*, *The Most Powerful Computers*, *What If the Sun Disappeared*).

**Operator action:**

- **URL:** `TODO_OPERATOR_FILL_IN`
- **Why this one (one sentence):** `TODO_OPERATOR_FILL_IN`

## The "golden answer" per video

Before running the analyzer, the operator hand-writes what a perfect output would say for each of the load-bearing fields. Roughly two sentences per field, written from watching the video for ~2 minutes. This is the ground truth.

Fill these in BEFORE looking at the analyzer's output, otherwise the eval is anchored.

### Golden answer table — Reference A

| Field | Operator's golden answer |
|---|---|
| `style_pack.overall_look` | _what the visual identity actually is_ |
| `style_pack.suggested_ai_image_suffix` | _the prompt suffix you would type by hand to make a new image in this style_ |
| `style_pack.color_palette` | _the 3-5 colors / palette description_ |
| `style_pack.lighting` | _the lighting character_ |
| `style_pack.camera_grammar` | _typical shot types and camera moves_ |
| `style_pack.typography_and_overlays` | _what on-screen text looks like_ |
| `style_pack.pacing.avg_scene_seconds` | _your estimate in seconds_ |
| `style_pack.voice_style.pace` + `energy` + `register` | _e.g. "slow / low / authoritative"_ |
| `strategic_report.hook.what_works` | _why the first 15s holds attention_ |
| `strategic_report.standout_techniques` | _top 3 techniques worth copying_ |

(Duplicate this block for References B and C when filling in.)

### Golden answer table — Reference B

(same fields as above, filled in for the vlog)

### Golden answer table — Reference C

(same fields as above, filled in for the cinematic piece)

## The scorecard

After the analyzer runs on each video, grade each field against the golden answer using this rubric:

- **Pass** — analyzer's output captures the same substance as the golden answer. Wording differs, intent matches. An operator handed the analyzer's value blind would arrive at the same prompt.
- **Partial** — analyzer's output is in the right direction but misses something load-bearing, OR adds invented detail that isn't supported by the video.
- **Fail** — analyzer's output is wrong, generic, or hallucinated. Cannot be used to drive a generation.

Score each video in a small table:

| Field | A score | B score | C score |
|---|---|---|---|
| `overall_look` | _Pass / Partial / Fail_ | | |
| `suggested_ai_image_suffix` | | | |
| `color_palette` | | | |
| `lighting` | | | |
| `camera_grammar` | | | |
| `typography_and_overlays` | | | |
| `pacing.avg_scene_seconds` | | | |
| `voice_style` (whole sub-object) | | | |
| `hook.what_works` | | | |
| `standout_techniques` | | | |

## The ship gate

The fields above are weighted as follows:

**Load-bearing fields (must work):**
- `overall_look`
- `suggested_ai_image_suffix`
- `voice_style` (whole sub-object)
- `hook.what_works`

If a video gets `Pass` on all four load-bearing fields, that video is a "Yes."
If it gets `Pass` on three and `Partial` on one, that's still a "Yes."
Anything else is a "No."

**Decision rule:**
- 3 of 3 references are "Yes" — ship as-is.
- 2 of 3 are "Yes" — ship with a noted limitation (the one that failed tells us where to specialize later).
- 0 or 1 of 3 are "Yes" — do NOT ship. Iterate the Gemini prompt (the file at [src/lib/analyzer/gemini-analyze.ts](src/lib/analyzer/gemini-analyze.ts)). Common failure modes to fix:
  - Output is too generic ("cinematic, dramatic, professional") — sharpen the prompt with concrete few-shot examples of good `suggested_ai_image_suffix` values.
  - Output hallucinates details not in the video — add an explicit "if you cannot see this in the video, write 'unknown'" instruction.
  - Output describes individual scenes well but `overall_look` is weak — restructure the schema so `overall_look` is generated AFTER all scenes, with the scene list passed back into a final reasoning step.

If two iterations of the prompt still fail the gate, that's the signal to graduate to Option 2 (add AssemblyAI for transcript + audio analysis as a second leg).

## Cost of running this eval

Three 10-min videos at ~$0.40 each = **~$1.20** total to run the eval once. Negligible. Re-run as many times as needed while iterating the prompt.

## Open

- Operator picks the three URLs and writes the golden-answer tables before Phase 2 ships. That way the moment the analyzer is live we can grade it the same day.
- If the operator can't decide between two candidates for an archetype, pick the one with **clearer artistic intent** — a video where you can articulate why it looks the way it looks. Ambiguous videos make for ambiguous evals.
