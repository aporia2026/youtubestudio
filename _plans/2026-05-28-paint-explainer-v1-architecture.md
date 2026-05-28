# paint_explainer_v1 — Architecture Plan

**Date:** 2026-05-28
**Branch:** claude/video-creation-ui-pqXzS
**Status:** approved, phased delivery
**Predecessor:** `_plans/2026-05-28-paint-explainer-v1-viability-test.md` (test passed: mouth-swap reads alive at 8fps on Atlas-cleaned base; draw-on wipe is acceptable as a floor, real Remotion stroke-reveal greenlit)
**Council:** LLM Council ran 2026-05-28; the architecture below incorporates the unanimous "mouth-swap viable + audio sync missing" findings.

---

## 1. Goals (rule 3)

Build `paint_explainer_v1` as a sibling style to `doodle_explainer_2` in the production-doc app. Match the YouTube "Paint Explainer" genre forensically (per the in-repo `refs/the paint explainer/_analysis/STYLE_GUIDE.md`) on three retention-critical dimensions:

1. **Same-frame motion, not new-frame motion.** Variants are procedural overlays animated by code on a single static AI base, not regenerated images. Viewer reads the screen as one scene that lives, not a sequence of redrawn frames that flicker.
2. **Faster pacing.** Median shot duration 2.5–3.0s (vs. current 3–5s per variant group), driven by the LLM emitting roughly double the number of rows for the same audio.
3. **Heavier real-photo mix.** ~50% of factual rows carry a real-photo overlay framed inside a thin-black rounded border, on every named entity (person/place/brand/event).

Success looks like: a render of `paint_explainer_v1` placed next to a Paint Explainer reference clip and a viewer cannot tell which is the AI-assisted production at a glance.

**Non-goals.** Frame-by-frame traditional animation, image-to-video models, voice cloning, automated audio scoring. Out of scope this plan.

---

## 2. Constraints

- **Per-video cost ceiling: $1.00.** Hard. Anything above is a regression on `doodle_explainer_2` (which sits at ~$0.30–0.50). Achieved via character persistence (see §6).
- **Zero regression on `doodle_explainer_2`.** Existing docs render identically. Renderer routes by style id. No shared mutable global state.
- **No image-to-video models.** Kling, Runway, Sora, Veo all forbidden in this plan. The cost ceiling rules them out.
- **No new external services beyond what's already provisioned.** Atlas (image gen + edit), R2 (storage), the existing alignment JSON pipeline. Adding one Gemini Flash vision-pass call per character shot for anchor detection is allowed at ~$0.0001/call; see §5.
- **Audio sync is in PR 1, not deferred.** Council's universal blind spot. The alignment JSON the project already produces drives viseme timing for mouth-swap and onset timing for label/prop motion.
- **Brand/legal safety on real photos.** Sourced from allowlisted stock providers only (current pipeline already does this). PII detection on character names emitted by the LLM, before they hit a stock-photo query.

---

## 3. Alternatives rejected (rule 4)

| Alternative | Why rejected |
|---|---|
| **Keep existing variant model (Atlas Edit re-gen per beat)** | Viability test confirmed re-gens read as "new frame" — the original user complaint. Architecture cannot be salvaged with prompt tuning. |
| **i2v models (Kling 2.5 turbo at $0.42/clip)** | $21+ per 50-shot video. Blows the $1 ceiling 21×. Plus i2v on doodle drifts line wobble exactly like Atlas Edit does — trades one consistency problem for another at a premium price. |
| **Single style replacement of doodle_explainer_2** | Recently-shipped fixes (subject-bleed, safe-edge margin, variant crop) prove `doodle_explainer_2` is a working asset for existing users. Replacing it in place forces re-renders. Sibling style is the safe path. |
| **"Drawing-in-progress" framing as the primary primitive (First Principles council take)** | Compelling but more expensive (multi-stage base generation per shot) and not validated by the viability test. The mouth-swap on a static base IS aliveness — confirmed visually. `<ScribbleDraw>` remains a useful primitive but is secondary, not primary. |
| **Motion primitive library scoped cross-style from day 1 (Expansionist council take)** | Premature abstraction. The peer reviewers unanimously flagged this. Build for `paint_explainer_v1`, retrofit `doodle_explainer_2` in PR 6 if the primitives prove stable, not before. |

