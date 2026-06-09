# zenn_v1 - Architecture Plan

**Date:** 2026-06-10
**Branch:** claude/video-creation-ui-pqXzS
**Status:** approved 2026-06-10, ready to start PR 1
**Refs analyzed:** `C:/youtubestudio-live/refs/zenn/` (7 videos, 1920x1080 24fps, 7-10 min long-form)
**Analysis artifacts:** `refs/zenn/_analysis/*_grid.jpg`, `refs/zenn/_analysis/hires/*.jpg`, `refs/zenn/_analysis/*_cuts.txt`

---

## 1. Goals (rule 3)

Build `zenn_v1` as a third sibling style alongside `doodle_explainer_2` and `paint_explainer_v1`. The target is the visual contract of the YouTube channel Zenn (https://www.youtube.com/@Zenn0009): voice-over driven long-form explainer videos that mix two distinct visual modes inside the same video.

**Mode A - stick-figure scratch on white canvas.**
Circle-head stick figures with drawn pupils, hand-lettered red emphasis text with red wavy underlines, yellow-highlighter stripe on key words, two-tone grey ground baseline, occasional small wiggle / shake decoration lines. Used for abstract or psychological topics (Spotlight Effect, Infantile Amnesia). Close to but visually distinct from `doodle_explainer_2`: bolder red type, more consistent grey ground, smoother lines (less pen jitter).

**Mode B - flat-fill illustrated scene world.**
Solid-shape characters with flat color fills (grey mice, brown kangaroos, pink ostrich legs), colored staged backgrounds (cyan sky + yellow desert, green grass strip, two-tone grey room interior), clean smooth uniform lines (no scribble crosshatch). Characters and world stay consistent across all shots in a video (the same mice across all of Calhoun, the same curly-haired guy across all of Ancient Humans). Used for concrete topical worlds (Calhoun Effect, Ancient Humans, Aliens, Titanic).

**Success looks like.** A 7-10 min `zenn_v1` render placed next to a real Zenn reference clip is hard to call at a glance. Mode A reads as a Zenn stick-figure topic. Mode B holds a single visually consistent world with reused characters from shot 1 to shot 200.

**Non-goals.**
- Mouth-swap talking character. Zenn has no on-screen narrator; voice-over only. Confirmed with user 2026-06-10.
- Real-photo polaroid punch-in. Zenn uses zero photographic content. Confirmed with user 2026-06-10.
- Frame-by-frame traditional animation. Same constraint as the other two styles.
- Image-to-video models. Out by cost and by user memory note `feedback_near_static_animation_mechanism.md`.

---

## 2. Constraints

- **Per-video cost ceiling: $7.00 as the original target, revised to a $12-15 realistic range after the Kie image-provider decision (section 11).** User instruction 2026-06-10: switch the default image provider for `zenn_v1` from Atlas to Kie AI gpt-image-2, final decision, pricing accepted as-is. The cost section has been updated to reflect the actual Kie per-call price; the per-video cost is materially higher than Atlas but accepted.
- **Vercel tick budget unchanged.** Stage handler must respect `TICK_DEADLINE_BUDGET_MS = 255_000` from `src/lib/auto-pipeline/stages/generate-production-doc-images.ts:142`. Per-tick caps stay at 3 (mirrors paint_explainer_v1 and doodle_explainer_2).
- **Zero regression on `doodle_explainer_2` and `paint_explainer_v1`.** Renderer routes by `stylePreset`. No shared mutable globals. No edits to existing scene components beyond extracting helpers into a new shared file (section 5.4).
- **Image provider: Kie AI gpt-image-2 by default.** Wired via the style preset's `preferred_cloud_model` field: `'gpt-image-2-t2i'` for text-to-image, `'gpt-image-2-i2i'` for sibling-frame edits. The existing dispatcher at `src/lib/auto-pipeline/production-doc-image-gen.ts:401-422` resolves the model from the style preset with row / doc overrides taking precedence. No dispatcher change required. No other external services.
- **Animation mechanism is Kie gpt-image-2 sibling frames from a base.** Hard rule per `feedback_near_static_animation_mechanism.md`. No Remotion motion on a static image, no image-to-video AI. The `canvas_reveal` beat (section 4) emits N sibling frames from a base and cross-fades them in code; the underlying generations are real i2i Edit calls.
- **Model defaults untouched.** No edits to `DEFAULT_FALLBACK_CHAINS`, `defaultModelId`, `SONNET`, `HAIKU`, or any constant in `src/lib/ai-models.ts` per `feedback_model_defaults_user_owned.md`. New LLM prompts use the project's existing default chain.

---

## 3. Alternatives rejected (rule 4)

| Alternative | Why rejected |
|---|---|
| **Extend `doodle_explainer_2` with a `mode: 'stick' \| 'scene'` flag** | The two modes share almost nothing visually except labels. Forcing one style to produce both clean flat-fill scene worlds and scribbly stick-figure-on-white muddies the mixing_rules and prompts. Every future change to doodle_explainer_2 would have to consider Zenn, and vice versa. Coupling without payoff. |
| **`zenn_v1` for Mode B only; Mode A delegates back to `doodle_explainer_2`** | Cross-style coupling. Changing `doodle_explainer_2` silently changes Zenn. Settings panel becomes ambiguous ("which style am I configuring?"). Bug surfaces predictability drops. The duplication cost of owning Mode A inside zenn_v1 is roughly 30% of shared beat helpers, fixable by extracting into one shared helpers file (section 5.4). |
| **Build Mode A first, Mode B as a phase 2** | User confirmed (2026-06-10) wants both modes switchable per video. Mode B is the actual differentiator (the reason "this is not doodle_explainer_2"). Shipping Mode A alone would not deliver a Zenn-quality video. |
| **Generate every shot fresh (no character bank, no world reuse)** | Two consequences. Cost: 200 shots × $0.04 per T2I = $8 already, plus inconsistency. Continuity: Zenn's signature is the same mouse / same human across 200 shots. Generating each shot fresh breaks the visual contract that distinguishes Zenn from generic doodle channels. |
| **Use image-to-video AI for the longer evolving-canvas shots** | Cost and the user memory rule both rule this out. Kling 2.5 turbo at $0.42/clip × 60 long shots = $25 per video. Atlas Edit sibling frames at $0.011/call × 6 frames × 60 shots = $4. Plus the user memory note hard-rules image-to-video for this project. |

---

## 4. Architecture - beat kinds and modes

### 4.1 Mode dispatch
Per-shot field `zenn_mode: 'stick' | 'scene'` on `ProductionRow`. The LLM picks the mode based on the topic of the shot (concrete entity / scene world → `'scene'`; abstract / introspective / chart → `'stick'`). Renderer branches on this field.

### 4.2 Beat kinds (six core, shared between modes except where noted)
1. **`character_pose`** (both modes). Drops a character from the per-doc character bank onto the canvas at a position with a pose key.
2. **`prop_slide`** (both modes). Reuses the paint_explainer_v1 pattern: prop PNG slides into frame from one of N edges.
3. **`canvas_reveal`** (both modes). The evolving-canvas device. Holds a base PNG; over 2-4s, additional sibling PNGs (each generated via Atlas Edit from the base) cross-fade in to add new elements. This is what carries the longer 5-11s Mode A "drawing in" shots without a hard cut.
4. **`label_pop`** (both modes). Red hand-lettered text pops on with optional red wavy underline, timed to a word onset from the alignment JSON. Extends paint_explainer_v1's label-pop math, lives in shared helpers (section 5.4).
5. **`highlighter_stripe`** (both modes). Yellow translucent rectangle slides in under a word at the onset timestamp. Two-stop opacity interpolate so the stripe lays "behind" the text.
6. **`shake_lines`** (both modes). Tiny SVG motion arcs decorate a moving subject (the wobbling ostrich neck in `aliens_80s.jpg`). Mounted at a fixed offset relative to the target.

Mode A also gets:
7. **`canvas_layer_add`** (Mode A only). A simpler sibling to `canvas_reveal`: an SVG path or PNG layer is drawn at full opacity at time T, no fade. Used for the snappy "thing appears" cuts inside an evolving canvas.

### 4.3 What carries each mode
- **Mode A timing**: median 4.3s per shot, with the long tail (p90 = 11.2s) carried by `canvas_reveal` and `canvas_layer_add` so the canvas grows without a cut.
- **Mode B timing**: median 2.8s per shot, hard cuts between scenes. `character_pose` + `prop_slide` + `label_pop` per shot is the dominant pattern.

### 4.4 Asset model
- **Character bank** (per doc, generated once at pipeline stage start):
  - 5-10 unique characters per video
  - Each entry: `base_url` (the canonical PNG), `palette` (extracted flat-fill colors), `poses: { idle, talking, walking, pointing, surprised, ... }` (each pose is an Atlas Edit sibling from the base)
- **World palette** (per doc): `sky_color`, `ground_color`, `wall_color?`, `recurring_props: [{ name, image_url }]`
- **Per-shot assets**: small, almost never one-off. The LLM picks from the character bank and recurring props by id; only genuinely-new objects get a per-shot Atlas T2I call.

---

## 5. Code surface

### 5.1 Style registry
- **New file**: `src/lib/zenn-v1-styles.ts` (or extend `src/lib/production-doc-styles.ts` with a `zenn_v1` entry, matching paint_explainer_v1's pattern).
- Bundled refs from `refs/zenn/_analysis/hires/*` and a few full grids.
- `mixing_rules` documents both modes with at least two concrete JSON examples each (per the doodle_explainer_2 retrofit guidance in `AGENTS.md`).

### 5.2 Schema additions
`src/remotion/utils.ts` (and the page-level mirror in `src/app/(app)/production-doc/page.tsx`):

```ts
// On ProductionRow:
zenn_mode?: 'stick' | 'scene';
zenn_character_id?: string;        // foreign key into zenn_v1_character_bank
zenn_pose?: string;                // 'idle' | 'talking' | 'pointing' | ...
zenn_world_overlay?: 'sky_only' | 'sky_ground' | 'room' | 'underwater' | null;
zenn_canvas_reveal_layers?: Array<{ image_url: string; reveal_at_ms: number; duration_ms: number }>;

// On ProductionDoc:
zenn_v1_character_bank?: Record<string, {
  base_url: string;
  palette: { skin: string; hair: string; clothes: string; accent?: string };
  poses: Record<string, string>;  // pose name -> sibling-frame Edit URL
}>;
zenn_v1_world?: {
  sky_color: string;
  ground_color: string;
  wall_color?: string;
  recurring_props: Array<{ name: string; image_url: string }>;
};
zenn_v1_settings?: {
  default_mode: 'stick' | 'scene';
  label_color: string;        // default '#D32F2F'
  highlighter_color: string;  // default 'rgba(255, 232, 64, 0.65)'
  highlighter_enabled: boolean;
  ground_color_default: string;
};
```

### 5.3 Pipeline stage
**New file**: `src/lib/auto-pipeline/stages/generate-zenn-v1-images.ts`

Mirrors the shape of `generate-production-doc-images.ts` exactly. All image calls route through the existing dispatcher in `src/lib/auto-pipeline/production-doc-image-gen.ts`, which picks the model from the style preset's `preferred_cloud_model`. For `zenn_v1` this resolves to `gpt-image-2-t2i` (Kie) for new images and `gpt-image-2-i2i` (Kie) for sibling-frame edits. R2 mirroring (`mirrorImageToR2()` at `src/lib/image-gen-dispatch.ts:322-345`) is automatic post-generation, so URLs persisted on the doc are R2-backed, not vendor-presigned.

Three sub-passes, each with a `MAX_*_PER_TICK = 3` cap:
1. **Character bank generation** (`MAX_ZENN_CHARACTER_PER_TICK = 3`). One Kie T2I per unique character at 1024×1024, plus N pose siblings via Kie i2i Edit. Cached on `doc.zenn_v1_character_bank[id]`.
2. **World background generation** (`MAX_ZENN_WORLD_PER_TICK = 3`). One Kie T2I per `zenn_world_overlay` value referenced in the doc. Cached on `doc.zenn_v1_world.recurring_props`.
3. **Per-row asset generation** (`MAX_ZENN_ROW_PER_TICK = 3`). For each shot needing a one-off prop or a `canvas_reveal` layer set, Kie T2I or Kie i2i Edit. Caches on the row.

Stage advances itself (`nextStage: 'generating_zenn_v1_images'`) until every row's required assets have a URL, then advances to the next stage. Idempotent re-scan on each tick, same pattern as the existing handler.

Cost tracking writes `cost_usd` deltas per asset into the existing artefact-row mechanism. Honors `PIPELINE_IMAGE_GEN_CAP_USD`. **Note**: the default $10 cap is below the realistic per-video cost under Kie pricing (section 11). The plan recommends bumping the env to `PIPELINE_IMAGE_GEN_CAP_USD=20` for `zenn_v1` jobs before PR 1 runs end-to-end.

### 5.4 Shared helpers (the refactor)
**New file**: `src/lib/shared-doodle-helpers.ts`

Extracted from paint_explainer_v1 and doodle_explainer_2:
- `viseme-from-alignment` math
- `onset-from-alignment` math
- `label-pop` timing and easing
- `micro-wiggle` math
- `fade-resolution` window math
- shake-lines SVG generators

paint_explainer_v1 and doodle_explainer_2 keep their existing per-style files but re-export from `shared-doodle-helpers.ts` to avoid a behavior change. Tests in `tests/` adjusted to point at the new locations. This refactor is the only edit touching the existing two styles and is purely move-and-re-export.

### 5.5 Remotion scene
**New file**: `src/remotion/scenes/ZennScene.tsx`

Branches on `row.zenn_mode`:
- Mode A: white `<AbsoluteFill>` base, grey ground strip, all overlays in `<Sequence>` windows.
- Mode B: per-row world background (`<Img>` covering AbsoluteFill), character + props in stacked `<Sequence>` windows above.

Layer order (back to front): world background → ground strip → static props → character poses → wiggle / shake decorations → canvas_reveal layers → labels + highlighter.

For `canvas_reveal`, each sibling layer mounts in its own `<Sequence from={revealFrame} durationInFrames={remainder}>` with `interpolate(frame, [0, fadeFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })` for opacity. Per Context7 verification 2026-06-10, this is the recommended Remotion pattern for stacked windowed reveals.

### 5.6 Settings panel
**New file**: `src/components/production-doc/ZennV1SettingsPanel.tsx`

Mounted between the style picker and Creative Brief on the production-doc page, conditional on `doc && stylePreset === 'zenn_v1'`. Mirrors the paint_explainer_v1 panel pattern.

Controls (section 9 expands the rationale):
- Default mode toggle (stick / scene)
- Label color picker (default `#D32F2F`)
- Highlighter on/off + color picker
- Ground color picker (Mode A default)
- "Regenerate character bank" button (destructive, confirmed)
- "Regenerate world background" button (destructive, confirmed)

---

## 6. Security (rule 13)

| Surface | Concern | Mitigation |
|---|---|---|
| LLM prompt -> Atlas T2I | Prompt injection from script content (proper nouns crafted to extract data or generate disallowed imagery) | Atlas-side content filters already applied. We sanitize script-extracted entity names before insertion into the T2I prompt: regex strip control chars, max length 80, reject names containing URLs or markdown. |
| Character bank URLs | Atlas returns presigned URLs that we cache on the doc. If the doc leaks, the URLs leak. | URLs are read-only Atlas CDN links, no write access. TTL on Atlas URLs is already short. We do not embed any user PII in the URLs. |
| Cost cap | A malicious script with hundreds of unique character names could blow the cost cap. | `PIPELINE_IMAGE_GEN_CAP_USD` (default $10) hard-stops the run. Plus a new `MAX_ZENN_CHARACTERS_PER_DOC = 12` cap on the unique character count; exceeding it logs an error and re-uses the closest match. |
| Settings panel destructive actions | "Regenerate character bank" wipes existing cache | Confirmation dialog ("This will re-bill ~$2-3 in image gen. Continue?"). The cost figure comes from a live count of cached entries × per-call price. |
| Recovery | A failed character-bank generation could leave a doc in a half-state | Stage handler is idempotent: any row still missing an `image_url` re-triggers the corresponding sub-pass on the next tick. No manual repair script needed. |
| Auth | Production-doc page is already behind the app's session middleware | No new auth surface introduced. |
| Logging | No new PII paths. The script content was already in logs. | Same redaction rules as existing pipeline. |

**Best-practices verification**: I will check OWASP top 10 and current Vercel function security guidance via Context7 before merging the first PR, focused on input sanitization at the LLM-to-Atlas seam.

---

## 7. Observability (rule 14)

Every pipeline step and every component mount emits a namespaced log line on first execution. Patterns mirror the existing `[paint-explainer-v1 *]` namespaces so grep stays uniform.

Pipeline namespaces:
- `[zenn-v1 character-bank]` once per unique character per doc, with `{ characterId, prompt, poses_requested, cost_usd, source: 'generated' | 'cache' | 'deferred' }`
- `[zenn-v1 world-background]` once per unique world overlay, with `{ overlayKey, sky_color, ground_color, cost_usd, source }`
- `[zenn-v1 row-asset]` per row needing a one-off asset, with `{ rowIndex, assetKind: 'prop' | 'canvas_reveal_layer', cost_usd, source }`
- `[zenn-v1 mode-pick]` first row per doc, with `{ rowIndex, picked_mode, llm_reason }` (debugging the LLM's mode choice)
- `[zenn-v1 cost-tick]` end of each tick, with `{ tick_index, this_tick_cost_usd, doc_total_cost_usd, cap_remaining_usd }`

Renderer namespaces (first frame log per beat kind per shot, capped at 5 shots per mount to avoid log spam):
- `[zenn-v1 scene mounted]` per shot with `{ rowIndex, mode, character_id?, world_overlay? }`
- `[zenn-v1 canvas-reveal]` first mount per shot with `{ rowIndex, layer_count, reveal_window_ms }`
- `[zenn-v1 label-pop]` first label-pop per shot with `{ rowIndex, text, onset_source: 'alignment' | 'fallback', onset_ms }`
- `[zenn-v1 highlighter]` first stripe per shot with `{ rowIndex, color, onset_source }`
- `[zenn-v1 character-pose mounted]` per character mount with `{ rowIndex, character_id, pose, position }`

All log payloads contain the actual values, not just "X happened", per rule 14. Booleans always come with the context value that made them true.

**Diagnostic playbook for the user**: when a render looks wrong, the user pastes the bracketed-namespace lines from the browser console (Remotion render) or Vercel function logs (pipeline) and we can identify the failing step without rebuild-guess-rebuild.

---

## 8. Settings (rule 15)

| Setting | Where | Default | Why |
|---|---|---|---|
| Default mode | `zenn_v1_settings.default_mode` | `'scene'` | The differentiator mode. User can flip to `'stick'` for psychology-style topics. |
| Label color | `zenn_v1_settings.label_color` | `'#D32F2F'` (Zenn-matching red) | Brand control. Channels with a different palette can shift it. |
| Highlighter on/off | `zenn_v1_settings.highlighter_enabled` | `true` | Some topics read better without the yellow stripe. |
| Highlighter color | `zenn_v1_settings.highlighter_color` | `'rgba(255, 232, 64, 0.65)'` | Brand control. |
| Ground color (Mode A) | `zenn_v1_settings.ground_color_default` | `'#9E9E9E'` (medium grey) | Zenn uses warm grey; some users may want cool grey or a brand color. |
| Regen character bank | Button | Off until clicked | Re-billing action, hidden behind confirm. |
| Regen world background | Button | Off until clicked | Same. |

**Deliberately NOT exposed as settings**:
- Per-shot mode override at the row level. Reason: the LLM picks per-shot mode and the user can edit the field in the row JSON if they really need to override. A UI setting would add friction without enough benefit.
- Character pose names. Reason: pose vocabulary is part of the style contract; arbitrary user pose names would break the LLM prompt template.
- Per-row palette overrides. Reason: a per-doc world palette is already adjustable; per-row palette would break visual continuity which IS the differentiator.

If `doc.zenn_v1_settings` is missing on an existing doc, the renderer falls back to the defaults. No migration needed.

---

## 9. Testing (rule 18)

| Layer | Tests | Where |
|---|---|---|
| Pure helpers | viseme math, onset math, label-pop math, micro-wiggle math, canvas_reveal window math | `tests/shared-doodle-helpers.test.ts` (new) |
| Style registry | `zenn_v1` entry shape, mixing_rules JSON validity, ref URLs resolve | `tests/zenn-v1-styles.test.ts` (new) |
| Pipeline stage | Sub-pass cap enforcement, idempotency on re-tick, cost-cap enforcement, character-bank cache hits, error classification | `tests/zenn-v1-pipeline.test.ts` (new) |
| Schema | `ProductionRow` and `ProductionDoc` field additions parse, missing-field fallbacks behave | `tests/shorts-base-t2i.test.ts` (extended) |
| Renderer math | Layer order calc, reveal frame windows, fade interpolation values at known frames | `tests/zenn-v1-renderer-math.test.ts` (new) |

Component visual tests are deferred to end-to-end QA renders, matching the paint_explainer_v1 plan's stance.

**Coverage explicitly out of scope**: the `<ZennV1SettingsPanel>` UI (testable manually faster than wiring a React Testing Library setup for a single panel). Flagged here so it does not get silently skipped.

**Bug-fix regression rule**: any bug found in zenn_v1 after this plan ships gets a test in the appropriate suite that fails on the old code and passes on the fix, per rule 18.

---

## 10. UI / UX surface (rule 16)

The user-facing additions are minimal:
1. **Style picker** on the production-doc page gets a new `zenn_v1` option. Same dropdown as today. No new affordance.
2. **`ZennV1SettingsPanel`** appears between the style picker and Creative Brief when `stylePreset === 'zenn_v1'`. Modeled on `PaintExplainerV1SettingsPanel` for visual consistency. Groups: "Mode", "Colors", "Asset cache". Each control labeled in plain language ("Default mode for new shots" not "default_mode").
3. **Cost preview** on the production-doc page already shows an estimate; the existing component reads from artefact costs, so zenn_v1 picks it up for free once the stage logs `cost_usd` correctly.

No new pages, no new routes, no new navigation. The flow is: pick `zenn_v1` from the style picker, adjust the panel if needed, click Generate. A lazy user (rule 10) gets a working scene-world video without touching any new control.

---

## 11. Cost (rule 8)

**Provider decision**: User confirmed 2026-06-10 to use Kie AI gpt-image-2 as the default image provider for `zenn_v1`. Decision is final, pricing accepted, no further questions asked. This section documents the realistic per-video cost under that decision so future-me knows what we are actually paying.

**Live-verified per-call prices** (from codebase 2026-06-10):
- Kie T2I, `gpt-image-2-text-to-image`: **$0.05 per call** (`src/lib/image-models.ts:139`)
- Kie i2i Edit, `gpt-image-2-image-to-image`: **$0.05 per call** (`src/lib/gpt-image-2-edit.ts:140` `KIE_I2I_COST_USD`)
- Cost cap env: `PIPELINE_IMAGE_GEN_CAP_USD`, default **$10 per job** (needs bump to $20 for zenn_v1, see below)

**Per-video estimate** (7-10 min Zenn-pace = ~150-215 shots):

| Asset class | Calls per video | Per-call | Subtotal |
|---|---|---|---|
| Character bank (5-10 chars × 1 base + 6 poses) | 35-70 Edit + 5-10 T2I | $0.05 / $0.05 | $2.00-4.00 |
| World backgrounds (1-3 unique) | 1-3 T2I | $0.05 | $0.05-0.15 |
| Recurring props (10-20 per doc) | 10-20 T2I | $0.05 | $0.50-1.00 |
| One-off per-shot assets (~30% of shots need one) | 45-65 T2I | $0.05 | $2.25-3.25 |
| canvas_reveal sibling frames (~25% of shots need 3-5 layers) | 100-220 Edit | $0.05 | $5.00-11.00 |
| **Total estimated image-gen cost per video** | | | **$9.80-19.40** |

**This is materially higher than the $7 target stated in the goals/constraints sections.** Under Atlas, the same workload was $3.93-7.11. Under Kie it lands at $9.80-19.40, driven primarily by `canvas_reveal` Edit calls (4.5x increase per call vs Atlas Edit).

**Required ops change before PR 1 runs end-to-end**: bump `PIPELINE_IMAGE_GEN_CAP_USD` from $10 to **$20** in the Vercel env for the zenn_v1 path. Without this, every realistic Zenn-pace 7-10 min video will hit the cost cap mid-render and stall.

**Cost-reduction levers available** (not enabled by default, can be toggled if the cost picture proves painful):
1. Cap `canvas_reveal` to at most 3 sibling layers per shot (vs 3-5). Saves ~25% of the largest line item, brings the upper bound to ~$16/video.
2. Restrict `canvas_reveal` to shots over 6s (vs 4s). Reduces the count of shots needing reveal layers by roughly half. Brings the upper bound to ~$14/video.
3. Aggressive character-pose pruning: limit pose count to 4 (idle, talking, walking, pointing) instead of 6. Saves ~$0.50/video. Small but free.
4. Per-row image-cache hashing on prompt + seed: identical prompts inside the same doc dedupe to one generation. Modest savings, mostly hits on recurring props.

LLM cost (existing chain, no model changes per memory rule):
- Script + production-doc generation already costs ~$0.20-0.50 per video on doodle_explainer_2.
- Zenn-pace doubles row count vs doodle_explainer_2, so estimate $0.40-1.00 LLM cost per video. Roughly an extra $0.50 on top of image gen.

**Total per-video cost (Kie): $10-20.** This is the honest number. The decision to use Kie is locked, the cost is accepted, and the plan tracks it openly in observability (`[zenn-v1 cost-tick]`) so we know what a typical render bills.

Pricing also re-checked on Kie AI's pricing page before the first production run, per rule 1.

---

## 12. Phasing

| PR | Scope | Definition of done |
|---|---|---|
| PR 1 | Style registry + schema + Mode A renderer | One scripted test doc with `stylePreset='zenn_v1'`, `zenn_mode='stick'` on every row, renders end-to-end at quality matching `doodle_explainer_2`. |
| PR 2 | Pipeline stage (character bank + world background generation) | A 10-row test doc generates 3 characters, 1 world background, all cached on the doc. Cost logged. Re-tick idempotent. |
| PR 3 | Mode B renderer (`ZennScene` scene-mode branch) | Same 10-row test doc switches to `zenn_mode='scene'`. Character + world + props composited correctly. Layer order matches `aliens_80s.jpg` reference. |
| PR 4 | `canvas_reveal` beat + `canvas_layer_add` beat | A test doc with one 6s `canvas_reveal` shot renders with 4 sibling layers fading in at the right times. Frame-perfect against the alignment JSON. |
| PR 5 | LLM prompt for mode selection + character bank picks | Production-doc generation on a real script produces sensible mode choices and reuses characters across shots. Verified by reviewing the generated `ProductionDoc.rows`. |
| PR 6 | Settings panel + cost preview wiring | UI panel ships. Cost preview shows the estimated $/video before generate. |
| PR 7 | End-to-end QA: three full 7-10 min videos rendered, A/B against Zenn reference clips | A real Zenn clip and the rendered clip placed side by side; reviewer cannot reliably tell at a glance which is which. |

PR 1-3 are the riskiest; PR 4-7 are additive on a working foundation.

---

## 13. Open questions

1. **LLM mode-selection prompt** (user-delegated 2026-06-10, "whatever you think is best"). Decision: LLM picks `zenn_mode` per row. Every pick is logged with the LLM's reason via `[zenn-v1 mode-pick]`. We review the first 10 real videos manually after PR 5. If mode-pick accuracy is low, PR 5.5 adds an explicit mode-spec section in the script schema. No blocker for PR 1.
2. **Character bank prompt template**: open, needs design in PR 2. The bank generation prompt has to produce a character that is recognizable enough to be reused in poses, with a consistent palette and silhouette. Plan: write the prompt with three concrete style examples baked in (Calhoun mouse, Ancient Humans guy, Aliens kangaroo) and test against five script characters before PR 2 ships.
3. **Per-doc character cap** (user-delegated 2026-06-10, "whatever you think is best"). Decision: cap at 12 unique characters/doc. Real Zenn videos use 3-7 so the cap is defensive against runaway cost. If the LLM emits 15, we silently merge near-duplicates by name similarity rather than rejecting the row, because rejection blocks the whole stage. The merge logic is a small helper in the pipeline stage, tested with a unit test that throws fifteen near-duplicate names at it and asserts twelve survive.
4. **Background sound effects, music**: out of scope here; existing pipeline handles audio.
5. **Vendor URL expiration** (RESOLVED 2026-06-10). The existing pipeline mirrors every generated image to R2 via `mirrorImageToR2()` at `src/lib/image-gen-dispatch.ts:322-345` before storing the URL on the doc. R2 presigned TTL is 7 days, and the pipeline returns a fresh signed URL on every read. No extra work needed; `zenn_v1` inherits this automatically by routing all calls through the same dispatcher.

---

## 14. References used

- `refs/zenn/_analysis/*_grid.jpg` (7 videos sampled as 6x4 frame grids)
- `refs/zenn/_analysis/hires/*.jpg` (5 hi-res frames at 1920x1080: calhoun_35s, calhoun_120s, ancient_day_240s, aliens_80s, spotlight_150s)
- `refs/zenn/_analysis/*_cuts.txt` (scene-cut timing distributions, Calhoun + Baby)
- `src/lib/auto-pipeline/stages/generate-production-doc-images.ts` (paint_explainer_v1 pipeline shape, lines 92, 100, 108, 142, 144, 1154-1549)
- `src/lib/prop-generation.ts:117, :32` (Atlas T2I caller and cost constant)
- `src/lib/atlas-mouth-removal.ts:130` (Atlas Edit caller)
- `src/lib/image-edit-pricing.ts:266-278` (pricing catalog)
- `src/app/api/cron/run-pipeline/route.ts` (cron entry, every 1 min)
- `vercel.json:7-13, :109` (route maxDuration + cron schedule)
- `_plans/2026-05-28-paint-explainer-v1-architecture.md` (shape and prior-art for this plan)
- Context7 `/remotion-dev/remotion` query 2026-06-10 (Sequence + interpolate + Premount patterns)
- AGENTS.md (doodle_explainer_2 retrofit policy and project conventions)
- User memory: `feedback_near_static_animation_mechanism.md`, `feedback_model_defaults_user_owned.md`, `feedback_no_llm_council.md`
