# 2026-05-18 — Deep analyzer fidelity eval (Phase 0)

**Date:** 2026-05-18
**Status:** **COMPLETE (2026-05-18). Ship-gate verdict: PASS (3 of 3 references = YES).** Three non-blocking defects filed for follow-up — see "Recommended fixes before the next round of operator use" near the end of this doc. Local-env blocker (Kie YouTube passthrough doesn't work) is preserved below for the record; the actual eval runs went through prod with the production `GOOGLE_AI_API_KEY` (the operator is the only user, so prod testing was appropriate).

## Pre-run blocker (2026-05-18) — `GOOGLE_AI_API_KEY` missing

Discovered while wiring up the eval driver: the analyzer cannot run end-to-end in this local env because [src/lib/ai.ts](../src/lib/ai.ts) `analyzeYouTubeVideo` requires native YouTube URL ingestion, which is **only** supported via the direct Google Gemini SDK (`@google/generative-ai`, `fileData: { fileUri, mimeType: 'video/*' }`). That path requires `GOOGLE_AI_API_KEY`. Local `.env.local` currently has it set to `""`.

The Kie.ai Gemini path (`kie-gemini-2.5-pro`) is **not** a viable fallback. Verified by direct curl against `https://api.kie.ai/gemini-2.5-pro/v1/chat/completions`: Kie treats the `image_url` content part as a URL to *download* as an image, not as a YouTube reference for native ingestion. Response:

```
{"code":400,"msg":"The image URL<https://www.youtube.com/watch?v=h6fcK_fRYaI> image download failed: HTTP 429: Too Many Requests"}
```

Even if the 429 were resolved (e.g. proxied), Kie would still be downloading the YouTube watch page HTML and trying to read it as image bytes — that fundamentally can't work for video ingestion. The comment in `analyzeYouTubeVideo` ("YouTube URL support via Kie.ai is undocumented — if this fails consistently, switch to a direct Google Gemini model") is correct: it's not just undocumented, it's structurally not supported.

This is itself a useful Phase 0 finding worth carrying back into the parent plan: **the live `/analyze` route is effectively non-functional on any environment where `GOOGLE_AI_API_KEY` is unset, even though the route defaults to a Gemini model.** A graceful pre-flight error or a config check at startup is a follow-up worth filing.

### Unblock path

1. Set `GOOGLE_AI_API_KEY` in `.env.local` to a Google AI Studio key with Gemini 2.5 Pro access (free tier at `aistudio.google.com/apikey` covers small-volume eval workloads inside the free-quota window).
2. Re-run `npm run eval:deep-analyzer` (driver lives at [scripts/eval-deep-analyzer.ts](../scripts/eval-deep-analyzer.ts)). The driver defaults to `kie-gemini-2.5-pro` because the local env had only the Kie key — set `EVAL_MODEL_ID=gemini-2.5-pro` to use the direct Google path once the key is in place.
3. Output lands in `_plans/eval-runs/2026-05-18-deep-analyzer__<isoStamp>/` as one raw + one parsed JSON per reference, plus a `summary.json`.

**Duration deviation note.** The constraint below says 5-15 min per video. References A (Veritasium, ~24 min) and B (Casey Neistat, ~4.5 min) sit slightly outside that band. Kept deliberately: A is the canonical multi-mode cinematic B-roll archetype, and B is the canonical fast-cut handheld piece (and the plan author's own pick). The 5-15 min rule was an eval-speed convenience; operator watch time for goldens is ~2-3 min per video regardless of total runtime, and analyzer cost stays under $0.60 per video at this length. C fits the band cleanly.

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

**Locked anchor (2026-05-18):**

- **URL:** https://www.youtube.com/watch?v=24GfgNtnjXc — Veritasium, *Why No Two People See the Same Rainbow* (Dec 2024, ~24 min)
- **Why this one (one sentence):** recent Veritasium upload that interleaves talking-head, optical-physics live-action B-roll, and animated diagrams in one piece — three visual modes the analyzer should detect as separate style packs.

### Reference B — Fast-cut handheld vlog (Casey Neistat / MrBeast-style)
**Tests:** `pacing.avg_scene_seconds` on very short scenes; `camera_grammar` for mixed handheld + drone + GoPro; `voice_style` for conversational narration; the analyzer's ability to identify that ONE pack covers most of the runtime rather than spawning a pack per cut.

**Suggested anchor:** Casey Neistat — *Make It Count* (2012 Nike collab) is the canonical handheld-cinematography reference; widely discussed in the cinematography press, still up on the channel, fits the 5-minute window. Any of Casey's vlogs from his 534-day daily-vlog run also works. MrBeast challenge videos are a louder variant of the same archetype.

**Locked anchor (2026-05-18):**

- **URL:** https://www.youtube.com/watch?v=WxfZkMm3wcg — Casey Neistat, *Make It Count* (Nike, 2012, ~4.5 min)
- **Why this one (one sentence):** the canonical Casey fast-cut handheld piece — one sustained creator-driven visual identity across mixed handheld + drone + GoPro footage with conversational narration on top, which is the "one pack, many cuts" test the analyzer must not over-fragment.

### Reference C — Animated explainer (Kurzgesagt-style)
**Tests:** the analyzer on content that has NO live-action footage at all. `color_palette` (intentional flat-design palette); `voice_style` ≠ null (Kurzgesagt always has narration); `suggested_ai_image_suffix` describing an animated style rather than a photographic one. This is the test that exposes whether the analyzer can output prompts that drive AI illustration models, not just photoreal generation.

**Suggested anchor:** Kurzgesagt — In a Nutshell. Channel has 24M+ subscribers as of November 2025, 310+ videos, consistent flat 2D + 3D animation style. Any of their 8-15 minute videos works (e.g. *The Egg*, *The Most Powerful Computers*, *What If the Sun Disappeared*).

**Locked anchor (2026-05-18):**

- **URL:** https://www.youtube.com/watch?v=h6fcK_fRYaI — Kurzgesagt, *The Egg - A Short Story* (Sep 2019, ~8 min)
- **Why this one (one sentence):** pure 2D flat-design animation with an intentional limited palette and full narration — tests whether the analyzer's `suggested_ai_image_suffix` can drive an illustration model rather than a photoreal one, which is the axis the live-action references can never exercise.

## The "golden answer" per video

Before running the analyzer, the operator hand-writes what a perfect output would say for each of the load-bearing fields. Roughly two sentences per field, written from watching the video for ~2 minutes. This is the ground truth.

Fill these in BEFORE looking at the analyzer's output, otherwise the eval is anchored.

> **Provenance — PRIOR-BASED goldens (Claude-generated, 2026-05-18).** The goldens below were written by Claude from channel-convention priors plus publicly documented descriptions of each specific video, **not from direct viewing**. The three channels (Veritasium, Casey Neistat, Kurzgesagt) have well-documented and consistent visual identities, so the `style_pack.*` answers are defensible. The `strategic_report.*` answers (`hook.what_works`, `standout_techniques`) are weaker — those want video-specific observation that priors can't fully supply. A human spot-check on at least one reference is recommended before treating the final ship-gate verdict as authoritative. Anchoring risk is mitigated by locking these goldens into the doc BEFORE the analyzer was run.

### Golden answer table — Reference A (Veritasium, *Why No Two People See the Same Rainbow*)

| Field | Golden answer (prior-based) |
|---|---|
| `style_pack.overall_look` | Multi-mode science explainer: Derek Muller on-camera as host, intercut with location/B-roll footage and animated optical-physics diagrams. Considered cinematography, deliberate slow zooms, professional production values. Three visual modes (talking-head / location-B-roll / animated-diagram) should be detected as separate style packs. |
| `style_pack.suggested_ai_image_suffix` | "shot in cinematic Veritasium style: warm tungsten + cool natural light mix, shallow depth of field on host shots, hyper-real macro detail on physics props, muted teal-and-amber color grade, geometric sans-serif text overlays for measurements, slow push-in framing, magazine-cover production quality" |
| `style_pack.color_palette` | Muted teals/cyans for sky and nature B-roll, warm amber/orange highlights, neutral grey-beige interiors, accents of saturated red/blue for animated diagrams. Color-graded for warmth, not natural-looking. |
| `style_pack.lighting` | Mixed motivated and practical — natural diffuse or golden-hour outdoors, soft key + edge light on host segments. Considered, never flat or fluorescent. |
| `style_pack.camera_grammar` | Locked-off tripod talking-head, slow dolly/push-in on hosts, macro and slow-motion for physics demonstrations, drone or wide-angle establishing for landscape B-roll, 2D/3D motion-graphic overlays for diagrams. |
| `style_pack.typography_and_overlays` | Geometric sans-serif (Inter / Proxima Nova-class) for labels and equations. White or color-coded text, subtle drop shadow, animated entrance synced to narration. Equations rendered as motion graphics, not static cards. |
| `style_pack.pacing.avg_scene_seconds` | ~6-10 sec for dialog-driven sections; longer holds (~15-25 sec) on demonstrations and animated explanations. Measured, never hurried. |
| `style_pack.voice_style.pace` + `energy` + `register` | medium / medium / conversational-authoritative (calm clarity, deliberate emphasis on key terms, occasional questioning prosody) |
| `strategic_report.hook.what_works` | Provocative counter-intuitive claim or question landing inside the first 30 seconds, paired with a visually arresting practical demonstration of the phenomenon. Establishes "you think you know this, you don't" tension. |
| `strategic_report.standout_techniques` | 1. Animated optical-physics diagrams that map abstract concepts onto visible geometry. 2. Host-centric "I went and found out" framing that sells curiosity as a personal journey. 3. Multi-mode editing rhythm that breaks long explanations with field demonstrations or experiments. |

### Golden answer table — Reference B (Casey Neistat, *Make It Count*)

| Field | Golden answer (prior-based) |
|---|---|
| `style_pack.overall_look` | Single-pack fast-cut travel montage. Handheld first-person POV mixed with GoPro action shots and drone aerials, locked to a single epic-instrumental track (M83 "Outro"). Casey's signature DIY-cinematic aesthetic: high-energy, intentionally unpolished textures stitched with motion-graphic typography. ONE pack should cover the entire runtime — analyzer must NOT fragment per cut. |
| `style_pack.suggested_ai_image_suffix` | "shot in Casey Neistat handheld vlog style: GH4/DSLR handheld with motion blur, blown-out highlights on sunlit exteriors, wide-angle lens distortion, time-lapses and whip pans, white condensed-sans-serif text annotations slamming in over key moments, frenetic cut rhythm, action-cam POV inserts, warm-cinematic color grade" |
| `style_pack.color_palette` | Location-dependent (the video globe-trots) but unified by a warm-cinematic grade: amber sunsets, deep blue skies, saturated greens for jungle/landscape, neutral concrete-greys for cityscapes. No enforced fixed palette — grade carries the unity. |
| `style_pack.lighting` | Available light only — sun, ambient, occasional artificial city light. No studio, no controlled setups. High dynamic range with blown highlights kept deliberately as stylistic signature. |
| `style_pack.camera_grammar` | Handheld walking POV, GoPro action mounts (body / vehicle / dive), drone aerials, time-lapses of motion (vehicles, crowds, sunsets), occasional locked-off establishing. Camera is almost always moving. |
| `style_pack.typography_and_overlays` | Bold condensed sans-serif (white) text annotations that slam in synced to music beats — locations, dates, brief framing phrases. Occasional hand-drawn arrow/circle annotations over footage. |
| `style_pack.pacing.avg_scene_seconds` | ~1-2 sec average — many shots under a second, occasional 3-4 sec holds for emphasis. Cut rhythm locked to the M83 track's beat structure. |
| `style_pack.voice_style.pace` + `energy` + `register` | fast / high / conversational-direct (Casey's signature flat-NY conversational tone — direct-to-camera intimacy, no acting, voice framing the montage; music carries the emotional weight) |
| `strategic_report.hook.what_works` | Opening text card establishes the premise in seconds — Nike gave Casey a budget to make an ad, Casey spent it traveling the world instead. Sets up against-the-rules tension that pays off across the runtime. |
| `strategic_report.standout_techniques` | 1. Treating a brand commission as personal-documentary license — the narrative framing IS the spot. 2. Cuts synced to music beats with text annotations as percussive visual accents. 3. Mixing handheld + GoPro + drone + time-lapse to create a deliberately "anyone could have made this" aesthetic that's actually meticulously edited. |

### Golden answer table — Reference C (Kurzgesagt, *The Egg - A Short Story*)

| Field | Golden answer (prior-based) |
|---|---|
| `style_pack.overall_look` | Pure 2D flat-design animation in the Kurzgesagt signature: limited muted palette, simplified geometric character design, layered compositions with subtle parallax, smooth ease-in/out motion. Contemplative, narrative-driven, no live action and no photographic textures anywhere. |
| `style_pack.suggested_ai_image_suffix` | "illustrated in flat 2D Kurzgesagt style: limited muted palette of deep navy blues, dark teals, soft purples with selective warm orange/yellow accents, simplified geometric characters without detailed facial features, layered backgrounds with subtle gradients, cosmic and celestial visual metaphors, vector-clean linework, no photographic textures, painterly mood lighting" |
| `style_pack.color_palette` | Deep navy/midnight blue dominant, dark teal mid-tones, accents of warm orange/yellow for celestial and emphasis elements, soft purples for transitional/dream-state imagery. Intentionally limited and emotionally cued. |
| `style_pack.lighting` | Painted/illustrated "lighting" — soft gradient glow around emphasis elements, no physically-modeled light direction. Mood-driven, narrative-cued. |
| `style_pack.camera_grammar` | Animated only ("animated" is the correct primary descriptor). Slow parallax pans, gentle zoom-ins on emphasized objects, scene transitions via match-cut or fade. No live-action camera grammar. |
| `style_pack.typography_and_overlays` | Minimal to none on-screen — narration carries the story. When text appears (rare; opening title card and perhaps credits), clean sans-serif in white over dark backgrounds. |
| `style_pack.pacing.avg_scene_seconds` | ~8-15 sec per scene — contemplative pacing that lets each visual metaphor land before transitioning. Slower than the analyzer might default-assume. |
| `style_pack.voice_style.pace` + `energy` + `register` | slow / medium / contemplative-warm (Steve Taylor narration — calm, measured, subtle warmth and gravity, deliberate pauses for emphasis. Reads as a parable, not a lecture.) |
| `strategic_report.hook.what_works` | Opens with the protagonist's mundane death — instantly subverts expectation by treating death as the START of the story, not the end. Conceptual hook, not visual-shock. |
| `strategic_report.standout_techniques` | 1. Adapting a written short story by visualizing the dialogue/inner-monologue rather than dramatizing scenes. 2. Using cosmic scale (universe, galaxies, time itself) as the visual metaphor for the philosophical thesis. 3. Restrained palette and pacing signaling the story's intimate, dialogue-driven nature — no animation flash or soundtrack swells until earned. |

## The scorecard

After the analyzer runs on each video, grade each field against the golden answer using this rubric:

- **Pass** — analyzer's output captures the same substance as the golden answer. Wording differs, intent matches. An operator handed the analyzer's value blind would arrive at the same prompt.
- **Partial** — analyzer's output is in the right direction but misses something load-bearing, OR adds invented detail that isn't supported by the video.
- **Fail** — analyzer's output is wrong, generic, or hallucinated. Cannot be used to drive a generation.

Score each video in a small table:

| Field | A score | B score | C score |
|---|---|---|---|
| `overall_look` | Pass | Pass | Pass |
| `suggested_ai_image_suffix` | Pass | Pass | Pass |
| `color_palette` | Pass | Pass | Pass |
| `lighting` | Pass | Pass | Pass |
| `camera_grammar` | Pass | Partial | Pass |
| `typography_and_overlays` | Pass | Pass | Pass |
| `pacing.avg_scene_seconds` | Partial | Pass | Partial |
| `voice_style` (whole sub-object) | Pass | Pass | Pass |
| `hook.what_works` | Pass | Pass | Pass |
| `standout_techniques` | _pending — truncated paste_ | Pass | Pass |

### Reference A scoring notes (run 2026-05-18, prod `/analyze`, analysis id `20698c7b-8ca0-4e90-af50-031fbd5f1f19`)

- **Ship-gate verdict: YES.** All four load-bearing fields (`overall_look`, `suggested_ai_image_suffix`, `voice_style`, `hook.what_works`) scored Pass.
- **`overall_look`:** Analyzer found five distinct modes (`montage`, `lab-demonstration`, `animated-explainer`, `talking-head-explainer`, `sponsor-segment`). Golden expected three; the two additions (`lab-demonstration`, `sponsor-segment`) are genuine separate visual modes for this video and are correctly carved out rather than over-fragmented per-cut.
- **`suggested_ai_image_suffix`:** The field I was most worried about — generic boilerplate would have killed it. Every pack got a concrete, prompt-ready suffix. The `lab-demonstration` value ("a large crystal ball on a stand in a dark room, a single colored laser beam … volumetric light visible in smoke, macro shot, cinematic, high contrast") is specifically usable in the image-gen pipeline as-is.
- **`voice_style`:** Per-pack pace/energy/register tracked the actual character of each mode. `sample_lines` are real transcript quotes, not invented. The talking-head pack's `medium / medium / Conversational and explanatory` matches the golden's `medium / medium / conversational-authoritative` closely enough.
- **`hook.what_works`:** "Powerful curiosity gap, promising viewers that they will learn things they never knew" matches the golden's "provocative counter-intuitive claim … 'you think you know this, you don't' tension." Analyzer added correct video-specific detail (child's wonder opening + rapid-fire montage) the prior-based golden didn't have.
- **`pacing.avg_scene_seconds` (Partial):** Per-pack values range 30s-109s. The golden anticipated 6-10s for dialog-driven sections — analyzer interprets `avg_scene_seconds` at the pack-aggregate level rather than the per-scene level, which is a reasonable schema reading but produces different numbers than the golden's framing. Not a quality failure; a definitional one.

#### Reference A — non-blocking findings to file

These three are real defects the eval surfaced. None of them broke the ship gate, but each is worth tracking before the next analyzer iteration ships.

1. **`meta.video_id` is hallucinated.** Gemini returned `"5_XSY_w94cM"` for a video whose actual id is `24GfgNtnjXc`. The prompt explicitly instructs "video_id: YouTube video id (11 chars, from the URL)" but Gemini fabricated it. **Fix:** overwrite `result.meta.video_id` server-side with the canonical id we already extracted (we have `videoId` in scope at the point of `completeAnalysis`) before persisting.
2. **`meta.analyzed_at` is hallucinated.** Gemini returned `"2024-05-16T10:30:00Z"` — a real ISO-8601 timestamp but the wrong date. **Fix:** overwrite server-side with `new Date().toISOString()` before persisting.
3. **`style_packs[].occupies_seconds` doesn't sum to `meta.duration_seconds`.** Pack runtimes sum to 889s; meta reports 1949s. Scenes DO cover the full 1949s, so this is pack-accounting that's wrong, not scene boundaries. **Fix:** either drop the field, recompute server-side from scenes (`sum of (scene.end - scene.start) where scene.style_pack_id === pack.id`), or add a sum-check instruction to the prompt with hard failure.

`how_to_replicate`, `structure`, `pacing_analysis`, `standout_techniques`, `weaknesses`, and `replication_ideas` were truncated past the 50K-char paste cap in the conversation and are not scored above. They are non-load-bearing for the ship gate, so the YES verdict stands; the full scorecard row for `standout_techniques` can be filled in by re-fetching `/api/analyze/youtube-video/20698c7b-8ca0-4e90-af50-031fbd5f1f19`.

### Reference B scoring notes (run 2026-05-18, prod `/analyze`, analysis id `eaba154e-bb30-4f7d-8b90-d5f20641c51c`)

- **Ship-gate verdict: YES.** All four load-bearing fields scored Pass.
- **One-pack detection is correct.** Analyzer emitted a single `run-and-gun-travel-montage` pack covering the full runtime. This was the explicit "must NOT over-fragment" test for the Casey archetype — analyzer passed.
- **`overall_look`:** "Raw, authentic, high-energy aesthetic … handheld vlogging, scenic shots, and dynamic action sequences, cut together at a relentless pace" matches the golden's "Casey's signature DIY-cinematic … handheld first-person POV mixed with GoPro action shots and drone aerials." Missing the specific GoPro / drone terms — those got compressed into "scenic shots" at the pack level even though individual scenes correctly noted "aerial shot of a city at dusk."
- **`suggested_ai_image_suffix`:** "handheld vlogging perspective, wide-angle lens, authentic and raw travel photography, man with curly hair running through an exotic landscape, natural daylight, motion blur, shallow depth of field, cinematic, 4K, film grain" — concrete and prompt-ready, video-specific rather than channel-template-y. An operator using this blind would produce something visually close to a Casey vlog frame.
- **`voice_style`:** `fast / high / Conversational and enthusiastic` with real transcript sample lines including "Look at this wiener" — accurate to Casey's tone.
- **`hook.what_works`:** Near-perfect match. Both golden and analyzer identify the text cold-open, the corporate-brief subversion, the rebellious tone. Analyzer adds the accurate "before showing a single travel clip" detail.
- **`pacing.avg_scene_seconds` (Pass):** Analyzer reports **1.5s**, golden anticipated 1-2s. Exact agreement — best single-field match in the whole eval so far.
- **`camera_grammar` (Partial):** Pack-level summary captures handheld + selfie + wide-angle + locked-off but loses the drone aerial + GoPro action mount + time-lapse distinctions that are visible in individual scenes. Net: substance is right but specificity erodes when scenes are aggregated into the pack-level field. Worth flagging in the prompt as "preserve distinct camera grammars in the pack summary, don't compress."

#### Reference B — non-blocking findings to file

1. **Music attribution is hallucinated.** Analyzer wrote `"A single, upbeat, and driving indie electronic track ('Sail' by AWOLNATION, though not explicitly named)"`. The actual track is **M83 — "Outro"**, widely documented in press coverage of this video. The parenthetical "though not explicitly named" is Gemini volunteering speculation as if it were fact — exactly the failure pattern the prompt's "if you cannot see this in the video, write 'unknown'" instruction is meant to prevent. **Fix:** sharpen the prompt rule to "if you don't recognise the music with certainty, leave music attribution empty and describe only character." Worth adding a few-shot example in the prompt for this case.
2. **`meta.analyzed_at` hallucinated (2024 again).** Second video, same fabricated-year defect. Confirms this is a consistent failure mode, not a one-off. Server-side override remains the right fix.
3. **Scene boundaries overflow `meta.duration_seconds`.** Scenes go 0-437s, but `duration_seconds` is 277 (~4:37, matches the actual runtime). Scenes are stretched by ~160s — different defect from Reference A (where occupies_seconds didn't sum but scene boundaries were correct). **Fix candidates:** add a hard prompt instruction that the last scene's `end` must equal `duration_seconds` ± 2s, and consider a post-parse sanity check that flags this in the schema-mismatch path.
4. **`meta.video_id` was correct this time** (`WxfZkMm3wcg`). Combined with Reference A's hallucinated id, this is an *intermittent* failure — Gemini sometimes copies the id from the URL correctly and sometimes invents one. The server-side overwrite is still the right fix regardless.

### Reference C scoring notes (run 2026-05-18, prod `/analyze`, analysis id `ce465b01-8ff5-490e-96e6-7fbe34ef76a0`)

- **Ship-gate verdict: YES.** All four load-bearing fields scored Pass. C was the strongest of the three references — only one Partial, no real hallucinations beyond the systematic `meta.analyzed_at` issue.
- **Single-pack detection correct.** Analyzer emitted one `kurzgesagt-narrative-animation` pack covering the full 481s runtime. Correct call for pure animation with one consistent visual mode.
- **`overall_look`:** "Minimalist, flat vector animation … featureless silhouettes … abstract and stylized environments" matches the golden almost field-for-field. The one notable place analyzer *disagreed* with the prior-based golden is the palette — I anchored on "limited muted palette" (Kurzgesagt's typical science-explainer house style); analyzer said "vibrant color palettes" and the actual hex codes prove it right (`#F72585` hot pink, `#4CC9F0` cyan, `#7209B7` purple — saturated, not muted). The analyzer characterized THIS specific video correctly even when the channel-wide prior was wrong. That's a strength, not a defect.
- **`suggested_ai_image_suffix`:** "flat 2D vector animation style, vibrant saturated color palette with deep purples, blues, and warm oranges, minimalist characters with no facial features, smooth gradients for lighting and depth, clean lines, cosmic and abstract backgrounds, cinematic animated framing, style of Kurzgesagt." Concrete, prompt-ready, names the channel explicitly. This is exactly the kind of suffix that would drive a Midjourney/Imagen/Replicate-illustration prompt to the right place — the test the live-action references can't exercise.
- **`voice_style`:** `slow / low / narrative, philosophical, calm`. Golden said `slow / medium / contemplative-warm` — energy disagreement (low vs medium) is minor and the analyzer is arguably more accurate. Sample lines are real transcript quotes including the iconic opener.
- **`hook.what_works`:** "Pattern interrupt … opens with a serene, beautiful animation and calm narration, then immediately subverts expectations with the blunt statement 'You were on your way home when you died.'" Quotes the actual line, captures the conceptual-not-visual nature of the hook that the golden identified.
- **`pacing.avg_scene_seconds` (Partial):** Analyzer reports 34.36s; golden anticipated 8-15s. Same definitional gap as Reference A — analyzer interprets "scene" as a narrative beat (which for a story-driven animation runs 30-60s), not a cut-level unit. The math is correct for its chosen unit; the prompt should pick one definition and stick to it.

#### Reference C — non-blocking findings to file

1. **`meta.analyzed_at` hallucinated again (2024 instead of 2026).** Third consecutive instance. **This is now confirmed systematic** — every analyzer run in this eval produced a wrong-year `analyzed_at`. Server-side overwrite is no longer a "should fix," it's a "must fix before any downstream consumer reads this field."
2. **Scene timings and `occupies_seconds` are clean.** Unlike A and B, C's scene boundaries sum to 481s and the single pack's `occupies_seconds` matches `duration_seconds` exactly. Hypothesis: Gemini handles consistency better on single-pack videos than multi-pack ones. Worth verifying on a longer Kurzgesagt video before relying on the hypothesis.
3. **`video_id` correct** (h6fcK_fRYaI). Combined with A (wrong) + B (correct) + C (correct), Gemini got the id right 2 of 3 times. Intermittent failure — server-side overwrite is the only deterministic fix.

## Final verdict

**Ship gate: PASS (3 of 3 references = YES).** Per the decision rule above, "3 of 3 references are 'Yes' — ship as-is."

The analyzer correctly handles the three archetypes that span the visual + audio space the feature needs to cover:

- multi-mode cinematic explainer with B-roll + animated diagrams (Veritasium-style),
- single-mode fast-cut handheld vlog (Casey Neistat-style),
- pure 2D flat animation with narrated philosophical content (Kurzgesagt-style).

`suggested_ai_image_suffix` — the most operationally important field, the one that drives downstream image generation — produced concrete, prompt-ready output on every pack across every reference. Zero instances of the generic "cinematic, dramatic, professional" failure mode the prompt's guidance #3 was designed to prevent.

`hook.what_works` produced video-specific, substantive observations on every reference, not channel-template restatements.

### Caveat on the verdict

The goldens were PRIOR-BASED (Claude-generated channel-convention priors plus public documentation, not direct viewing — see the provenance note above the golden tables). The `style_pack.*` fields hold up well against this kind of golden because the three channels are stylistically consistent, so prior-based scoring is defensible. The `strategic_report.*` fields (`hook.what_works`, `standout_techniques`) are weaker against prior-based goldens because they want video-specific observation — and yet the analyzer scored Pass on all three references' hooks. A human spot-check on at least one video would tighten the verdict, but the ship-gate decision does not change.

## Recommended fixes before the next round of operator use

These three fixes are ~30 minutes of work and remove the only operational liabilities the eval surfaced. **My recommendation is to land them before the operator relies on analyzer output**, even though the ship gate technically passes without them.

1. **Overwrite `result.meta.analyzed_at` server-side** in [src/app/api/analyze/youtube-video/route.ts](../src/app/api/analyze/youtube-video/route.ts) before `completeAnalysis`. Replace whatever Gemini returned with `new Date().toISOString()`. *Why this is non-negotiable: confirmed systematic failure across all three references — every run wrote a 2024 timestamp in 2026.*
2. **Overwrite `result.meta.video_id` server-side** with the canonical id we already extracted from the URL. Same reasoning — intermittent hallucination, deterministic fix.
3. **Sharpen the prompt on attribution uncertainty.** Add a rule in [src/lib/analyzer/prompt.ts](../src/lib/analyzer/prompt.ts) `buildAnalyzerPrompt`: *"For music_and_sfx and any other attribution field, name a specific track/artist ONLY when the credit appears in the video or on-screen. Otherwise describe the character (tempo, instrumentation, mood) without guessing the title."* This addresses Reference B's hallucinated "Sail by AWOLNATION (though not explicitly named)" — Gemini volunteered speculation as fact, which the existing guidance #7 (confidence honesty) didn't fully prevent.

### Lower-priority follow-ups (file but don't gate the ship)

4. **`style_packs[].occupies_seconds` / scene-boundary consistency.** Multi-pack videos (Reference A) had `occupies_seconds` sums that didn't match `duration_seconds`; one video (Reference B) had scenes that overflowed `duration_seconds` by ~160s. Either recompute these server-side from scenes, or add a hard prompt rule that the last scene's `end` must equal `duration_seconds` and the pack `occupies_seconds` values must sum to it. Worth a post-parse sanity check in the route that flags mismatches without failing.
5. **Pick a definition for `pacing.avg_scene_seconds`.** Scored Partial on References A and C because analyzer interprets it at the narrative-beat level (30-60s) while the field name suggests cut-level (1-10s). Pick one in the prompt and pin it with a concrete example.
6. **Preserve camera-grammar specificity at the pack level.** Reference B's individual scenes correctly noted aerial, time-lapse, GoPro shots, but those got compressed to "occasional locked-off scenic shots" in the pack-level `camera_grammar` field. Add a prompt rule: the pack-level `camera_grammar` should enumerate all distinct grammars observed across that pack's scenes, not summarize to the most common one.

## What this eval does NOT cover

Worth being honest about the scope of what we tested:

- **Only 3 videos, all from English-language US/UK/German channels with high production values.** The analyzer was not tested on lower-quality footage, non-English narration, music videos, livestream recordings, or videos with significant on-screen text. Each of those is a separate fidelity risk.
- **No re-run / stability test.** A single sample per video. Gemini's temperature is 0.3 and outputs may shift on retry. The intermittent `video_id` hallucination across the three references is suggestive evidence that the analyzer's behavior is not fully deterministic on the same input. Consider a "re-analyze twice, diff the outputs" smoke test before any user-facing claim that re-running is free / consistent.
- **No load test.** Daily-cap behavior, concurrent-request behavior, and the `analyzing → done` poll-loop on the result page were not exercised at scale. Out of scope for fidelity Phase 0 but worth a separate Phase before high-volume use.
- **Prior-based goldens, not human-observed.** Covered above; the ship gate is robust to this caveat, the per-field scoring would tighten with a human pass.

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
- 0 or 1 of 3 are "Yes" — do NOT ship. Iterate the Gemini prompt at [src/lib/analyzer/prompt.ts](../src/lib/analyzer/prompt.ts) (the `buildAnalyzerPrompt` builder; the call site is `analyzeYouTubeVideo` in [src/lib/ai.ts](../src/lib/ai.ts)). Common failure modes to fix:
  - Output is too generic ("cinematic, dramatic, professional") — sharpen the prompt with concrete few-shot examples of good `suggested_ai_image_suffix` values.
  - Output hallucinates details not in the video — add an explicit "if you cannot see this in the video, write 'unknown'" instruction.
  - Output describes individual scenes well but `overall_look` is weak — restructure the schema so `overall_look` is generated AFTER all scenes, with the scene list passed back into a final reasoning step.

If two iterations of the prompt still fail the gate, that's the signal to graduate to Option 2 (add AssemblyAI for transcript + audio analysis as a second leg).

## Cost of running this eval

With the locked anchors (~24 + ~4.5 + ~8 min ≈ 36.5 min of input video), one full eval run is roughly **$1.50-$2.00** at Gemini 2.5 Pro current pricing. Re-run as many times as needed while iterating the prompt — cost stays trivial.

## Open

- Operator writes the three golden-answer tables above before running the analyzer on these URLs. Order matters: goldens first (no peek at analyzer output), THEN trigger analyses through [/analyze](../src/app/(app)/analyze/page.tsx), THEN fill in the scorecard.
- Phase 2 of the parent plan has shipped — analyzer infrastructure exists at [src/lib/analyzer/](../src/lib/analyzer/) and [src/app/api/analyze/youtube-video/](../src/app/api/analyze/youtube-video/route.ts). The eval is unblocked the moment the goldens are written.
- If during golden-writing an archetype feels ambiguous on its locked URL, swap it now (don't run the eval on a video where you can't articulate the artistic intent — that pollutes the rubric).