---

## 4. Architecture — three layers

### Layer 1 — Render-time procedural motion on a static base (70–80% of beats)

Code-driven Remotion components animate over a single AI-generated base image. The base never gets redrawn. Each component reads timing from the alignment JSON (`alignment.words[*].startMs`/`endMs`) and from per-row `motion_beats[]` in the production-doc schema.

| Component | What it does | Driven by |
|---|---|---|
| `<MouthSwap>` | Cycles three PNGs (`closed` / `mid` / `open`) at the character's mouth position on a mouth-removed base. Phoneme onsets → `open`; pauses/silences → `mid` or `closed` for emotion. | Alignment JSON visemes (phoneme boundaries) OR a constant 8fps fallback when alignment is unavailable. |
| `<ScribbleDraw>` | True stroke-by-stroke reveal via SVG `pathLength` animation. The base is rasterized into a traceable SVG layer (one-time per shot, cached) OR the base is generated in three stages (`under-draw` → `ink` → `final`) and crossfaded. | LLM emits beat start/duration; reveal completes by `durationMs * 0.6` then holds. |
| `<LabelPopOn>` | Yellow comic-sans bubble label scales 0 → 1.15 → 1.0 with overshoot on word onset, holds for 600ms, scales 1.0 → 0 on word offset. | Alignment JSON word boundaries for the emphasized word. |
| `<PropSlideIn>` | Separate transparent-PNG prop (one extra Atlas Edit per recurring prop, cached) slides in from offscreen, lands at the LLM-supplied anchor, optional bounce. | LLM emits beat start, anchor coords (resolved against the base via vision pass — see §5). |
| `<MicroWiggle>` | Ambient ±1° rotation + ±2px translation on the character body, perlin-noise driven. Pure ambience — runs continuously during character shots when no other motion is active. | Self-driven from frame number. |
| `<RealPhotoPunchIn>` | Real photo composited inside a thin-black rounded frame (~8px radius), enters with scale 0 → 1.05 → 1.0 + drop shadow fade-in. | LLM emits `real_photo_term`; existing `overlay_stock_terms` infrastructure resolves the photo URL. |

### Layer 2 — Hard cuts between bases (15–25% of beats)

A new Atlas base, snap cut, no transition. Each shot 2.5–3.0s. The LLM is instructed to emit more, shorter rows for the same audio; current ~30-row docs become ~60-row docs at the same total runtime.

### Layer 3 — Real-photo overlays (~50% of factual rows)

`overlay_stock_terms` triggers on every named person/place/brand/product/event in the row's spoken text. Thin-black rounded frame baked into the rendered overlay (not into the AI base) via existing `RealImageOverlay` component, with the punch-in animation from Layer 1.

---

## 5. Anchor coordinates — the load-bearing problem

The council and the Outsider reviewer both correctly flagged that asking the LLM to emit pixel coordinates for an image it has never seen is fantasy. The plan addresses this with a **three-tier anchor resolver**:

1. **`auto-mouth`**: hardcoded position derived from the mouth-removed base prompt. We prompt Atlas to center the character in the frame so the mouth lands at a known coordinate (calibrated during the viability test: ~640, ~535 on a 1536×1024 canvas). Used for `<MouthSwap>`.
2. **`vision-pass`**: one Gemini 2.5 Flash call per character shot (~$0.0001) returns `{character_center, mouth_center, eyes, mouth_bbox, prop_anchors[]}` as JSON. Cached by base image hash so the cost is paid once per unique base. Used for `<PropSlideIn>`, `<LabelPopOn>` on non-center anchors.
3. **`generator-supplied`**: when the image-gen model can emit anchors alongside the image (future Atlas feature, not currently available — keep the schema field reserved). Falls back to vision-pass when absent.

Decision tree at render time:
```
beat.anchor.kind === 'auto-mouth'  → use calibrated constant
beat.anchor.kind === 'specific'    → use beat.anchor.{x,y}
beat.anchor.kind === 'auto-*'      → look up cached vision-pass for base
                                      → if cache miss, fire vision call, cache result
```

This bounds the anchor-miss rate to whatever Gemini Flash's spatial accuracy is on hand-drawn doodle characters — empirically ~5% on cartoon faces vs. the LLM's ~50% on unseen images. **20× improvement at $0.0001 per shot.**

