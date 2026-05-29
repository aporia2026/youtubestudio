<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Database

Migrations run automatically on every Vercel deploy via the `vercel-build` script in `package.json` (`tsx scripts/migrate.ts up && next build`). A failed migration fails the build, so new code never goes live against an old schema. No manual `npm run db:migrate` is needed before pushing a feature that adds a column or table. Local dev still runs `npm run db:migrate` and `npm run db:status` as needed.

# Paint Explainer V1

Motion-driven production-doc style. Architecture plan at `_plans/2026-05-28-paint-explainer-v1-architecture.md`. Picks up the Paint Explainer YouTube genre's visual contract: hand-drawn doodle on white canvas, mouth-swap talking, snappy 2.5–3.0 s shots, real photos in polaroid frames, yellow comic-bold labels popping on word onsets, hard cuts on topic pivots.

## Where the system lives

- **Style registry**: `src/lib/production-doc-styles.ts` — `paint_explainer_v1` entry with bundled refs + mixing_rules.
- **Schema (TS-only, JSONB-backed)**: `src/remotion/utils.ts` — `ProductionRow` carries `character_id` / `shot_kind` / `motion_beats[]` / `mouth_removed_url`; `ProductionDoc` carries `paint_explainer_v1_character_cache` / `paint_explainer_v1_settings` / `paint_explainer_v1_prop_cache`. The page-level inline `ProductionDoc` in `src/app/(app)/production-doc/page.tsx` mirrors the same fields and MUST stay in sync.
- **Pipeline helpers** (server-only, no React deps):
  - `src/lib/atlas-mouth-removal.ts` — character mouth-removed PNG via Atlas Edit.
  - `src/lib/anchor-vision-pass.ts` — Kie-Gemini vision pass for mouth/eyes/center anchors.
  - `src/lib/prop-generation.ts` — Atlas T2I for `prop_slide` beat PNGs.
- **Pipeline stage handler**: `src/lib/auto-pipeline/stages/generate-production-doc-images.ts` — orchestrates mouth-removed + vision-pass + prop-generation with per-tick caps (`MAX_MOUTH_REMOVED_PER_TICK` = `MAX_VISION_PASS_PER_TICK` = `MAX_PROP_GEN_PER_TICK` = 3) so the Vercel 300 s budget stays intact.
- **Renderer**: `src/remotion/scenes/MotionScene.tsx` mounts per-beat components inside `<Sequence>` windows. `<MouthSwap>`, `<RealPhotoPunchIn>`, `<LabelPopOn>`, `<ScribbleDraw>`, `<MicroWiggle>`, `<PropSlideIn>` are the six Layer-1 components. `<RealImageOverlay>` grows a `variant='paint-explainer-v1-frame'` polaroid branch for static rows.
- **Pure helpers** (testable): `src/lib/viseme-from-alignment.ts`, `src/lib/onset-from-alignment.ts`, `src/remotion/micro-wiggle-math.ts`, `src/remotion/fade-resolution.ts`, and the resolver + bounds in `src/remotion/utils.ts`.
- **Settings UI**: `src/components/production-doc/PaintExplainerV1SettingsPanel.tsx`, mounted on the production-doc page between the style picker and Creative Brief, conditional on `doc && stylePreset === 'paint_explainer_v1'`.

## Log namespaces to grep when debugging

Every pipeline + render step emits a namespaced line. When something looks off, grep these in the Vercel function logs or the browser console:

- `[paint-explainer-v1 atlas-mouth-removed]` — once per unique character per doc (or `cache hit` / `deferred to next tick`).
- `[paint-explainer-v1 anchor-vision-pass]` — once per unique character; logs the extracted `mouth` / `eyes` / `center` percentages.
- `[paint-explainer-v1 prop-generation]` — once per unique `propPromptHint` per doc.
- `[paint-explainer-v1 viseme]` — first beat of each shot (capped at 5 shots); `source: 'alignment' | 'constant-rate'` tells you whether viseme timing came from forced alignment.
- `[paint-explainer-v1 label-pop]` — first beat per shot; `source: 'alignment-onset' | 'fallback'`.
- `[paint-explainer-v1 motion-scene mounted]`, `[paint-explainer-v1 mouth-swap mounted]`, `[paint-explainer-v1 prop-slide]`, `[paint-explainer-v1 scribble-draw]`, `[paint-explainer-v1 micro-wiggle]`, `[paint-explainer-v1 label-pop mounted]`, `[paint-explainer-v1 real-photo-punch mounted]` — per-component first-frame logs.

## doodle_explainer_2 retrofit

Per architecture plan §17 — the retrofit is **deliberately off by default**. The new style has to prove itself in production QA before touching the old one. When the time comes: add a `paint_explainer_v1_motion_optin?: boolean` flag to the doc, gate the mixing_rules' motion-beat emission on it, and the existing renderer routing already handles `shot.shotKind === 'motion'` regardless of style. Do NOT ship this until paint_explainer_v1 has at least three production renders that hold up to scrutiny.

## Adding a new motion-beat kind

1. Add the kind to `MotionBeat['kind']` in `src/remotion/utils.ts` AND `src/remotion/types.ts`'s `VideoShot.motionBeats[]` re-statement.
2. Build the Remotion component under `src/remotion/components/` and add a brief docstring linking back to the architecture plan §4.
3. In `MotionScene.tsx`, add a `useMemo` partition for the new kind and a `.map()` mount loop wrapping each beat in a `<Sequence>` at its window. Pick the right layer-order spot — base layers first, then drawing reveal, then prop / wiggle, then real-photo / label on top.
4. Update `paint_explainer_v1`'s `mixing_rules` to document the new beat with at least one concrete JSON example. LLM compliance jumps with concrete patterns to copy.
5. If the beat needs pipeline support (extra AI calls), follow the pattern in `src/lib/auto-pipeline/stages/generate-production-doc-images.ts` — add a `MAX_*_PER_TICK` cap, track success / skipped / failed counters, write a cache field on the doc.
6. Write a pure-helper test where possible. Component visual tests are deferred to end-to-end QA renders.
