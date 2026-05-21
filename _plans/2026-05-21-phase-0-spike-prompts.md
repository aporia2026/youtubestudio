# Phase 0 — Doodle style spike prompts

**Date:** 2026-05-21
**Status:** Awaiting user review before the spike runs
**Source:** [Every Major Cyber Attack in History](../production-doc-every-major-cyber-attack-in-history-expl.csv) production doc (60+ rows)
**Refs:** [public/style-refs/Doodle-explainer/](../public/style-refs/Doodle-explainer/) (5 images)
**Cost estimate:** 4 models × 10 prompts = 40 generations × ~$0.05 avg ≈ **$2 total**

## Adjustments made to the source material

The production-doc rows were each ~200 words. I cut them down so the spike actually tests what we want:

1. **Stripped the 60-word style suffix** — every row ended with `"minimalist hand-drawn stick figure doodle, thick uneven black outlines, simple circular heads, plain white background, flat shadowless lighting, vibrant saturated accent colors, 2D flat vector animation style, clean crisp outlines, motion-graphics aesthetic, NOT photorealistic, NOT a photograph"`. With refs supplying the aesthetic, that suffix is redundant. If the spike shows refs work, we keep it stripped in production and save tokens on every generation forever.
2. **Removed brand names from AI-render scope** — your `doodle_explainer.mixing_rules` already says the AI should leave a blank rectangle and let the editor composite real brand logos on top. Replaced "Microsoft Exchange wordmark", "Yahoo logo", "Lockheed Martin building" etc with neutral placeholders ("a server panel with a glowing logo space", "an office building").
3. **Skipped title-card rows** — pure typography, not image gen.
4. **Picked for variety, not coverage** — 10 prompts spanning single-character, multi-character, action, emotional, infographic, geopolitical, industrial, abstract, and viewer-facing finale. Each one stresses a different failure mode so blind-ranking surfaces which model wins on each axis.

## Reference image order (matters for single-ref models)

Position 0 carries the most weight for Ideogram Remix (single-ref) and acts as the dominant anchor everywhere else. Ordered cleanest → most complex:

| pos | file | rationale |
|---|---|---|
| 0 | `stick-figure-magnifying-glass-phone.png` | Cleanest single-character pose; canonical doodle proportions |
| 1 | `stick-figure-hacker-laptop.png` | Single character at a device — most common scene type in cyber explainer |
| 2 | `stick-figure-tracked-by-location.png` | Single character with strong emotional read (worried face) |
| 3 | `stick-figure-hacker-deceives-guard.png` | Two characters, complex composition with desk/computer |
| 4 | `stick-figure-soldiers-running.png` | Two characters in action, desert background |

## The 10 prompts

### p01 — Character study, single figure, emotion
**Tests:** facial expression on a doodle stick figure, simple prop interaction
**Source:** row 0:09
```
Close-up of a stick figure with a curious face gently pressing a small button labeled TEST, followed by a huge red warning burst exploding outward; figure leans back in alarm.
```

### p02 — Single character + workstation + abstract prop
**Tests:** stick figure at a screen, with a separate floating concept element nearby
**Source:** row 0:11
```
A stick figure operator at a desk looking at a green-text terminal window; beside them a labeled box "FINGERD" splits open and a dictionary of common passwords floats upward.
```

### p03 — Two figures, manipulation pose
**Tests:** two stick figures interacting, arrows-from-one-to-other social-engineering visual
**Source:** row 0:21
```
Two stick figures: one in a sneaky pose handing a fake paper message to the other who sits at an old computer; arrows lead from the message to the second figure's head.
```

### p04 — Wide chaos infographic
**Tests:** many small elements in one frame, smoke/red overload, big number
**Source:** row 0:16
```
Wide scene: a row of computer terminals bent over with smoke puffs and red overload symbols; a giant "$10 MILLION" cleanup bill rising in the center; an alarm bell ringing above a sleeping internet globe just waking up with wide eyes.
```

### p05 — Geopolitical world map with intrusion lines
**Tests:** map composition + multiple labels + connection lines
**Source:** row 0:36
```
A wide simple world map with California on the left and a country on the right, each with a teenage stick figure at a computer; bright intrusion lines connect both into a central US military network shield with a trophy floating above it.
```

### p06 — Industrial sabotage, mechanical objects
**Tests:** detailed machinery in doodle style + a worm character
**Source:** row 2:12
```
Wide industrial scene: tall centrifuges spinning, some breaking apart with red sparks; a control panel beside them being pierced by a cartoon worm; a small "1100 Hz" gauge flashing red.
```

### p07 — Split-screen, emotional + technical
**Tests:** two-panel composition, sad-hospital tone next to globe-with-updates tone
**Source:** row 5:34
```
Split screen — on the left: a sad hospital waiting area with a patient on a stretcher, distressed medical staff, a ticking clock; on the right: a globe surrounded by laptops receiving bright update arrows from above.
```

### p08 — Big-number motion-graphics infographic
**Tests:** infographic layout with skull warning + map spread + multiple counters
**Source:** row 5:24
```
Infographic: a computer monitor at center showing a red skull ransomware warning; bright infection lines spreading across a simple world map to many countries; counters reading "200,000 MACHINES" and "150 COUNTRIES"; a giant "$4 BILLION" burst on the right.
```

### p09 — Symbolic supply-chain metaphor
**Tests:** abstract metaphor in doodle style, snapping chain visual, hidden figure
**Source:** row 5:47
```
Symbolic scene: a long supply chain made of linked software boxes, trucks, ships, and office servers snapping apart in the middle; behind a fake ransom note a hidden military-style figure peers out with a sly grin.
```

### p10 — Viewer-facing finale
**Tests:** "this is YOU" composition, three icons in foreground, target reticle
**Source:** row 6:44
```
Closing scene: a single stick figure viewer at center with a red target reticle hovering over their head; three large safety icons in the foreground — a clockwise UPDATE arrow, a BACKUP cloud, and a QUESTION-MARK EMAIL.
```

## What the blind rank measures

After all 40 outputs land in the grid, you rate each on:
1. **Style match** — does this look like the same artist drew it as the refs? (0–5)
2. **Composition** — is the scene readable, balanced, motion-graphics-friendly? (0–5)
3. **Brief fidelity** — did the model render what the prompt actually described, or did it ad-lib? (0–5)

The model that scores highest on **style match averaged across all 10 prompts** wins the slot as v1 default. If two models tie on style but one wins on composition, that's the tiebreaker.

## Open questions for you before I fire the spike

1. **Are these 10 the right slice?** I picked for variety. If you'd rather lean harder on (say) infographic scenes because that's 70% of your real content, tell me and I'll re-curate.
2. **Should I add an 11th** — a row that exists in your existing content where the current `doodle_explainer` prompt-only approach already drifts the most? That'd be the strongest "did refs fix it?" test.
3. **Pass the existing 60-word style suffix in too, as a 5th comparison column?** Cost goes from $2 to $2.50. Tradeoff: confirms empirically whether refs+suffix > refs alone. I'd skip it (we can re-add the suffix in production if needed without re-running the spike) but flagging.

Reply with go / changes / additional prompts, and I'll wire up the spike runner.