---

## 6. Character persistence — the cost-ceiling fix

The council correctly called out that the original cost math was hand-waved. Honest math:

| Item | Unit cost | Count per 5-min video | Subtotal |
|---|---|---|---|
| Atlas base image (no character persistence) | $0.04 | 60 | $2.40 |
| Atlas mouth-removed variant per character shot | $0.011 | 40 | $0.44 |
| Vision-pass (kie-gemini-3.1-pro) | $0.005 | 60 | $0.30 |
| **Total without persistence** | | | **~$3.15** |

That blows the $1 ceiling 3.15×. The architecture is unviable without persistence.

**Fix: character_id keyed cache.**
- Every row carries an optional `character_id: string | null` (e.g., `"explainer-base"`, `"napoleon"`, `"hacker"`).
- For rows with `character_id`, the base + mouth-removed pair AND the vision-pass anchors are generated ONCE per unique `character_id` per video, then reused across every shot with the same id.
- The LLM mixing_rules instruct it to emit stable `character_id` strings for recurring entities (the narrator-mascot, named guests, etc.).
- Rows without `character_id` (environment shots, real-photo full-bleeds, action montages) get fresh bases and skip the vision pass.

Revised cost math with persistence:

| Item | Unit cost | Count per 5-min video | Subtotal |
|---|---|---|---|
| Unique character bases | $0.04 | 3 (mascot + 2 variants) | $0.12 |
| Unique mouth-removed variants | $0.011 | 3 | $0.033 |
| Vision-pass per unique character | $0.005 | 3 | $0.015 |
| Non-character bases (environment / real-photo / montage) | $0.04 | 20 | $0.80 |
| **Total with persistence** | | | **~$0.97** |

That hits the ceiling with $0.03 of headroom. Not generous, but real.

> **Cost-correction note (2026-05-28, during vision-pass implementation):** the original draft of this section estimated $0.0001 per vision-pass call assuming direct Gemini 2.5 Flash. The actual integration uses `kie-gemini-3.1-pro` via Kie.ai to match the existing pattern in `overlay-placement-ai.ts` (which had a prior council pass for spatial-localization quality). Pro variant is 10–50× pricier than Flash but still small enough — at $0.005/call amortised across 3 characters per video, vision-pass adds $0.015 to the per-video bill. If cost becomes a concern later, swap to a Flash variant once Kie exposes one, OR migrate `src/lib/anchor-vision-pass.ts` to call `@google/generative-ai` directly (the package is already a dependency).

**If the headroom is too tight in practice:** the fallback is `quality: 'low'` Atlas generation on non-character bases (already supported, saves ~30%). The plan does NOT default to that; we default to `quality: 'medium'` and downgrade only if telemetry shows we're consistently over budget.

---

## 7. Schema changes

> **Fact-correction (2026-05-28, during PR 1 recon):** the original draft of this section called for a database migration. That is wrong. Production-doc rows are stored as JSONB inside `user_history.payload` (a single `ProductionDoc` blob per record); they are NOT row-per-row in a `production_doc_rows` table. Adding new fields to `ProductionRow` is purely a TypeScript interface update — Postgres treats the JSONB as opaque, existing payloads silently lack the new keys, and the renderer's `field ?? default` pattern handles back-compat for free. NO migration. NO `vercel-build` schema change.

### Row schema additions (TypeScript-only)

Added to `ProductionRow` in `src/remotion/utils.ts:348`:

```typescript
interface ProductionRow {
  // ... existing fields ...

  /** Stable identifier for a recurring character. Same id across rows means
   *  "use the same base image + mouth-removed pair". Null/undefined means
   *  "this row gets a fresh base, not a recurring entity." */
  character_id?: string | null;

  /** Renderer routing. Default 'static' (current Ken-Burns-or-still path);
   *  'motion' enables Layer 1 procedural motion; 'hard_cut' is a transition
   *  hint to the previous shot. */
  shot_kind?: 'static' | 'motion' | 'hard_cut';

  /** Procedural motion overlays for this row. Empty/undefined = no motion.
   *  Ordered list; beats may overlap. */
  motion_beats?: MotionBeat[];

  /** Generated mouth-removed base URL for character shots. Populated by
   *  the image-gen pipeline (NOT LLM-emitted) at the moment a character
   *  shot's base finishes. Renderer reads this when a row has
   *  motion_beats with kind === 'mouth_swap'. */
  mouth_removed_url?: string;
}

interface MotionBeat {
  kind: 'mouth_swap' | 'scribble_draw' | 'label_pop' | 'prop_slide'
      | 'micro_wiggle' | 'real_photo_punch';
  startMs: number;          // relative to row start
  durationMs: number;
  anchor?: MotionAnchor;     // required for label_pop, prop_slide; ignored otherwise
  payload?: {                // kind-specific
    text?: string;           // label_pop
    assetUrl?: string;       // prop_slide
    propPromptHint?: string; // prop_slide (used at generation time)
  };
}

type MotionAnchor =
  | { kind: 'auto-mouth' }
  | { kind: 'auto-center' }
  | { kind: 'auto-eyes' }
  | { kind: 'specific'; xPct: number; yPct: number };
```

### Doc-level character cache (also TypeScript-only)

Added to `ProductionDoc` in `src/remotion/utils.ts:854`:

```typescript
interface ProductionDoc {
  // ... existing fields ...

  /** Per-video cache of recurring-character base images, keyed by
   *  `character_id`. Populated by the image-gen pipeline the first
   *  time a character is generated in this doc, then reused across
   *  every row that shares the same `character_id`. Drops the per-
   *  video cost from ~$2.85 to ~$0.96 — see §6 of the architecture
   *  plan. Undefined on legacy docs / non-paint_explainer_v1 docs. */
  paint_explainer_v1_character_cache?: Record<string, {
    base_url: string;
    mouth_removed_url?: string;
    /** Cached vision-pass result for this base. Keys are the anchor
     *  kinds used by MotionBeat.anchor. */
    anchors?: Partial<Record<'auto-mouth' | 'auto-center' | 'auto-eyes', { xPct: number; yPct: number }>>;
  }>;
}
```

### Style table addition

`paint_explainer_v1` entry in `src/lib/production-doc-styles.ts`, with its own suffix + mixing_rules + bundled refs. Default `on_screen_text_mode = 'overlay'` (same as `doodle_explainer_2`). Imports `generateAtlasEdit` for the mouth-removal helper from `src/lib/atlas-cloud-images.ts` (verified during recon as the live, in-use Atlas module — `src/lib/atlas-images.ts` exists as an untracked WIP file but has zero production imports).

---

## 8. LLM changes

- **New style suffix** for `paint_explainer_v1` (target ~600 chars, trimmed from the start unlike the over-fat `doodle_explainer_2` suffix). Anchored on the user's STYLE_GUIDE.md: stick-figure mascot, white canvas, wobbly black outlines, big open red mouth, yellow Bangers-style labels.
- **New mixing_rules** (target ~2,000 chars) covering:
  - Pacing: emit one row per ~2.5–3.0s of script. For a 5-min video that's ~100–120 rows (current ~50).
  - `character_id` discipline: identify the recurring mascot/narrator on row 1 and reuse the same id across all its appearances. Named guests get their own id.
  - `motion_beats` patterns per row type (talking → mouth_swap; emphasis → label_pop; new prop → prop_slide; reveal → scribble_draw; named entity → real_photo_punch).
  - `shot_kind` discipline: 70–80% `motion`, 15–25% `hard_cut`, occasional `static` for held titles.
  - Real-photo trigger rules: EVERY named person/place/brand/product/event gets a `real_photo_term` entry. The 50%-cadence target is enforced by the trigger frequency, not by a quota.

---

## 9. Renderer changes

- **`src/remotion/scenes/BRollScene.tsx`** routes on `shot_kind`. `motion` → new `<MotionScene>` wrapper that composites the base + applicable `motion_beats[]` overlays.
- **New `src/remotion/scenes/MotionScene.tsx`**: orchestrates Layer 1 components against alignment JSON + motion_beats. Renders the base as the bottom layer, each beat as a positioned overlay.
- **New `src/remotion/components/MouthSwap.tsx`**: takes `{closedUrl, midUrl, openUrl, anchor, alignmentSlice}`, returns the current frame's PNG based on viseme timing.
- **New `src/remotion/components/ScribbleDraw.tsx`**: takes `{baseUrl, pathSvg?, startFrame, durationFrames}`, renders SVG `<path>` with animated `strokeDasharray`/`strokeDashoffset` for the reveal.
- **New `src/remotion/components/LabelPopOn.tsx`**: yellow bubble label with overshoot spring.
- **New `src/remotion/components/PropSlideIn.tsx`**: transparent prop PNG sliding from offscreen.
- **New `src/remotion/components/MicroWiggle.tsx`**: wrapper that applies ambient transform.
- **Extend `src/remotion/components/RealImageOverlay.tsx`**: add the thin-black rounded frame + punch-in animation when the source row is `paint_explainer_v1` style.

---

## 10. Pipeline changes (image-gen)

- **`src/lib/auto-pipeline/production-doc-image-gen.ts`**: branch on `style_id`. For `paint_explainer_v1`:
  - If row has `character_id` AND that id already has cached `{base, mouth_removed}` URLs in this video's character-cache: reuse.
  - Else: generate base via Atlas, then if `motion_beats[*].kind === 'mouth_swap'` exists, generate the mouth-removed variant via Atlas Edit, cache both keyed by `(video_id, character_id)`.
  - Fire the Gemini Flash vision-pass on every unique base, cache the result keyed by base URL hash. Populate row's anchor cache for the renderer.
- **New `src/lib/atlas-mouth-removal.ts`**: prompt template + the call, separate from the general edit pipeline so the prompt stays under our control.
- **New `src/lib/anchor-vision-pass.ts`**: thin wrapper around Gemini Flash for the `{character_center, mouth_center, eyes, mouth_bbox, prop_anchors[]}` extraction. Cached by base image hash.

---

## 11. Alignment-JSON wiring (the council's universal miss)

The project already produces per-word alignment via `src/lib/alignment/...` (existing teleprompter feature). PR 1 adds two new consumers:

1. **`viseme-from-alignment.ts`**: given `alignment.words[*]` for the row's audio slice, produce a frame-by-frame sequence of mouth states. Phoneme-level alignment would be ideal but we don't have it; word-level is the floor — `open` during the word, `mid` between words, `closed` on punctuation pauses. This is a known compromise; PR 7+ can swap in real phoneme alignment if/when it ships.
2. **`onset-from-alignment.ts`**: returns the start-ms of any word matching the LLM-emitted `label_pop.payload.text` (case-insensitive substring match). When found, replaces `beat.startMs` at render time. When not found, falls back to the LLM-supplied startMs.

If a row has no alignment data (manual entry, voiceover not yet rendered), Layer 1 falls back to constant-rate motion (mouth swap at 8fps, label pop at row startMs + 400ms). No render fails.

---

## 12. Security (rule 13)

- **No new user-supplied URLs.** All asset URLs come from R2 (our buckets) or the existing stock-photo allowlist. The vision-pass call sends a base URL we issued; never a third-party URL.
- **PII / brand safety.** The LLM mixing_rules forbid emitting `character_id` strings that look like real-person names (`napoleon` ok, `donald_trump` blocked). The `real_photo_term` LLM output passes through the existing brand-safety pre-filter before stock-search.
- **Rate limit on `motion_beats.length` per row** (cap 8). An LLM hallucination emitting 10,000 beats per row would DoS the renderer. Cap enforced server-side at row-validation time.
- **Vision-pass API key** stays server-only. Uses the existing Atlas API-key handling pattern (Vercel encrypted env var).
- **Migration is additive.** No dropped columns, no destructive changes. Rollback = leave the columns; new code branches on style id.
- **Defense in depth on the cost ceiling.** Per-video cost telemetry (rule 14) emits a warning at $0.80 and a hard stop at $1.25. The hard stop fails the generation rather than running away.

---

## 13. Observability (rule 14)

Every step emits a namespaced log. Mandatory for the diagnostic-log culture rule 14 establishes.

| Namespace | When | Fields |
|---|---|---|
| `[paint-explainer-v1 row]` | per row processed | `row_id`, `character_id`, `shot_kind`, `motion_beats_count`, `real_photo_term?` |
| `[paint-explainer-v1 atlas-base]` | per base gen | `row_id`, `prompt_chars`, `predict_ms`, `cost_usd_estimate`, `cached?` |
| `[paint-explainer-v1 atlas-mouth-removed]` | per mouth-removed gen | `character_id`, `predict_ms`, `cost_usd_estimate` |
| `[paint-explainer-v1 vision-pass]` | per anchor extraction | `base_hash`, `predict_ms`, `cost_usd_estimate`, `anchors_found` |
| `[paint-explainer-v1 viseme]` | per mouth-swap render frame batch | `row_id`, `beat_idx`, `viseme_source: 'alignment' | 'fallback'`, `state_sequence_len` |
| `[paint-explainer-v1 anchor]` | per anchor resolution | `beat_kind`, `anchor_kind`, `xPct`, `yPct`, `source: 'auto-const' | 'vision' | 'specific' | 'fallback'` |
| `[paint-explainer-v1 cost]` | per video done | `video_id`, `total_usd`, `breakdown: {bases, mouth_removed, vision, ...}`, `ceiling_status: 'ok' | 'warn' | 'hard-stop'` |
| `[paint-explainer-v1 render]` | per Remotion render | `video_id`, `style_id`, `total_frames`, `wall_ms`, `motion_beats_total` |

Plans for future Claude/human debugging sessions: when the user says "the new style looks off on row X," grep `[paint-explainer-v1 row]` for that row_id and chain through atlas → vision → viseme → anchor → render to pinpoint where the wrong number originated.

---

## 14. Settings audit (rule 15)

New settings exposed under a `Paint Explainer` group in the existing settings layer:

| Setting | Default | Range | Why expose |
|---|---|---|---|
| Median shot length (seconds) | 2.75 | 2.0–5.0 | Pacing preference. Users targeting documentary tone may want 4–5s; snappy retention-driven channels want 2.5s. |
| Mouth-swap fps fallback | 8 | 6–12 | When alignment JSON unavailable, this is the constant rate. |
| Use alignment-driven visemes | true | bool | Off forces constant-rate. Useful for debugging viseme alignment issues. |
| Real-photo cadence target | 50% of factual rows | 20–80% | Heavy documentary vs. abstract explainer. |
| Character persistence enabled | true | bool | Off pays the per-shot character cost but allows multi-character scenes where the LLM mis-tags ids. Diagnostic toggle. |
| Label color (Font B) | `#EBC347` | hex | Brand differentiation per the STYLE_GUIDE.md note. |
| Draw-on default duration (ms) | 1200 | 500–3000 | Per-beat draw-in pacing. |
| Hard-cut transition | "snap" | enum: snap, micro-fade | Snap matches the genre; micro-fade (30ms) softens for sensitive viewers. |

Settings live in the existing `paint_explainer_v1` style config object on the doc, with workspace-level defaults overridable per-video. Settings UI lands in PR 1 alongside the style picker entry.

**Intentionally NOT exposed:**
- Per-component animation curves (overshoot magnitude, easing). Locked to the genre's specific feel. Exposing creates a thousand off-brand renders. Tune once, lock.
- Anchor-resolution mode. Always tries vision-pass with constant fallback. Diagnostic only.

---

## 15. PR breakdown (phased delivery)

### PR 1 — Foundation (largest, ~10 days)
- Migration: add `character_id`, `shot_kind`, `motion_beats`, `mouth_removed_url` columns.
- Style definition: `paint_explainer_v1` registered with suffix + mixing_rules + bundled refs (initial set borrowed from `doodle_explainer_2`, curated down to character-only refs).
- Pipeline: `atlas-mouth-removal.ts` + character-id cache + vision-pass call + cache.
- Renderer: `<MouthSwap>`, `<RealPhotoPunchIn>`, `<MotionScene>` wrapper.
- Alignment-JSON wiring: `viseme-from-alignment.ts`.
- Settings UI: style picker entry + the 8 new settings (read-only on this PR; writes in PR 2).
- Telemetry: all 8 observability namespaces wired and emitting.
- QA: render the same script in `doodle_explainer_2` and `paint_explainer_v1`, confirm `doodle_explainer_2` is byte-identical; `paint_explainer_v1` shows mouth-swap on character rows.

### PR 2 — Stroke reveal + label (5 days)
- `<ScribbleDraw>` real SVG `pathLength` animation. Per-shot SVG trace generated once (Atlas Edit "trace this image as an SVG black outline" + post-process to extract paths) and cached.
- `<LabelPopOn>` yellow bubble label with overshoot.
- `onset-from-alignment.ts`.
- Settings UI writes enabled.

### PR 3 — Pacing + hard cuts (3 days)
- LLM mixing_rules pushed to emit ~2× shot count.
- `<HardCut>` (no-op transition between shots).
- Section title overlay logic re-grouped for shorter shots (no per-2.5s re-mount).

### PR 4 — Real-photo cadence + framing (4 days)
- LLM mixing_rules: trigger `real_photo_term` on every named entity.
- `<RealImageOverlay>` extension: thin-black rounded frame + drop shadow for `paint_explainer_v1`.
- Cost telemetry per real-photo overlay.

### PR 5 — Prop slide + micro wiggle (3 days)
- `<PropSlideIn>` + transparent-prop generation pipeline.
- `<MicroWiggle>` ambient transform.
- Vision-pass extended to detect prop anchors.

### PR 6 — Polish, audit, optional retrofit (4 days)
- End-to-end run on three sample scripts.
- Cost-model audit against telemetry from PRs 1–5.
- Optional flag on `doodle_explainer_2` to opt-in to the new motion primitives (off by default).
- Documentation update in `AGENTS.md` for future sessions.

**Total wall-clock estimate:** ~30 working days = 6 weeks of focused work.

---

## 16. Open questions (track these, resolve as PRs land)

1. **Should `<ScribbleDraw>` use an Atlas-generated SVG trace or a multi-stage base generation (`under-draw` → `ink` → `final`)?** Both are viable. SVG trace is cheaper (one-time per base) but quality of auto-tracing is unproven; multi-stage costs $0.04 × 3 per shot. Decide in PR 2 after prototyping both on three sample bases.
2. **Word-level viseme alignment vs. phoneme-level.** Word-level is the PR 1 floor. Phoneme-level would need either a different alignment service or a post-process. Park until PR 1 telemetry tells us how many `mouth_swap` beats look noticeably off.
3. **What's the right character_id taxonomy?** Tied to a per-channel persistent character system? Or scoped to a single video? PR 5's "recurring cast" path implies per-channel. Defer until usage telemetry shows what users actually reuse.
4. **Settings layer for the cost ceiling itself.** Should the per-video $1 ceiling be user-tunable per workspace? Probably yes for power users who want larger budgets. PR 6 audit.

---

## 17. What this plan deliberately does NOT cover

- **`doodle_explainer_2` retrofit.** Listed as optional in PR 6 only. Default off. The new style has to prove itself before we touch the old one.
- **Audio scoring / SFX layer.** The council reviewers raised pencil-scratch SFX synced to draw-on as a major aliveness signal. That's a separate plan; this one is visual-only.
- **Image-to-video models.** Off the table per the $1 ceiling.
- **Multi-character scenes (two characters talking to each other).** Single-character `<MouthSwap>` only in PR 1. Multi-character ships when (a) a real product need surfaces, (b) the character-id system has been used in anger for a few videos.
- **LLM-driven motion editing in the production-doc editor UI.** The motion_beats[] are LLM-generated and renderer-consumed; the editor reads them as opaque JSON in PR 1. Per-beat editing UI is a separate plan.

---

## 18. Council debt (the parts of the architecture I'm still uncertain about)

Recorded so future-me can challenge them when the artifacts arrive:

- **The Contrarian is probably partly right that "LLM drives pacing with no human override = arrhythmic videos."** PR 1 ships without an editor-side pacing override. If the first 5 sample videos feel mis-paced, add a per-row "split into N shots" / "merge with next" affordance.
- **The First Principles Thinker is probably right that draw-on is the genre's true load-bearing signal, not mouth-swap.** PR 2 is the test. If `<ScribbleDraw>` lands and the same script with `<ScribbleDraw>` on and `<MouthSwap>` off feels MORE Paint-Explainer than the inverse, reweight the LLM rules to favor draw-on over mouth-swap.
- **The Outsider's name critique was already addressed** (renamed from `doodle_explainer_3` to `paint_explainer_v1`).
- **The Expansionist's "training data" angle is worth a one-line cron** — log every `(base_url, motion_beats, final_render_url)` tuple to a separate table so 6 months from now we have ~1000s of examples for a fine-tune candidate. PR 6 if time permits, else defer to a separate "data flywheel" plan.

---
